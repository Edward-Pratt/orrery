import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ServiceWatch, parseShow, showArgs, systemctl, type UnitState } from '../src/service.ts';
import { eventually } from './fake-hub.ts';

const SHOW = 'ActiveState=active\nSubState=running\nStateChangeTimestamp=@1793475924\nResult=success\n';

test('parseShow reads systemctl show, the change time as epoch ms', () => {
  assert.deepEqual(parseShow('factorio.service', SHOW), {
    unit: 'factorio.service',
    active: 'active',
    sub: 'running',
    since: 1_793_475_924_000,
    result: 'success',
  });
  assert.equal(parseShow('x.service', 'ActiveState=inactive\nSubState=dead\nStateChangeTimestamp=\nResult=success\n').since, 0, 'never changed');
  assert.equal(parseShow('x.service', `ActiveState=${'a'.repeat(300)}\n`).active.length, 256, 'cut to the wire limit');
});

test('systemctl runs through execFile with only the agent argv: show, its properties, --, the unit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-systemctl-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, 'systemctl');
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\nprintf '${SHOW.replaceAll('\n', '\\n')}'\n`);
  await chmod(fake, 0o755);
  const out = await systemctl(fake)(showArgs('factorio.service'));
  assert.equal(out, SHOW);
  assert.deepEqual((await readFile(join(dir, 'argv'), 'utf8')).trimEnd().split('\n'), [
    'show',
    '--timestamp=unix',
    '--property=ActiveState,SubState,Result,StateChangeTimestamp',
    '--',
    'factorio.service',
  ]);
});

test('the watch emits the first state and each change, keeps the last state through a failed read', async (t) => {
  const outputs: (string | Error)[] = [SHOW, SHOW, SHOW.replace('running', 'stop-sigterm').replace('active\n', 'deactivating\n'), new Error('Failed to connect to bus')];
  let calls = 0;
  const watch = new ServiceWatch(
    'factorio.service',
    async (args) => {
      assert.deepEqual(args, showArgs('factorio.service'));
      const out = outputs[Math.min(calls++, outputs.length - 1)]!;
      if (out instanceof Error) throw out;
      return out;
    },
    10,
  );
  t.after(() => watch.stop());
  const changes: UnitState[] = [];
  watch.on('change', (s) => changes.push(s));
  t.mock.method(console, 'error', () => {});
  watch.start();
  await eventually(() => calls >= 6);
  assert.deepEqual(
    changes.map((s) => `${s.active}/${s.sub}`),
    ['active/running', 'deactivating/stop-sigterm'],
  );
  assert.equal(watch.state?.active, 'deactivating', 'a failed read keeps the last state');
  assert.equal((console.error as unknown as { mock: { callCount(): number } }).mock.callCount(), 1, 'the failure logged once');
});
