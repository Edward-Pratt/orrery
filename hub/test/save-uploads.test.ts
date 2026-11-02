import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AgentRefused } from '../src/agents.ts';
import { GameRefused } from '../src/factorio.ts';
import { LIMITS } from '../src/protocol.ts';
import { PIECE, SAVES_FLOOR, SaveUploads } from '../src/save-uploads.ts';
import type { Notice } from '../src/types.ts';
import type { Upload } from '../src/uploads.ts';

const ID = 'c'.repeat(32);

async function setup(t: TestContext, o: { size?: number; fileName?: string; version?: string | null; connected?: boolean; busy?: string | null; refuse?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'save-uploads-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = randomBytes(o.size ?? PIECE * 2 + 1234);
  const path = join(dir, 'up');
  await writeFile(path, bytes);
  const upload: Upload = { path, fileName: o.fileName ?? 'My World.zip', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const requests: Record<string, unknown>[] = [];
  const notices: Notice[] = [];
  const audits: string[] = [];
  let taken = false;
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const uploads = new SaveUploads({
    hub: {
      publish: (_id: string, n: Notice) => {
        notices.push(n);
        if (n.kind === 'saveUpload' && (n.state === 'done' || n.state === 'failed')) done();
      },
      audit: (actor: string, action: string, target: string, details = '') => void audits.push(`${actor} ${action} ${target}: ${details}`),
    },
    agents: {
      list: () => [{ id: 'vm', name: 'VM', server: 'space', connected: o.connected ?? true, version: o.version === undefined ? 'agent-v1.3.0' : o.version }],
      get: () => ({ id: 'vm', name: 'VM', server: 'space', connected: o.connected ?? true, version: o.version === undefined ? 'agent-v1.3.0' : o.version }),
      request: (async (_agent: string, call: Record<string, unknown>) => {
        requests.push(call);
        if (o.refuse && call.type === o.refuse) throw new AgentRefused('no room for it');
        if (call.type === 'saveUploadEnd') return { name: 'uploaded-20300101T000000Z-My-World.zip' };
        return undefined;
      }) as never,
    },
    uploads: {
      get: (id: unknown) => (id === ID && !taken ? upload : undefined),
      take: (id: unknown) => (id === ID && !taken ? ((taken = true), upload) : undefined),
    },
    busy: () => o.busy ?? null,
  });
  /** The job's end: its last notice, then its clean-up (the file removed, the server free again). */
  const finished = (async () => {
    await ended;
    for (let i = 0; i < 200 && uploads.busy('space'); i++) await new Promise((r) => setTimeout(r, 5));
  })();
  return { uploads, bytes, path, requests, notices, audits, finished };
}

test('an upload goes to the Agent in order: start, every piece once at its offset, then end; the file is removed', async (t) => {
  const { uploads, bytes, path, requests, notices, audits, finished } = await setup(t);
  assert.deepEqual(uploads.add('space', ID, 'web:alice (1)'), { file: 'My World.zip' });
  assert.equal(uploads.busy('space'), true);
  await finished;
  const [start, ...rest] = requests;
  assert.deepEqual(start, { type: 'saveUploadStart', upload: ID, name: 'My World.zip', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const chunks = rest.filter((r) => r.type === 'saveChunk');
  assert.deepEqual(chunks.map((c) => c.offset), [0, PIECE, 2 * PIECE]);
  assert.ok(chunks.every((c) => (c.data as string).length <= LIMITS.saveChunk), 'each piece fits the wire limit');
  assert.deepEqual(Buffer.concat(chunks.map((c) => Buffer.from(c.data as string, 'base64'))), bytes);
  assert.deepEqual(rest.at(-1), { type: 'saveUploadEnd', upload: ID });
  const states = notices.map((n) => (n.kind === 'saveUpload' ? n.state : n.kind));
  assert.equal(states[0], 'sending');
  assert.deepEqual(states.slice(-2), ['storing', 'done']);
  assert.equal((notices.at(-1) as { name?: string }).name, 'uploaded-20300101T000000Z-My-World.zip');
  assert.equal(existsSync(path), false);
  assert.deepEqual(audits, ['web:alice (1) save upload space: My World.zip (' + bytes.length + ' bytes)', 'web:alice (1) save upload space: My World.zip: stored as uploaded-20300101T000000Z-My-World.zip']);
  assert.equal(uploads.busy('space'), false);
});

test('a refusal from the Agent fails the upload: a failed notice with its reason, a cancel sent, the file removed', async (t) => {
  const { uploads, path, requests, notices, audits, finished } = await setup(t, { refuse: 'saveChunk' });
  uploads.add('space', ID, 'web:alice (1)');
  await finished;
  const last = notices.at(-1) as Extract<Notice, { kind: 'saveUpload' }>;
  assert.equal(last.state, 'failed');
  assert.equal(last.error, 'no room for it');
  assert.deepEqual(requests.at(-1), { type: 'saveUploadCancel', upload: ID });
  assert.equal(existsSync(path), false);
  assert.match(audits.at(-1)!, /failed: no room for it/);
});

test('refusals before anything is sent: unknown server, Agent away or too old, busy, not a zip, no such upload', async (t) => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof GameRefused);
      return `${err.status} ${err.message}`;
    }
    return 'accepted';
  };
  const a = await setup(t);
  assert.match(code(() => a.uploads.add('other', ID, 'x')), /^404/);
  assert.match(code(() => a.uploads.add('space', 'f'.repeat(32), 'x')), /^404 No such finished upload/);
  const away = await setup(t, { connected: false });
  assert.match(code(() => away.uploads.add('space', ID, 'x')), /^409 The server's Agent isn't connected/);
  const old = await setup(t, { version: 'agent-v1.2.0' });
  assert.match(code(() => old.uploads.add('space', ID, 'x')), new RegExp(`^409 .*agent-v1\\.2\\.0.*Deploy ${SAVES_FLOOR.replace(/\./g, '\\.')}`));
  const busy = await setup(t, { busy: 'a game update is running' });
  assert.match(code(() => busy.uploads.add('space', ID, 'x')), /^409 Not now: a game update is running/);
  const txt = await setup(t, { fileName: 'notes.txt' });
  assert.match(code(() => txt.uploads.add('space', ID, 'x')), /^400 A Factorio save is a \.zip/);
  for (const s of [away, old, busy, txt]) assert.deepEqual(s.requests, [], 'nothing sent');
  // One at a time per server.
  const twice = await setup(t);
  twice.uploads.add('space', ID, 'x');
  assert.match(code(() => twice.uploads.add('space', ID, 'x')), /^409 A save is already being uploaded/);
  await twice.finished;
});
