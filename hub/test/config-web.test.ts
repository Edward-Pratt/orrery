// `integrations.web` (`web/web-config.ts`): its port and https public URL, the Discord login's old keys ignored, and
// `loadConfig`'s 7-day sessions with a warning per old key. Its `status` is `test/web/web-config.test.ts`'s.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, validateConfig } from '../src/config.ts';
import { ID, valid } from './config-fixtures.ts';

const WEB = { listenPort: 25581, publicUrl: 'https://dash.orrery.run' };

test('the web integration needs a port and an https public URL; the Discord login\'s keys are no longer checked', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { integrations, ...c } = valid(dir);
  assert.deepEqual(validateConfig({ ...c, integrations: { ...integrations, web: { ...WEB, sessionDays: 30 } } }), []);
  assert.deepEqual(validateConfig({ ...c, integrations: { web: WEB } }), []); // no bot needed
  assert.deepEqual(validateConfig({ ...c, integrations: { web: { ...WEB, clientId: 'abc', guildId: 'abc', adminRoleId: 7 } } }), []);
  assert.deepEqual(validateConfig({ ...c, integrations: { web: { listenPort: 'x', publicUrl: 'http://dash.orrery.run', sessionDays: 0 } } }), [
    'integrations.web: "listenPort" must be a port number (1–65535)',
    'integrations.web: "publicUrl" must be an https URL with no path',
    'integrations.web: "sessionDays" must be a positive number',
  ]);
  const onPath = { ...WEB, publicUrl: 'https://orrery.run/dash' };
  assert.deepEqual(validateConfig({ ...c, integrations: { ...integrations, web: onPath } }), [
    'integrations.web: "publicUrl" must be an https URL with no path',
  ]);
});

test('loadConfig defaults web sessions to 7 days, and warns of each Discord login key left in, dropping it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const c = valid(dir);
  const warn = t.mock.method(console, 'warn', () => {});
  const web = async (w: object) => {
    await writeFile(path, JSON.stringify({ ...c, integrations: { discord: c.integrations.discord, web: w } }));
    return loadConfig(path).integrations.web;
  };
  assert.deepEqual(await web(WEB), { ...WEB, sessionDays: 7 });
  assert.equal(warn.mock.callCount(), 0);
  const status = { servers: ['gtnh'] };
  assert.deepEqual(await web({ ...WEB, clientId: ID, guildId: ID, adminRoleId: ID, sessionDays: 3, status }), { ...WEB, sessionDays: 3, status });
  assert.deepEqual(
    warn.mock.calls.map((call) => call.arguments[0]),
    ['clientId', 'guildId', 'adminRoleId'].map((key) => `integrations.web: "${key}" is no longer used (dashboard logins are local Users): remove it after the Rollback window`),
  );
});
