import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

export const TOKEN = 'test-token-0123456';

export function fakeMod(port: number) {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => {});
  const queue: unknown[] = [];
  const waiters: ((v: unknown) => void)[] = [];
  const lines = createInterface({ input: socket });
  lines.on('error', () => {});
  lines.on('line', (line) => {
    const v: unknown = JSON.parse(line);
    const w = waiters.shift();
    if (w) w(v);
    else queue.push(v);
  });
  return {
    socket,
    closed: new Promise<void>((r) => socket.on('close', () => r())),
    send: (msg: object | string) => socket.write((typeof msg === 'string' ? msg : JSON.stringify(msg)) + '\n'),
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise<unknown>((r) => waiters.push(r))),
  };
}

export const hello = (token = TOKEN, protocol = 1) => ({ type: 'hello', protocol, serverId: 'gtnh', token, modVersion: 'test' });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(10);
  }
}

export async function online(port: number) {
  const mod = fakeMod(port);
  mod.send(hello());
  assert.deepEqual(await mod.next(), { type: 'welcome' });
  return mod;
}
