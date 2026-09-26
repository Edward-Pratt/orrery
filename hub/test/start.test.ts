import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Config } from '../src/config.ts';
import type { HubEvent } from '../src/servers.ts';
import { startHub } from '../src/start.ts';
import { online, TOKEN, until } from './fake-mod.ts';

test('a started hub relays mod chat to the frontend and shuts down cleanly', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-start-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config: Config = {
    dbPath: join(dir, 'hub.db'),
    healthcheckUrl: 'https://example.invalid/ping',
    servers: [
      { id: 'gtnh', name: 'GTNH', backupMinFreeGB: 10, lag: { tps: 15, minutes: 2, enabled: true }, quests: 'batched' },
    ],
    integrations: {
      minecraft: { listenPort: 0, tokens: { gtnh: TOKEN } },
      discord: { guildId: '1'.repeat(18), adminRoleId: '2'.repeat(18), channels: { gtnh: '3'.repeat(18) } },
    },
  };
  const seen: HubEvent[] = [];
  let stopped = false;
  const handle = await startHub(config, {
    startFrontend: async (hub) => {
      hub.on('event', (e) => seen.push(e));
      return { connected: () => true, stop: () => void (stopped = true) };
    },
    get: () => assert.fail('no ping within a test'),
  });

  const mod = await online(handle.port);
  mod.send({ type: 'chat', player: 'Steve', message: 'hi' });
  await until(() => seen.some((e) => e.type === 'chat'));
  assert.deepEqual(
    seen.find((e) => e.type === 'chat'),
    { type: 'chat', serverId: 'gtnh', player: 'Steve', message: 'hi' },
  );

  await handle.close();
  assert.ok(stopped);
  await mod.closed;
  await assert.rejects(
    new Promise((resolve, reject) => connect(handle.port, '127.0.0.1').on('connect', resolve).on('error', reject)),
    /ECONNREFUSED/,
  );
  // The database was closed with the mod's connection already written.
  const db = new DatabaseSync(config.dbPath);
  t.after(() => db.close());
  assert.deepEqual(
    db.prepare("SELECT state, reason FROM events WHERE reason = 'connected'").all().map((r) => ({ ...r })),
    [{ state: 'up', reason: 'connected' }],
  );
});
