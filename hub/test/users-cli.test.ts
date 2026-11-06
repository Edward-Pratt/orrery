// The break-glass invite (`src/users-cli.ts`) against a hub holding its database open: a new name becomes an owner
// with a link the hub accepts, the same name again gets a reset; both audited as the CLI; its usage and refusals.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AuditLog, Me } from '../src/api.ts';
import { startHub } from '../src/start.ts';
import { cliInvite } from '../src/users-cli.ts';
import { config, cookies, dashboard, WEB } from './web/web-hub.ts';

const PASSWORD = 'a long enough password';

/** A config file for `integrations`, and the hub's own config on the same database. */
function configFile(t: TestContext, integrations: Parameters<typeof config>[1]) {
  const cfg = config(t, integrations);
  const path = join(dirname(cfg.dbPath), 'config.json');
  // The file's web port is a real one (validated); the hub itself listens on any free one.
  const file = { ...cfg, servers: [{ id: 'gtnh', name: 'GTNH' }], integrations: { ...integrations, ...(integrations.web && { web: { ...integrations.web, listenPort: 25581 } }) } };
  writeFileSync(path, JSON.stringify(file));
  return { cfg, path };
}

test('a new name becomes an owner with a link the running hub accepts; the same name again gets a reset', async (t) => {
  const { cfg, path } = configFile(t, { web: WEB });
  const handle = await startHub(cfg, { startFrontend: () => assert.fail('Discord is off'), get: async () => ({ ok: true, status: 200 }) });
  t.after(() => handle.close());
  const app = handle.web!.app;
  const accept = async (link: string) => {
    const token = new URL(link).searchParams.get('invite')!;
    const res = await app.request(`/api/invites/${token}`, { method: 'POST', headers: dashboard(), body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(res.status, 204);
    return (await (await app.request('/api/me', { headers: { cookie: cookies(res) } })).json()) as Me;
  };
  const link = cliInvite(path, 'edward', 'cli:root');
  assert.match(link, /^https:\/\/dash\.orrery\.run\/\?invite=[\w-]{43}$/);
  const me = await accept(link);
  assert.deepEqual([me.username, me.owner], ['edward', true]);
  const again = cliInvite(path, 'Edward', 'cli:root');
  assert.notEqual(again, link);
  const reset = await accept(again);
  assert.equal(reset.id, me.id);
  const login = await app.request('/api/login', { method: 'POST', headers: dashboard(), body: JSON.stringify({ username: 'edward', password: PASSWORD }) });
  const log = (await (await app.request('/api/audit', { headers: { cookie: cookies(login) } })).json()) as AuditLog;
  const byCli = log.entries.filter((e) => e.actor === 'cli:root').map((e) => [e.action, e.target, e.details]);
  assert.deepEqual(byCli.reverse(), [['user invited', 'user:edward', 'Owner'], ['password reset', 'user:edward', 'an invite link was made']]);
});

test('the CLI says how to use it, and refuses without the web integration', (t) => {
  const run = (...args: string[]) => {
    try {
      execFileSync(process.execPath, ['src/users-cli.ts', ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 });
      return assert.fail('it should have failed');
    } catch (err) {
      const { status, stderr } = err as { status: number; stderr: string };
      return [status, stderr.trim()];
    }
  };
  assert.deepEqual(run(), [2, 'Usage: npm run users -- invite <username> [config path]']);
  assert.deepEqual(run('remove', 'edward'), [2, 'Usage: npm run users -- invite <username> [config path]']);
  const { path } = configFile(t, {});
  assert.deepEqual(run('invite', 'edward', path), [1, 'integrations.web is off: there is no dashboard to invite to']);
  const web = configFile(t, { web: WEB });
  assert.deepEqual(run('invite', 'x', web.path), [1, 'A username is 2 to 32 letters, digits, dots, dashes or underscores']);
});
