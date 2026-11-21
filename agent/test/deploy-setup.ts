// The deploy tests' shared setup (`deploy.test.ts`, `deploy-result.test.ts`): a `Deploys` on a temp agent folder with
// a fake systemctl (`setup`), the `node -e` program inside a function of deploy-agent.sh (`scriptNode`), the status
// file as its `finish()` writes it (`scriptStatus`), and the `deploy/` folder.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import { DEPLOY_STATUS, Deploys, type DeployResultMsg, type DeploysOptions } from '../src/deploy.ts';

export const run = promisify(execFile);
export const DEPLOY = new URL('../../deploy/', import.meta.url).pathname;
export const TOKEN = 'agent-token-'.padEnd(40, 'x');
export const SERVER = { id: 'factorio', unit: 'factorio.service', install: '/opt/factorio', data: '/srv/factorio', rconPort: 1, factorioUdpPort: 34198, agentUdpPort: 34199 };

/** The `node -e '…'` program inside a function of deploy-agent.sh, exactly as the script runs it. */
export async function scriptNode(fn: 'connected' | 'finish'): Promise<string> {
  const script = await readFile(join(DEPLOY, 'deploy-agent.sh'), 'utf8');
  const body = new RegExp(`^${fn}\\(\\) \\{[\\s\\S]*?node -e '([^']*)'`, 'm').exec(script)?.[1];
  assert.ok(body, `deploy-agent.sh's ${fn}() has its node -e program`);
  return body;
}

/** `<root>/deploy-status.json` as deploy-agent.sh's finish() writes it: its own node program, then a rename. */
export async function scriptStatus(root: string, s: { tag: string; from: string; outcome: string; excerpt: string }): Promise<void> {
  const env = { ...process.env, TAG: s.tag, FROM: s.from, OUTCOME: s.outcome, EXCERPT: s.excerpt };
  const { stdout } = await run(process.execPath, ['-e', await scriptNode('finish')], { env });
  await writeFile(join(root, '.deploy-status.json.tmp'), stdout);
  await rename(join(root, '.deploy-status.json.tmp'), join(root, DEPLOY_STATUS));
}

/**
 * A Deploys (running agent-v1.2.2) on a temp agent folder, with a fake systemctl: `show` says `active` for the deploy
 * unit, `list-units` prints `units` (and is recorded apart, in `lists`), the rest is recorded.
 */
export async function setup(t: TestContext, options: Partial<DeploysOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orrery-deploy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  const w = {
    root,
    state,
    active: 'inactive',
    connected: true,
    /** Whether a send's write succeeds (false: it failed, as on a connection that just dropped). */
    written: true,
    units: '',
    lists: [] as string[][],
    calls: [] as string[][],
    sent: [] as DeployResultMsg[],
    deploys: null as unknown as Deploys,
    make: () =>
      new Deploys({
        root,
        state,
        version: 'agent-v1.2.2',
        busy: () => null,
        send: async (msg) => w.connected && (w.sent.push(msg), w.written),
        run: async (args) => {
          if (args[0] === 'list-units') return (w.lists.push(args), w.units);
          w.calls.push(args);
          return args[0] === 'show' ? `ActiveState=${w.active}\n` : '';
        },
        pollMs: 10,
        ...options,
      }),
  };
  w.deploys = w.make();
  t.after(() => w.deploys.stop());
  return w;
}
