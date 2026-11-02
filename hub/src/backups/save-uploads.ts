// Saves uploaded from the dashboard onto a factorio server's Host: the finished upload (`Uploads`) sent to its Agent in
// pieces over the Agent connection, each answered before the next, then stored there next to the world. Loading it is
// a restore, as for any save.
//
// `SaveUploads` (with agents and uploads), saves uploaded from the dashboard onto a server an Agent runs (`has`; else
// 404): `add(serverId, upload, by)` refuses before anything is sent (`GameRefused`: 404 an unknown server or no such
// finished upload; 400 not a `.zip` (`basename` of its file name, cut to 200) or over 1 GiB (`LIMITS.saveBytes`); 409
// its Agent away or below `SAVES_FLOOR` (`agent-v1.3.0`, with the deploy text), one already sending to that server,
// or `busy` (a pack or game update, a game settings save, a restore, its Agent's deploy)), takes the upload from
// `Uploads` and sends it in the background: `saveUploadStart`, then a `saveChunk` per `PIECE` (512 KiB, base64) at
// its offset, each awaited (60 s) before the next, then `saveUploadEnd` (5 min) for the stored name; `saveUpload`
// notices (stream only) for `sending` (at most once a second), `storing`, then `done` or `failed`, a failure sending
// `saveUploadCancel`; audited (`save upload`: the file and size, then the stored name or why it failed); the hub's
// copy removed at the end whatever happens. `busy(id)`. Hub core.
import { open, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { AgentRefused, beforeAgentRelease, type Agents } from '../agents/agents.ts';
import { GameRefused } from '../updates/factorio.ts';
import { LIMITS } from '../protocol.ts';
import type { ServerHub } from '../servers/servers.ts';
import type { Upload, Uploads } from '../packs/uploads.ts';

/** The first Agent release that takes uploaded saves. */
export const SAVES_FLOOR = 'agent-v1.3.0';
/** Raw bytes per `saveChunk` (its base64 stays under `LIMITS.saveChunk`). */
export const PIECE = 512 * 1024;
/** How long the Agent may take over one piece, and over checking and storing the whole file. */
const PIECE_MS = 60_000;
const END_MS = 5 * 60_000;
/** Progress on the stream at most this often. */
const PROGRESS_MS = 1000;

export type SaveUploadsDeps = {
  hub: Pick<ServerHub, 'publish' | 'audit'>;
  agents: Pick<Agents, 'list' | 'get' | 'request'>;
  uploads: Pick<Uploads, 'get' | 'take'>;
  /** Why nothing may be stored on a server now (a game update, a restore, a deploy), or null. */
  busy: (serverId: string) => string | null;
};

/**
 * `SaveUploads`, for a server an Agent runs (`has`): `add` checks the request and the server, takes the upload and
 * sends it in the background (one per server), reporting `saveUpload` notices on the stream; the file is removed when
 * it is stored, refused or fails.
 */
export class SaveUploads {
  #d: SaveUploadsDeps;
  #agentOf = new Map<string, string>();
  #running = new Set<string>();

  constructor(deps: SaveUploadsDeps) {
    this.#d = deps;
    for (const a of deps.agents.list()) this.#agentOf.set(a.server, a.id);
  }

  has(serverId: string): boolean {
    return this.#agentOf.has(serverId);
  }

  /** Whether an upload is being sent to a server now. */
  busy(serverId: string): boolean {
    return this.#running.has(serverId);
  }

  /**
   * Starts sending upload `uploadId` to `serverId`'s Agent: 404 for an unknown server or upload, 400 for a file that
   * isn't a `.zip` or over 1 GiB, 409 while the server is busy, its Agent away or below `SAVES_FLOOR`. Resolves once
   * started; the rest is on the stream.
   */
  add(serverId: string, uploadId: unknown, by: string): { file: string } {
    const agentId = this.#agentOf.get(serverId);
    if (!agentId) throw new GameRefused(404, 'Only a server an Agent runs takes uploaded saves.');
    const agent = this.#d.agents.get(agentId)!;
    if (!agent.connected) throw new GameRefused(409, "The server's Agent isn't connected.");
    if (agent.version && beforeAgentRelease(agent.version, SAVES_FLOOR)) {
      throw new GameRefused(409, `This server's Agent runs ${agent.version}, which can't take uploaded saves. Deploy ${SAVES_FLOOR} or later from the Host page (Releases).`);
    }
    if (this.#running.has(serverId)) throw new GameRefused(409, 'A save is already being uploaded to this server.');
    const why = this.#d.busy(serverId);
    if (why) throw new GameRefused(409, `Not now: ${why}.`);
    const found = this.#d.uploads.get(uploadId);
    if (!found) throw new GameRefused(404, 'No such finished upload.');
    const file = basename(found.fileName).slice(0, 200);
    if (!/\.zip$/i.test(file)) throw new GameRefused(400, 'A Factorio save is a .zip file.');
    if (found.size > LIMITS.saveBytes) throw new GameRefused(400, 'Saves are at most 1 GiB.');
    const upload = this.#d.uploads.take(uploadId)!;
    this.#running.add(serverId);
    this.#d.hub.audit(by, 'save upload', serverId, `${file} (${upload.size} bytes)`);
    void this.#send(serverId, agentId, uploadId as string, file, upload, by).finally(() => this.#running.delete(serverId));
    return { file };
  }

  async #send(serverId: string, agentId: string, id: string, file: string, upload: Upload, by: string): Promise<void> {
    const note = (n: { state: 'sending' | 'storing' | 'done' | 'failed'; sent: number; name?: string; error?: string }) =>
      this.#d.hub.publish(serverId, { kind: 'saveUpload', severity: n.state === 'failed' ? 'problem' : n.state === 'done' ? 'good' : 'info', file, size: upload.size, ...n });
    const fh = await open(upload.path).catch(() => null);
    try {
      if (!fh) throw new Error("the upload's file is gone");
      await this.#d.agents.request(agentId, { type: 'saveUploadStart', upload: id, name: file, size: upload.size, sha256: upload.sha256 });
      note({ state: 'sending', sent: 0 });
      const buf = Buffer.alloc(PIECE);
      let last = Date.now();
      for (let offset = 0; offset < upload.size; ) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(PIECE, upload.size - offset), offset);
        if (bytesRead === 0) throw new Error("the upload's file is shorter than its size");
        await this.#d.agents.request(agentId, { type: 'saveChunk', upload: id, offset, data: buf.toString('base64', 0, bytesRead) }, { timeoutMs: PIECE_MS });
        offset += bytesRead;
        if (Date.now() - last >= PROGRESS_MS || offset === upload.size) {
          note({ state: 'sending', sent: offset });
          last = Date.now();
        }
      }
      note({ state: 'storing', sent: upload.size });
      const { name } = await this.#d.agents.request(agentId, { type: 'saveUploadEnd', upload: id }, { timeoutMs: END_MS });
      note({ state: 'done', sent: upload.size, name });
      this.#d.hub.audit(by, 'save upload', serverId, `${file}: stored as ${name}`);
    } catch (err) {
      const error = err instanceof AgentRefused ? err.message : `${(err as Error).message}`;
      note({ state: 'failed', sent: 0, error: error.slice(0, LIMITS.detail) });
      this.#d.hub.audit(by, 'save upload', serverId, `${file}: failed: ${error}`.slice(0, LIMITS.detail));
      // The Agent drops what it received; one that is away has nothing open after its restart either.
      await this.#d.agents.request(agentId, { type: 'saveUploadCancel', upload: id }).catch(() => {});
    } finally {
      await fh?.close();
      await unlink(upload.path).catch(() => {});
    }
  }
}
