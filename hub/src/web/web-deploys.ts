// `deploysRoutes`, registered by `webApi` with the GitHub integration on: `GET /api/deploys[?before=id]`
// (`Deploys.answer`, 50 history rows a batch), `POST /api/deploys/check` (asks GitHub, answers the same) and `POST
// /api/deploys` (`{ part, tag, server?, host? }`: `server` for a Mod, `host`, the Agent's id, for an Agent; 202 with
// the row id; `DeployRefused`'s 404/409, 400 bad input, 502 if systemctl, the download or the Agent's `deploy`
// fails).

import type { Hono } from 'hono';
import type { DeployAnswer, DeploysAnswer } from '../api.ts';
import { DeployRefused, type Deploys } from '../updates/deploys.ts';
import { actor, jsonBody } from './request.ts';
import type { Env, WebDeps } from './web.ts';

/** Registers the deploys' history, check and deploy on `app`. */
export function deploysRoutes(app: Hono<Env>, { deploys, hub, integrations }: Pick<WebDeps, 'hub' | 'integrations'> & { deploys: Deploys }): void {
  app.get('/deploys', (c) => {
    const before = c.req.query('before');
    if (before !== undefined && !/^[1-9]\d{0,15}$/.test(before)) return c.text('before must be a deploy id', 400);
    return c.json(deploys.answer(before === undefined ? undefined : Number(before)) satisfies DeploysAnswer);
  });
  app.post('/deploys/check', async (c) => {
    hub.audit(actor(c.get('user')), 'deploy check', 'github', integrations.github!.repo);
    await deploys.check();
    return c.json(deploys.answer() satisfies DeploysAnswer);
  });
  app.post('/deploys', async (c) => {
    const { part, tag, server, host } = await jsonBody(c.req);
    if (
      (part !== 'hub' && part !== 'web' && part !== 'mod' && part !== 'agent') ||
      typeof tag !== 'string' ||
      (part === 'mod') !== (typeof server === 'string') ||
      (part === 'agent') !== (typeof host === 'string')
    ) {
      return c.text('Give a part (hub, web, mod or agent), a tag and, for a Mod, its server; for an Agent, its host', 400);
    }
    const user = c.get('user');
    const on = (part === 'mod' ? server : host) as string | undefined;
    try {
      return c.json({ id: await deploys.deploy(part, tag, actor(user), on, user.username) } satisfies DeployAnswer, 202);
    } catch (err) {
      if (err instanceof DeployRefused) return c.text(err.message, err.status);
      return c.text(`The deploy failed: ${(err as Error).message}`, 502);
    }
  });
}
