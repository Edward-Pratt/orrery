// An Agent's saves (`savesPush`): the restore route with only an Agent's restore source, Discord `/backup start` as the
// Agent's save, and the watchdog on save age.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuditLog, CommandOutput, ServerDetail } from '../src/api.ts';
import { backupCommand, type BackupInteraction } from '../src/discord/discord.ts';
import { startHub } from '../src/start.ts';
import { until } from './fake-mod.ts';
import { ACTOR } from './web/web-hub.ts';
import {
  unstamped,
  post,
  webAudit,
  GB,
  vmSample,
  agentConfig,
  agentOnline,
  flush,
  eventually,
  agentServicesHub,
  asked,
} from './start-hub.ts';

const SAVE = 'orrery-2026-10-31T06-00-00Z.zip';
const HOUR = 60 * 60_000;
/** An Agent's `saves` push: `SAVE`, made `ageMs` ago, and the current world. */
const savesPush = (ageMs: number) => ({
  type: 'saves',
  saves: [
    { name: 'world.zip', size: 100, mtime: Date.now() - 48 * HOUR, kind: 'world', current: true },
    { name: SAVE, size: 200, mtime: Date.now() - ageMs, kind: 'named', current: false },
  ],
  free: 50 * GB,
});

test("the restore route exists with only an Agent's restore source: a listed save, its unit stopped, through the Agent", async (t) => {
  const { app, cookie, get, agent, agentGot, answer } = await agentServicesHub(t, []);
  const restoreOf = (name: unknown, server = 'space') => post(app, cookie, `/api/servers/${server}/restore`, { name });
  const restoreAudit = async () => webAudit(await get<AuditLog>('/api/audit')).filter((e) => e.action === 'restore');
  const none = await restoreOf(SAVE); // nothing pushed yet: no save is listed
  assert.equal(none.status, 404);
  assert.equal(await none.text(), `No backup ${SAVE}.`);
  agent.send(savesPush(HOUR));
  agent.send({ type: 'serviceState', unit: 'factorio.service', active: 'active', sub: 'running', since: 1, result: 'success' });
  await eventually(async () => (await get<ServerDetail>('/api/servers/space')).service?.state === 'active');
  const detail = await get<ServerDetail>('/api/servers/space');
  assert.deepEqual(detail.backups.configured && detail.backups.backups.map((b) => [b.name, b.kind, b.current]), [
    [SAVE, 'named', false],
    ['world.zip', 'world', true],
  ]);
  const running = await restoreOf(SAVE);
  assert.equal(running.status, 409);
  assert.equal(await running.text(), 'factorio.service is active: stop it first.');
  agent.send({ type: 'serviceState', unit: 'factorio.service', active: 'inactive', sub: 'dead', since: 2, result: 'success' });
  await eventually(async () => (await get<ServerDetail>('/api/servers/space')).service?.state === 'inactive');
  for (const name of ['../world.zip', 'orrery-other.zip', 'latest', '']) assert.equal((await restoreOf(name)).status, 404, name);
  assert.equal((await restoreOf(['world.zip'])).status, 400);

  const pending = restoreOf(SAVE);
  assert.deepEqual(asked(await answer()), { type: 'restore', name: SAVE });
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { output: [`${SAVE} is copied as the newest save: the server loads it on its next start.`] } satisfies CommandOutput);
  const refused = restoreOf('world.zip');
  const req = (await agent.next()) as { id: string };
  agent.send({ type: 'reply', id: req.id, ok: false, error: 'factorio.service is not stopped' });
  const failed = await refused;
  assert.equal(failed.status, 502);
  assert.equal(await failed.text(), 'The restore failed: factorio.service is not stopped');
  // Only the two names that passed every check ever reached the Agent.
  assert.deepEqual(
    agentGot.flatMap((m) => ((m as { type: string }).type === 'restore' ? [(m as { name: string }).name] : [])),
    [SAVE, 'world.zip'],
  );
  assert.deepEqual((await restoreAudit()).reverse(), [
    { actor: ACTOR, action: 'restore', target: 'space', details: `${SAVE}: refused: No backup ${SAVE}.` },
    { actor: ACTOR, action: 'restore', target: 'space', details: `${SAVE}: refused: factorio.service is active: stop it first.` },
    ...['../world.zip', 'orrery-other.zip', 'latest', ''].map((name) => ({ actor: ACTOR, action: 'restore', target: 'space', details: `${name}: refused: No backup ${name}.` })),
    { actor: ACTOR, action: 'restore', target: 'space', details: `${SAVE}: done` },
    { actor: ACTOR, action: 'restore', target: 'space', details: 'world.zip: failed: factorio.service is not stopped' },
  ]);
  const gtnh = await restoreOf(SAVE, 'gtnh'); // a server with neither a folder nor an Agent
  assert.equal(gtnh.status, 409);
});

