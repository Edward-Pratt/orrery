import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { EXEC, MAX_PACKET, Rcon, decode, encode } from '../src/rcon.ts';
import { PASSWORD, fakeRcon, type Reply } from './fake-rcon.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(handle?: Parameters<typeof fakeRcon>[0]) {
  const server = await fakeRcon(handle);
  const rcon = await Rcon.connect('127.0.0.1', server.port, PASSWORD, 1000);
  const closed: Error[] = [];
  rcon.on('close', (err) => closed.push(err));
  return { server, rcon, closed };
}

test('authenticates and returns a single-packet reply, with non-zero rising ids', async (t) => {
  const { server, rcon, closed } = await setup((cmd) => (cmd === '/version' ? 'Version: 2.1.24' : 'unknown'));
  t.after(() => server.close());
  assert.equal(await rcon.exec('/version'), 'Version: 2.1.24');
  assert.equal(await rcon.exec('/players'), 'unknown');
  assert.deepEqual(server.commands(), ['/version', '/players']);
  const ids = server.received.map((p) => p.id);
  assert.ok(ids.every((id, i) => id > 0 && (i === 0 || id > ids[i - 1]!)), `ids ${ids}`);
  rcon.close();
  assert.deepEqual(closed, []); // close() is not a lost connection
});

test('a refused password rejects connect', async (t) => {
  const server = await fakeRcon();
  t.after(() => server.close());
  await assert.rejects(Rcon.connect('127.0.0.1', server.port, 'wrong', 1000), /password refused/);
});

test('connect gives up when the server never answers', async (t) => {
  const server = createServer((s) => s.on('error', () => {}));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  await assert.rejects(Rcon.connect('127.0.0.1', (server.address() as AddressInfo).port, PASSWORD, 100), /did not answer/);
});

test('joins a reply split over many packets, a UTF-8 character cut between two', async (t) => {
  const text = ('é'.repeat(1000) + 'x').repeat(50); // ~100 KB; 4096-byte cuts land inside the two-byte é
  const bytes = Buffer.from(text, 'utf8');
  const chunks: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += 4096) chunks.push(bytes.subarray(at, at + 4096));
  const { server, rcon } = await setup(() => chunks);
  t.after(() => server.close());
  assert.ok(chunks.length > 20);
  assert.equal(await rcon.exec('/big'), text);
  assert.equal(await rcon.exec('/big'), text); // nothing of the first reply leaks into the second
});

test('a command that times out ends the connection with a close signal', async (t) => {
  const { server, rcon, closed } = await setup((cmd) => (cmd === '/hang' ? undefined : 'ok'));
  t.after(() => server.close());
  const queued = rcon.exec('/after');
  await assert.rejects(rcon.exec('/hang', 100), /timed out/);
  assert.equal(await queued, 'ok'); // queued before the hang, so it ran first
  await assert.rejects(rcon.exec('/next'), /closed/);
  assert.equal(closed.length, 1);
  assert.match(closed[0]!.message, /timed out/);
});

test('the server closing mid-command rejects it and signals close once', async (t) => {
  const { server, rcon, closed } = await setup((_cmd, socket): Reply => {
    socket.destroy();
    return undefined;
  });
  t.after(() => server.close());
  const running = rcon.exec('/first');
  const waiting = rcon.exec('/second');
  await assert.rejects(running, /RCON connection (closed|failed)/);
  await assert.rejects(waiting, /RCON connection closed/);
  assert.deepEqual(server.commands(), ['/first']);
  await sleep(20);
  assert.equal(closed.length, 1);
});

test('concurrent commands run one at a time, in call order', async (t) => {
  const log: string[] = [];
  const { server, rcon } = await setup(async (cmd) => {
    log.push(`got ${cmd}`);
    if (cmd === '/slow') await sleep(100);
    log.push(`answer ${cmd}`);
    return cmd.slice(1);
  });
  t.after(() => server.close());
  assert.deepEqual(await Promise.all([rcon.exec('/slow'), rcon.exec('/fast'), rcon.exec('/third')]), ['slow', 'fast', 'third']);
  assert.deepEqual(log, ['got /slow', 'answer /slow', 'got /fast', 'answer /fast', 'got /third', 'answer /third']);
  rcon.close();
});

for (const [name, size] of [
  ['oversized', 0x7fffffff],
  ['too short', 2],
] as const) {
  test(`a malformed length (${name}) ends the connection`, async (t) => {
    const { server, rcon, closed } = await setup((_cmd, socket): Reply => {
      const len = Buffer.alloc(4);
      len.writeInt32LE(size);
      socket.write(len);
      return undefined;
    });
    t.after(() => server.close());
    await assert.rejects(rcon.exec('/x'), new RegExp(`length ${size}`));
    assert.equal(closed.length, 1);
  });
}

test('decode checks the length cap and the terminator, and keeps a partial packet', () => {
  const packet = encode(7, EXEC, 'hi');
  assert.deepEqual(decode(Buffer.concat([packet, packet.subarray(0, 5)])).rest, packet.subarray(0, 5));
  const [p] = decode(packet).packets;
  assert.deepEqual([p!.id, p!.type, p!.body.toString()], [7, EXEC, 'hi']);
  const big = Buffer.alloc(4);
  big.writeInt32LE(MAX_PACKET + 1);
  assert.throws(() => decode(big), /malformed/);
  const unterminated = Buffer.from(packet);
  unterminated[unterminated.length - 1] = 1;
  assert.throws(() => decode(unterminated), /no terminator/);
});

test('refuses a command with a NUL before sending anything', async (t) => {
  const { server, rcon } = await setup();
  t.after(() => server.close());
  await assert.rejects(rcon.exec('/a\0b'), /NUL/);
  assert.equal(await rcon.exec('/ok'), '');
  assert.deepEqual(server.commands(), ['/ok']);
  rcon.close();
});
