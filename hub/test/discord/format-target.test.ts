// formatTargetEvent: the host's, services', checks' and deploys' notices, each naming what it is about.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIEmbed } from 'discord.js';
import { COLORS } from '../../src/discord/format.ts';
import { formatTargetEvent } from '../../src/discord/format-target.ts';
import type { TargetEvent } from '../../src/servers/servers.ts';

test('formatTargetEvent names the host and services, and skips samples and states', () => {
  const at = { target: 'host', id: 'oracle', type: 'notice' } as const;
  const GB = 1024 ** 3;
  const titles = [
    { ...at, severity: 'warning', kind: 'memoryHigh', percent: 94, minutes: 5 },
    { ...at, severity: 'good', kind: 'memoryOk', percent: 60 },
    { ...at, severity: 'warning', kind: 'diskLow', mount: '/', free: 5 * GB, minFreeGB: 10 },
    { ...at, severity: 'good', kind: 'diskOk', mount: '/', free: 20 * GB },
  ].map((e) => (formatTargetEvent(e as TargetEvent) as { embeds: APIEmbed[] }).embeds[0]!.title);
  assert.deepEqual(titles, [
    '⚠️ Host oracle: memory at 94% for 5 min',
    '✅ Host oracle: memory back to 60%',
    '⚠️ Host oracle: low disk on /: 5.0 GB free (limit 10 GB)',
    '✅ Host oracle: disk on / back to 20.0 GB free',
  ]);
  const sample = { ts: 1, cpu: 0, load: [0, 0, 0], memory: { used: 1, total: 2 }, disks: [] };
  assert.equal(formatTargetEvent({ target: 'host', id: 'oracle', type: 'sample', sample }), null);
  assert.equal(formatTargetEvent({ target: 'service', id: 'gtnh', type: 'state', state: 'active', sub: 'running' }), null);
  const failed = formatTargetEvent({ target: 'service', id: 'gtnh', type: 'notice', severity: 'problem', kind: 'serviceFailed', unit: 'gtnh.service' });
  assert.deepEqual(failed, { embeds: [{ title: '❌ Service gtnh failed (gtnh.service)', color: COLORS.red }] });
});

test('formatTargetEvent names the check, since the alerts channel is shared', () => {
  const at = { target: 'check', id: 'site', type: 'notice' } as const;
  assert.deepEqual(formatTargetEvent({ ...at, severity: 'problem', kind: 'checkDown', url: 'https://site.example', error: 'HTTP 503' }), {
    embeds: [{ title: '❌ Check site is down: HTTP 503', description: 'https://site.example', color: COLORS.red }],
  });
  assert.deepEqual(formatTargetEvent({ ...at, severity: 'good', kind: 'checkUp', url: 'https://site.example', ms: 120 }), {
    embeds: [{ title: '✅ Check site is back up (120 ms)', description: 'https://site.example', color: COLORS.green }],
  });
});

test('deploy notices reach Discord worded and coloured by outcome', () => {
  const notice = (n: object) => formatTargetEvent({ target: 'deploy', id: 'production', type: 'notice', ...n } as TargetEvent);
  const embed = (n: object) => {
    const post = notice(n) as { embeds: { title: string; color: number }[] };
    return [post.embeds[0]!.title, post.embeds[0]!.color];
  };
  const base = { part: 'hub', from: 'hub-v2.5.0', to: 'hub-v2.6.0' };
  assert.deepEqual(embed({ ...base, severity: 'info', kind: 'deployStarted', by: 'web:alex (1)' }), [
    `🚀 Deploying the hub on production: hub-v2.5.0 → hub-v2.6.0 (by web:alex (1))`,
    0x3498db,
  ]);
  assert.deepEqual(embed({ ...base, severity: 'good', kind: 'deployFinished', outcome: 'ok' }), ['✅ Deployed the hub on production: hub-v2.6.0', 0x2ecc71]);
  assert.deepEqual(embed({ ...base, severity: 'problem', kind: 'deployFinished', outcome: 'failed' }), ['❌ Deploying the hub on production hub-v2.6.0 failed', 0xe74c3c]);
  assert.deepEqual(embed({ ...base, severity: 'problem', kind: 'deployFinished', outcome: 'rolled back' }), [
    '❌ Deploying the hub on production hub-v2.6.0 failed: rolled back to hub-v2.5.0',
    0xe74c3c,
  ]);

  // An Agent's: `from` is what its hello said it runs, so it is escaped.
  const agent = (n: object) => formatTargetEvent({ target: 'deploy', id: 'factorio-vm', type: 'notice', part: 'agent', to: 'agent-v1.2.0', ...n } as TargetEvent) as { embeds: { title: string }[] };
  assert.equal(
    agent({ severity: 'info', kind: 'deployStarted', from: '**[x](https://evil.example)**', by: 'web:alex (1)' }).embeds[0]!.title,
    '🚀 Deploying the agent on factorio-vm: \\*\\*\\[x](https://evil.example)\\*\\* → agent-v1.2.0 (by web:alex (1))',
  );
  assert.equal(
    agent({ severity: 'problem', kind: 'deployFinished', from: '__v__', outcome: 'rolled back' }).embeds[0]!.title,
    '❌ Deploying the agent on factorio-vm agent-v1.2.0 failed: rolled back to \\_\\_v\\_\\_',
  );
  assert.equal(agent({ severity: 'good', kind: 'deployFinished', from: 'agent-v1.1.0', outcome: 'ok' }).embeds[0]!.title, '✅ Deployed the agent on factorio-vm: agent-v1.2.0');
});
