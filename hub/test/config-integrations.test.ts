// The other integrations' sections (`config-validate.ts`, with `config-check.ts`'s field checks): every integration
// optional, Discord's alerts channel, checks, the host and its defaults, services, and GitHub's repo and deploy
// targets.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, validateConfig } from '../src/config.ts';
import { ID, valid } from './config-fixtures.ts';

test('every integration is optional', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { integrations, ...none } = valid(dir);
  assert.deepEqual(validateConfig(none), []);
  assert.deepEqual(validateConfig({ ...none, integrations: {} }), []);
  assert.deepEqual(validateConfig({ ...none, integrations: { discord: integrations.discord } }), []);
  assert.deepEqual(validateConfig({ ...none, integrations: { minecraft: integrations.minecraft } }), []);
});

test('Discord may name an alerts channel for the host, services and checks', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const c = valid(dir);
  const discord = (alertsChannel: unknown) => ({ ...c, integrations: { discord: { ...c.integrations.discord, alertsChannel } } });
  assert.deepEqual(validateConfig(discord(ID)), []);
  assert.deepEqual(validateConfig(discord('general')), ['integrations.discord: "alertsChannel" must be a Discord ID (17–20 digits)']);
  assert.deepEqual(validateConfig(discord('')), ['integrations.discord: "alertsChannel" must be a non-empty string']);
});

test('checks each need their own id, an http(s) URL and an interval of at least 30 s', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { integrations: _, ...c } = valid(dir);
  const checks = (list: unknown) => validateConfig({ ...c, integrations: { checks: list } });
  const site = { id: 'site', url: 'https://orrery.run', intervalSeconds: 60 };
  assert.deepEqual(checks([site, { ...site, id: 'api', url: 'http://127.0.0.1:8080/health', intervalSeconds: 30 }]), []);
  assert.deepEqual(checks([]), []);
  assert.deepEqual(checks({ site }), ['integrations: "checks" must be a list']);
  assert.deepEqual(
    checks([{ ...site, url: 'ftp://orrery.run' }, { ...site, url: 'not a url', intervalSeconds: 29 }, { ...site, intervalSeconds: 1.5 }, { url: site.url }, 'x']),
    [
      'check "site": "url" must be an http(s) URL',
      'check "site": "url" must be an http(s) URL',
      'check "site": "intervalSeconds" must be a whole number of at least 30',
      'check "site": duplicate id',
      'check "site": "intervalSeconds" must be a whole number of at least 30',
      'check "site": duplicate id',
      'checks[3]: "id" is required',
      'checks[3]: "intervalSeconds" must be a whole number of at least 30',
      'checks[4]: must be an object',
    ],
  );
});

test('the host needs an id; its mounts must exist and its limits be sensible, with defaults', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { integrations: _, ...c } = valid(dir);
  const host = (h: unknown) => validateConfig({ ...c, integrations: { host: h } });
  assert.deepEqual(host({ id: 'oracle' }), []);
  assert.deepEqual(host({ id: 'oracle', mounts: ['/', dir], memoryMaxPercent: 95, memoryMinutes: 10, diskMinFreeGB: 5 }), []);
  assert.deepEqual(host('oracle'), ['integrations: "host" must be an object']);
  assert.deepEqual(host({ mounts: [], memoryMaxPercent: 101, memoryMinutes: 0.5, diskMinFreeGB: -1 }), [
    'integrations.host: "id" is required',
    'integrations.host: "mounts" must be a non-empty list of folders',
    'integrations.host: "memoryMaxPercent" must be a number from 1 to 100',
    'integrations.host: "memoryMinutes" must be a whole number of at least 1',
    'integrations.host: "diskMinFreeGB" must be a positive number',
  ]);
  assert.deepEqual(host({ id: 'oracle', mounts: ['/', join(dir, 'missing'), 3] }), [
    `integrations.host: mount "${join(dir, 'missing')}" is not an existing folder`,
    'integrations.host: "mounts" must be a non-empty list of folders',
  ]);

  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ ...c, integrations: { host: { id: 'oracle' } } }));
  assert.deepEqual(loadConfig(path).integrations.host, { id: 'oracle', mounts: ['/'], memoryMaxPercent: 90, memoryMinutes: 5, diskMinFreeGB: 10 });
});