test("Discord /backup start on a factorio server sends its Agent save, audited; the save's backup event is the finished notice", async (t) => {
  const { hub, stats, agent, game, gameGot, get, app, cookie, live } = await agentServicesHub(t, []);
  const replies: unknown[] = [];
  const interaction = (sub: string) =>
    ({
      options: { getSubcommand: () => sub },
      reply: async (r: unknown) => void replies.push(r),
      deferReply: async () => {},
      editReply: async (r: unknown) => void replies.push(r),
    }) as unknown as BackupInteraction;
  await backupCommand(interaction('start'), hub, stats, 'space', 'discord:alice (7)');
  await eventually(async () => gameGot.length === 1);
  assert.deepEqual(gameGot, [{ type: 'save' }]);
  assert.deepEqual(replies, ['💾 Saving: the notice follows here once the save is written.']);
  const backupAudit = async () => (await get<AuditLog>('/api/audit')).entries.filter((e) => e.action === 'backup').map(({ ts: _, id: __, ...e }) => e);
  assert.deepEqual(await backupAudit(), [{ actor: 'discord:alice (7)', action: 'backup', target: 'space', details: 'save' }]);

  const notices = () => live.since().flatMap(([, e]) => ('serverId' in e && e.type === 'notice' ? [unstamped(e)] : []));
  game.send({ type: 'backup', ok: true, detail: `${SAVE}, 12.0 MB` });
  await until(() => notices().length === 1);
  assert.deepEqual(notices(), [{ serverId: 'space', type: 'notice', severity: 'good', kind: 'backupFinished', detail: `${SAVE}, 12.0 MB` }]);

  // The dashboard's Start backup is the same intent.
  const res = await post(app, cookie, '/api/servers/space/backup');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { output: [] } satisfies CommandOutput);
  await eventually(async () => gameGot.length === 2);
  assert.deepEqual(gameGot[1], { type: 'save' });
  assert.deepEqual((await backupAudit())[0], { actor: ACTOR, action: 'backup', target: 'space', details: 'save' });

  // status and list are the Agent's saves.
  agent.send(savesPush(HOUR));
  await eventually(async () => (await stats.backups('space'))?.configured === true && (await stats.backupSource('space')!.list()).length === 2);
  replies.length = 0;
  await backupCommand(interaction('list'), hub, stats, 'space', 'discord:alice (7)');
  assert.equal((replies[0] as unknown as { embeds: { description: string }[] }).embeds[0]!.description, `\`${SAVE}\` 200 B\n\`world.zip\` 100 B`);
});

test("an Agent's server's watchdog: saves 13 h old are fine while nobody plays, and overdue once someone has", async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cfg = agentConfig(t, {});
  delete cfg.healthcheckUrl;
  cfg.servers.find((s) => s.id === 'space')!.backupMaxAgeHours = 12;
  const handle = await startHub(cfg, { startFrontend: () => assert.fail('Discord is off'), get: () => assert.fail('nothing to request') });
  t.after(() => handle.close());
  const { agent, game } = await agentOnline(await handle.agentPort!);
  const events = () => handle.live.since().map(([, e]) => unstamped(e));
  agent.send(savesPush(13 * HOUR));
  agent.send({ type: 'hostSample', sample: vmSample(1 * GB) }); // after the saves on the same connection: they are in
  await until(() => events().some((e) => 'target' in e && e.type === 'sample'));
  const notices = () => events().filter((e) => 'serverId' in e && e.serverId === 'space' && e.type === 'notice');
  const tick = async (ms: number) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  await tick(10 * 60_000);
  assert.deepEqual(notices(), []); // nobody has played since the newest save: none is due
  game.send({ type: 'heartbeat', tps: 60, players: ['Ann'] });
  await until(() => events().some((e) => 'serverId' in e && e.type === 'tps'));
  await tick(10_000); // the session opens
  await tick(10 * 60_000);
  assert.deepEqual(notices(), [{ serverId: 'space', type: 'notice', severity: 'warning', kind: 'backupOverdue', hours: 13, newest: SAVE }]);
});
