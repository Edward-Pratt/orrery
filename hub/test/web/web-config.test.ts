// `integrations.web.status` in `validateConfig` (`src/web/web-config.ts`): optional; when set, an object whose
// `servers` is a non-empty list of real server ids, each listed once. The rest of `integrations.web`'s rules are
// tested in `test/config.test.ts`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig } from '../../src/config.ts';

const WEB = { listenPort: 25581, publicUrl: 'https://dash.orrery.run' };

/** A valid config with two servers and the web integration, its `status` set to `status` (left out if undefined). */
const withStatus = (status?: unknown) => ({
  dbPath: 'hub.db',
  servers: [
    { id: 'gtnh', name: 'GTNH' },
    { id: 'tfc', name: 'TerraFirmaCraft' },
  ],
  integrations: { web: status === undefined ? WEB : { ...WEB, status } },
});

test('a config without a Status page, or one listing real servers once each, is valid', () => {
  assert.deepEqual(validateConfig(withStatus()), []);
  assert.deepEqual(validateConfig(withStatus({ servers: ['tfc', 'gtnh'] })), []);
  assert.deepEqual(validateConfig(withStatus({ servers: ['gtnh'] })), []);
});

test("the Status page's list must be an object with a non-empty list of real server ids, each once", () => {
  assert.deepEqual(validateConfig(withStatus(['gtnh'])), ['integrations.web: "status" must be an object']);
  for (const servers of [undefined, [], 'gtnh', ['gtnh', 7], ['']]) {
    assert.deepEqual(validateConfig(withStatus({ servers })), ['integrations.web.status: "servers" must be a non-empty list of server ids']);
  }
  assert.deepEqual(validateConfig(withStatus({ servers: ['gtnh', 'nope', 'gtnh'] })), [
    'integrations.web.status: "nope" is not a server id',
    'integrations.web.status: "gtnh" is listed twice',
  ]);
});
