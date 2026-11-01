import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { AUTH, AUTH_RESPONSE, EXEC, MAX_PACKET, RESPONSE, Rcon, RconNoAnswer, RconNotSent, RconSession, RconTimeout, decode, encode } from '../src/rcon.ts';
import { PASSWORD, fakeRcon, type Reply } from './fake-rcon.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(handle?: Parameters<typeof fakeRcon>[0], writeSize?: number) {
  const server = await fakeRcon(handle, writeSize);
  const rcon = await Rcon.connect('127.0.0.1', server.port, PASSWORD, 1000);
  const closed: Error[] = [];
  rcon.on('close', (err) => closed.push(err));
  return { server, rcon, closed };
}

test('authenticates and returns a reply, with non-zero rising ids', async (t) => {
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

test('strips one trailing newline: several rcon.print lines, none, or one ending in its own newline', async (t) => {
  const replies: Record<string, Reply> = { '/lines': ['line1', 'line2', 'line3'], '/none': [], '/blank': ['a\n'] };
  const { server, rcon } = await setup((cmd) => replies[cmd]);
  t.after(() => server.close());
  assert.equal(await rcon.exec('/lines'), 'line1\nline2\nline3');
  assert.equal(await rcon.exec('/none'), '');
  assert.equal(await rcon.exec('/blank'), 'a\n');
  rcon.close();
});

test('never sends a packet with an empty body; an empty command is refused before sending', async (t) => {
  const { server, rcon } = await setup(() => []);
  t.after(() => server.close());
  await assert.rejects(rcon.exec(''), /empty/);
  assert.equal(await rcon.exec('/orrery-status'), '');
  assert.equal(await rcon.exec('/orrery-say {}'), '');
  assert.deepEqual(server.commands(), ['/orrery-status', '/orrery-say {}']);
  assert.ok(server.received.length === 3 && server.received.every((p) => p.body.length > 0)); // the auth and two commands
  rcon.close();
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
  await assert.rejects(
    Rcon.connect('127.0.0.1', (server.address() as AddressInfo).port, PASSWORD, 100),
    (err) => err instanceof RconTimeout && !(err instanceof RconNoAnswer) && /did not answer/.test(err.message),
    'no command was sent: not RconNoAnswer',
  );
});

test('reads a 5 MB reply, one packet over many TCP reads', async (t) => {
  const text = ('é'.repeat(1000) + 'x').repeat(2500); // 5,002,500 bytes
  const { server, rcon } = await setup(() => text);
  t.after(() => server.close());
  assert.equal(await rcon.exec('/big', 5000), text);
  assert.equal(await rcon.exec('/big', 5000), text); // nothing of the first reply leaks into the second
  rcon.close();
});

test('reads a reply cut at every byte, length field and UTF-8 characters included', async (t) => {
  const { server, rcon } = await setup(() => ['é1', 'ü2'], 1);
  t.after(() => server.close());
  assert.equal(await rcon.exec('/cut'), 'é1\nü2');
  assert.equal(await rcon.exec('/cut'), 'é1\nü2');
  rcon.close();
});

test('a reply over the 16 MiB cap is refused: the command rejects and the connection ends', async (t) => {
  const { server, rcon, closed } = await setup((cmd) => (cmd === '/huge' ? 'x'.repeat(MAX_PACKET) : 'ok'));
  t.after(() => server.close());
  assert.equal(await rcon.exec('/small'), 'ok');
  await assert.rejects(rcon.exec('/huge'), /too large: length \d+, over the 16777216 cap/);
  await assert.rejects(rcon.exec('/small'), /closed/);
  assert.equal(closed.length, 1);
  assert.match(closed[0]!.message, /too large/);
});

test('drops packets that are not the command reply: id 0, or its id with another type', async (t) => {
  const { server, rcon } = await setup((cmd, socket) => {
    const id = server.received.at(-1)!.id;
    socket.write(Buffer.concat([encode(0, RESPONSE, 'Player joined the game.\n'), encode(id, AUTH_RESPONSE, 'odd\n')]));
    return cmd.slice(1);
  });
  t.after(() => server.close());
  assert.equal(await rcon.exec('/first'), 'first');
  assert.equal(await rcon.exec('/second'), 'second');
  rcon.close();
});

test('a command that times out ends the connection with a close signal: it was sent (RconNoAnswer), the next was not (RconNotSent)', async (t) => {
  const { server, rcon, closed } = await setup((cmd) => (cmd === '/hang' ? undefined : 'ok'));
  t.after(() => server.close());
  const queued = rcon.exec('/after');
  await assert.rejects(rcon.exec('/hang', 100), (err) => err instanceof RconNoAnswer && /timed out/.test(err.message));
  assert.equal(await queued, 'ok'); // queued before the hang, so it ran first
  await assert.rejects(rcon.exec('/next'), RconNotSent);
  assert.deepEqual(server.commands(), ['/after', '/hang'], 'the next never sent');
  assert.equal(closed.length, 1);
  assert.match(closed[0]!.message, /timed out/);
  await assert.rejects(Rcon.connect('127.0.0.1', 1, PASSWORD, 1000), (err) => !(err instanceof RconTimeout)); // refused: gone, not a stall
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
  await assert.rejects(waiting, (err) => err instanceof RconNotSent && /RCON connection closed/.test(err.message));
  assert.deepEqual(server.commands(), ['/first']);
  await sleep(20);
  assert.equal(closed.length, 1);
});

test('concurrent commands run one at a time, in call order, each given its own reply', async (t) => {
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
  const atCap = Buffer.alloc(4);
  atCap.writeInt32LE(MAX_PACKET);
  assert.deepEqual(decode(atCap), { packets: [], rest: atCap }); // the largest allowed: waited for
  const big = Buffer.alloc(4);
  big.writeInt32LE(MAX_PACKET + 1);
  assert.throws(() => decode(big), /too large/);
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

test('RconSession: one kept connection, commands in order; a timeout or a closed server, then a new connection', async (t) => {
  let hang = false;
  let server = await fakeRcon((cmd) => (hang ? undefined : `ran ${cmd}`));
  const port = server.port;
  const session = new RconSession(port, PASSWORD, 200);
  t.after(async () => {
    session.close();
    await server.close();
  });
  const auths = () => server.received.filter((p) => p.type === AUTH).length;
  assert.deepEqual(await Promise.all(['/a', '/b', '/c'].map((c) => session.exec(c))), ['ran /a', 'ran /b', 'ran /c']);
  assert.deepEqual(server.commands(), ['/a', '/b', '/c']);
  assert.equal(auths(), 1, 'one connection for all three');

  hang = true; // a server that took the command but never answers
  await assert.rejects(session.exec('/d'), RconNoAnswer);
  hang = false;
  assert.equal(await session.exec('/e'), 'ran /e');
  assert.equal(auths(), 2, 'a new connection after the timeout');

  await server.close();
  await assert.rejects(session.exec('/f'), /RCON/);
  server = await fakeRcon((cmd) => `back ${cmd}`, Infinity, port);
  assert.equal(await session.exec('/g'), 'back /g', 'the next command connects again');

  session.close();
  await assert.rejects(session.exec('/h'), /closed/);
});

test('RconSession: a command queued behind one that timed out runs once on a new connection; the sent one is never sent again', async (t) => {
  const server = await fakeRcon((cmd) => (cmd === '/hang' ? undefined : `ran ${cmd}`));
  const session = new RconSession(server.port, PASSWORD, 200);
  t.after(async () => {
    session.close();
    await server.close();
  });
  const auths = () => server.received.filter((p) => p.type === AUTH).length;
  const hung = session.exec('/hang'); // a blocking save: sent, no answer in time
  const queued = [session.exec('/b'), session.exec('/c')];
  await assert.rejects(hung, RconNoAnswer);
  assert.deepEqual(await Promise.all(queued), ['ran /b', 'ran /c']);
  assert.deepEqual(server.commands(), ['/hang', '/b', '/c'], 'in order, the hung one once');
  assert.equal(auths(), 2, 'both on one new connection');
});