test('services are listed systemd units with their own ids; a check may link to one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { integrations: _, ...c } = valid(dir);
  const units = [
    { id: 'gtnh', unit: 'gtnh.service' },
    { id: 'caddy', unit: 'caddy.service' },
    { id: 'dump', unit: 'db-dump@nightly.timer' },
  ];
  const site = { id: 'site', url: 'https://orrery.run', intervalSeconds: 60 };
  assert.deepEqual(validateConfig({ ...c, integrations: { systemd: units, checks: [{ ...site, service: 'caddy' }] } }), []);
  assert.deepEqual(validateConfig({ ...c, integrations: { systemd: 'gtnh.service' } }), ['integrations: "systemd" must be a list']);
  assert.deepEqual(
    validateConfig({
      ...c,
      integrations: {
        systemd: [...units, { id: 'gtnh', unit: 'other.service' }, { id: 'again', unit: 'caddy.service' }, { id: 'bad', unit: '--now' }, { id: 'none' }],
        checks: [{ ...site, service: 'nope' }, { ...site, id: 'api', service: 3 }],
      },
    }),
    [
      'service "gtnh": duplicate id',
      'service "again": "caddy.service" is listed already',
      'service "bad": "unit" must be a systemd unit name, like gtnh.service',
      'service "none": "unit" is required',
      'check "site": "service" must be the id of a service in integrations.systemd',
      'check "api": "service" must be the id of a service in integrations.systemd',
    ],
  );
  assert.deepEqual(validateConfig({ ...c, integrations: { checks: [{ ...site, service: 'caddy' }] } }), [
    'check "site": "service" must be the id of a service in integrations.systemd',
  ]);
});

test('GitHub needs a repo; its deploy targets are absolute paths and unit names, defaulted for production', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { integrations: _, ...c } = valid(dir);
  const github = (g: unknown, dbPath = '/srv/orrery-other/hub.db') => validateConfig({ ...c, dbPath, integrations: { github: g } });
  assert.deepEqual(github({ repo: 'Edward-Pratt/orrery' }, '/home/opc/orrery/hub.db'), []); // production's root by default
  const other = {
    root: '/srv/orrery-other',
    hubUnit: 'orrery-hub-other.service',
    hubTemplate: 'orrery-deploy-other',
    webTemplate: 'orrery-deploy-web-other',
    webDir: '/var/www/orrery-other',
  };
  assert.deepEqual(github({ repo: 'Edward-Pratt/orrery', newerAfterDays: 7, deploys: other }), []);
  assert.deepEqual(github({ repo: 'Edward-Pratt/orrery', deploys: { root: '/srv/orrery-other/' } }, '/srv/orrery-other/./hub.db'), []);
  const under = (dbPath: string, root: string) =>
    `integrations.github: "dbPath" must be a file directly in the deploys root ${root} (like ${root}/hub.db), not ${dbPath}: a hub deploy replaces current/`;
  assert.deepEqual(github({ repo: 'Edward-Pratt/orrery', deploys: other }, '/srv/orrery/hub.db'), [under('/srv/orrery/hub.db', '/srv/orrery-other')]);
  // Production's config as it was: hub.db inside the release `current` points at, lost on every hub deploy.
  for (const dbPath of ['/home/opc/orrery/current/hub.db', 'hub.db']) {
    assert.deepEqual(github({ repo: 'Edward-Pratt/orrery' }, dbPath), [under(dbPath, '/home/opc/orrery')], dbPath);
  }
  assert.deepEqual(github('orrery', '/home/opc/orrery/hub.db'), ['integrations: "github" must be an object']);
  assert.deepEqual(github({ repo: 'orrery', newerAfterDays: 0, deploys: [] }, '/home/opc/orrery/hub.db'), [
    'integrations.github: "repo" must be owner/name',
    'integrations.github: "newerAfterDays" must be a positive number',
    'integrations.github: "deploys" must be an object',
  ]);
  assert.deepEqual(github({ repo: 'a/b', deploys: { root: 'orrery', webDir: '../www', hubUnit: '--now', hubTemplate: 'x@y', webTemplate: '-rf' } }), [
    'integrations.github.deploys: "root" must be an absolute path',
    'integrations.github.deploys: "webDir" must be an absolute path',
    'integrations.github.deploys: "hubUnit" must be a systemd unit name, like orrery-hub.service',
    'integrations.github.deploys: "hubTemplate" must be a unit template\'s name, like orrery-deploy',
    'integrations.github.deploys: "webTemplate" must be a unit template\'s name, like orrery-deploy',
  ]);

  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ ...c, dbPath: '/srv/x/hub.db', integrations: { github: { repo: 'a/b', deploys: { root: '/srv/x' } } } }));
  assert.deepEqual(loadConfig(path).integrations.github, {
    repo: 'a/b',
    newerAfterDays: 14,
    deploys: { root: '/srv/x', hubUnit: 'orrery-hub.service', hubTemplate: 'orrery-deploy', webTemplate: 'orrery-deploy-web', webDir: '/var/www/orrery' },
  });
});
