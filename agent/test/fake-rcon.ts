import { createServer, type AddressInfo, type Socket } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { AUTH, AUTH_RESPONSE, EXEC, RESPONSE, decode, encode, type Packet } from '../src/rcon.ts';

export const PASSWORD = 'rcon-test-password';

/** What a command printed with `rcon.print`, one line per call. Nothing (undefined): like a hung server, no answer. */
export type Reply = string | string[] | undefined;

/**
 * A fake RCON server shaped like Factorio 2.1's, as checked on a real 2.1.24 server: one auth reply, -1 for a wrong
 * password (else the request's id); each command answered with exactly one packet carrying its id, whatever its
 * size, every printed line ending in `\n` (an empty body if nothing was printed); a packet with an empty body never
 * answered. Commands are answered in the order they came. `writeSize` cuts every reply packet into writes of that
 * many bytes, one per event-loop turn, so the client reads it in pieces (length field included). `port` 0 picks a
 * free one; a given port brings a closed server back where it was.
 */
export async function fakeRcon(
  handle: (command: string, socket: Socket) => Reply | Promise<Reply> = () => [],
  writeSize = Infinity,
  port = 0,
) {
  const received: Packet[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('error', () => {});
    let buf: Buffer = Buffer.alloc(0);
    let chain = Promise.resolve();
    socket.on('data', (chunk: Buffer) => {
      const decoded = decode(Buffer.concat([buf, chunk]));
      buf = decoded.rest;
      for (const p of decoded.packets) {
        received.push(p);
        if (p.body.length === 0) continue; // never answered (verified for an empty type-0 packet)
        if (p.type === AUTH) {
          socket.write(encode(p.body.toString('utf8') === PASSWORD ? p.id : -1, AUTH_RESPONSE, ''));
        } else if (p.type === EXEC) {
          const command = p.body.toString('utf8');
          chain = chain.then(async () => {
            const reply = await handle(command, socket);
            if (reply === undefined) return new Promise<void>(() => {});
            const lines = typeof reply === 'string' ? [reply] : reply;
            const packet = encode(p.id, RESPONSE, lines.map((line) => `${line}\n`).join(''));
            for (let at = 0; at < packet.length && !socket.destroyed; at += writeSize) {
              socket.write(packet.subarray(at, at + writeSize));
              if (at + writeSize < packet.length) await new Promise((r) => setImmediate(r));
            }
          });
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    /** The commands received. */
    commands: () => received.filter((p) => p.type === EXEC).map((p) => p.body.toString('utf8')),
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/**
 * The file `game.server_save(name)` writes, as Factorio 2.1.24 names it (seen in the e2e loop): whatever follows the
 * name's last `.` is replaced by `zip` (`a.b` → `a.zip`, `a.zip` stays), and a name with no `.` gets `.zip`. The test
 * fakes of `/orrery-save` write their save under this name.
 */
export const savedAs = (name: string): string => `${name.replace(/\.[^.]*$/, '')}.zip`;

const ALLOW_WORDS: Record<string, string> = { true: 'Yes', false: 'No', 'admins-only': 'Admins only' };
const minutes = (v: string) => `${v} minute${v === '1' ? '' : 's'}`;

/** What the running server has, for `factorioConfig`'s "already" replies (unset: never already). */
export type RunningConfig = { verification?: boolean; description?: string };

/**
 * Factorio 2.1.24's answers to the built-ins the game settings use, as seen on a real headless server: `/config set
 * <option> [value]` (each option's change line; no value, or spaces alone, clears the description, which is trimmed,
 * and no value removes the password), and `/promote <name>` and `/demote <name>`, which answer nothing and rewrite
 * `adminlist` at once, the name lowercased. With `running`, what the server has: verification set to what it is
 * answers "User verification is already enabled." (or disabled), an empty description cleared again "The server
 * description is already empty.", each kept in `running`. Undefined for any other command.
 */
export function factorioConfig(command: string, adminlist: string, running: RunningConfig = {}): string | undefined {
  const set = /^\/config set ([a-z-]+)(?: (.*))?$/.exec(command);
  if (set) {
    const [, option, v] = set as unknown as [string, string, string | undefined];
    switch (option) {
      case 'name':
        return `Server name changed to: ${v}`;
      case 'description': {
        const d = (v ?? '').trim();
        const already = d === '' && running.description === '';
        if (running.description !== undefined) running.description = d;
        return already ? 'The server description is already empty.' : d === '' ? 'Server description cleared.' : `Server description set to: ${d}`;
      }
      case 'max-players':
        return v === '0' ? 'Player limit removed.' : `Maximum number of players changed to ${v}.`;
      case 'password':
        return v === undefined ? 'Server password removed.' : 'Server password changed.';
      case 'require-user-verification': {
        const on = v === 'true';
        const already = running.verification === on;
        if (running.verification !== undefined) running.verification = on;
        return `User verification ${already ? 'is already' : 'has been'} ${on ? 'enabled' : 'disabled'}.`;
      }
      case 'autosave-interval':
        return v === '0' ? 'Autosave is now disabled.' : `Autosave interval changed to ${minutes(v!)}.`;
      case 'afk-auto-kick':
        return v === '0' ? 'AFK auto kick is now disabled.' : `AFK auto-kick changed to ${minutes(v!)}.`;
      case 'auto-pause-when-players-connect':
        return `Auto pause when players connect set to: ${v}.`;
      case 'only-admins-can-pause':
        return `Only admins can pause set to: ${v}.`;
      case 'allow-commands':
        return `Allow Lua commands set to ${ALLOW_WORDS[v!]}.`;
      default:
        return `Unknown config: ${option}`;
    }
  }
  const admin = /^\/(promote|demote) (\S+)$/.exec(command);
  if (!admin) return undefined;
  let list: string[] = [];
  try {
    list = JSON.parse(readFileSync(adminlist, 'utf8')) as string[];
  } catch {}
  const name = admin[2]!.toLowerCase();
  if (admin[1] === 'promote' && list.includes(name)) return `${name} is already in the admin list and will be promoted upon joining the game.`;
  if (admin[1] === 'demote' && !list.includes(name)) return `${name} is not in the admin list.`;
  list = admin[1] === 'promote' ? [...list, name] : list.filter((n) => n !== name);
  writeFileSync(adminlist, JSON.stringify(list, null, 2) + '\n');
  return '';
}
