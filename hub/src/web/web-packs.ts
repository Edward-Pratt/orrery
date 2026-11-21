// The packs' routes, registered by `webApi` in two places. `newServerRoutes`, with packs, the library and GitHub
// (`newServer` in `/api/integrations`), registered before `/servers/:id`: `POST /api/servers` (202 `{ id }`;
// `PackRefused`'s status), `GET /api/servers/pending` and `DELETE /api/servers/pending/:id`. `packsRoutes`, registered
// before the online check (packs work on a stopped server too): with packs (systemd and Minecraft on), `POST
// /api/uploads` (`{ fileName, size }`), `GET /api/uploads/:upload` and `PUT /api/uploads/:upload?offset=` (a raw chunk;
// `UploadRefused`'s status, 409 as `{ received }`), and for servers `Packs.has` (else 404): `GET
// /api/servers/:id/pack`, `POST …/compare`, `…/adopt`, `…/update` (202), `…/update/cancel`, `…/extras` (then
// `PUT`/`DELETE …/extras/:id`), `…/edits` (then `PUT`/`DELETE …/edits/:id`), `…/edits/preview` (`PackRefused`'s or
// `LibraryRefused`'s status); with the library (as uploads), `GET /api/library`, `POST /api/library/packs` (`{ upload
// | url, name, version, mc?, loader? }`: 202 with the add's number), `POST /api/library/cancel`, `DELETE
// /api/library/packs/:id` (`LibraryRefused`'s status; 409 while used), `POST /api/library/runtimes` (`{ feature }`:
// 202) and `DELETE /api/library/runtimes/:name`, and for a pack's server `PUT /api/servers/:id/pack/runtime` (`{
// runtime: name | null }`), `GET /api/library/packs/:id/scripts`, and `library` in `/api/integrations`.

import type { Context, Hono } from 'hono';
import type {
  CompareReport,
  EditPreview,
  LibraryAddAnswer,
  LibraryState,
  Me,
  NewServerAnswer,
  PackState,
  PackUpdateAnswer,
  PendingServers,
  StartScripts,
  UploadAnswer,
  UploadProgress,
} from '../api.ts';
import { LibraryRefused } from '../packs/library.ts';
import { PackRefused, startScripts } from '../packs/packs.ts';
import { UploadRefused } from '../packs/uploads.ts';
import { actor, jsonBody } from './request.ts';
import type { Env, WebDeps } from './web.ts';

/** Runs a library or New server action as the user, mapping its refusals to their status. */
const act = async (c: Context<Env>, fn: (by: string, user: Me) => Promise<object | void>, status: 200 | 202 = 200) => {
  try {
    const answer = await fn(actor(c.get('user')), c.get('user'));
    return answer === undefined ? c.body(null, 204) : c.json(answer, status);
  } catch (err) {
    if (err instanceof PackRefused || err instanceof LibraryRefused) return c.text(err.message, err.status);
    throw err;
  }
};

/** Registers New server's install and its pending servers on `app`; before `/servers/:id`. */
export function newServerRoutes(app: Hono<Env>, { packs }: Pick<WebDeps, 'packs'>): void {
  // Before `/servers/:id`: "pending" isn't a server id.
  app.post('/servers', (c) => act(c, async (by, user) => ({ id: await packs!.install(await jsonBody(c.req), by, user.username) }) satisfies NewServerAnswer, 202));
  app.get('/servers/pending', (c) => c.json(packs!.pending() satisfies PendingServers));
  app.delete('/servers/pending/:id', (c) => act(c, (by) => packs!.discard(c.req.param('id'), by)));
}

/** Registers the uploads', the library's and the packs' routes on `app`, each block only with its module on. */
export function packsRoutes(app: Hono<Env>, { uploads, library, packs }: Pick<WebDeps, 'uploads' | 'library' | 'packs'>): void {
  if (uploads) {
    /** Runs an upload action, mapping its refusals to their status (a 409 with how much arrived). */
    const upload = async (c: Context<Env>, fn: (id: string) => Promise<object>) => {
      try {
        return c.json(await fn(c.req.param('upload')!));
      } catch (err) {
        if (!(err instanceof UploadRefused)) throw err;
        return err.status === 409 ? c.json({ received: err.received! } satisfies UploadProgress, 409) : c.text(err.message, err.status);
      }
    };
    app.post('/uploads', async (c) => {
      const body = await jsonBody(c.req);
      return upload(c, async () => ({ upload: await uploads.create(body.fileName, body.size) }) satisfies UploadAnswer);
    });
    app.get('/uploads/:upload', (c) => upload(c, async (id) => ({ received: uploads.received(id) }) satisfies UploadProgress));
    app.put('/uploads/:upload', async (c) => {
      const offset = c.req.query('offset') ?? '';
      if (!/^(0|[1-9]\d{0,15})$/.test(offset)) return c.text('Give the offset in bytes', 400);
      return upload(c, async (id) => ({ received: await uploads.append(id, Number(offset), c.req.raw.body) }) satisfies UploadProgress);
    });
  }
  if (library) {
    app.get('/library', (c) => c.json(library.state() satisfies LibraryState));
    app.post('/library/packs', (c) =>
      act(c, async (by, user) => ({ add: library.addPack(await jsonBody(c.req), by, user.username) }) satisfies LibraryAddAnswer, 202),
    );
    app.post('/library/cancel', (c) => act(c, async (by) => library.cancel(by)));
    app.delete('/library/packs/:id', (c) =>
      act(c, async (by) => {
        const id = c.req.param('id');
        if (!/^[1-9]\d{0,15}$/.test(id)) throw new LibraryRefused(404, 'No such pack in the library.');
        await library.deletePack(Number(id), by);
      }),
    );
    app.post('/library/runtimes', (c) =>
      act(c, async (by, user) => ({ add: library.addRuntime(await jsonBody(c.req), by, user.username) }) satisfies LibraryAddAnswer, 202),
    );
    app.delete('/library/runtimes/:name', (c) => act(c, (by) => library.deleteRuntime(c.req.param('name'), by)));
    app.get('/library/packs/:id/scripts', (c) =>
      act(c, async () => {
        const id = c.req.param('id');
        if (!/^[1-9]\d{0,15}$/.test(id)) throw new LibraryRefused(404, 'No such pack in the library.');
        try {
          return { scripts: await startScripts(library.zip(Number(id))) } satisfies StartScripts;
        } catch (err) {
          throw err instanceof PackRefused ? new LibraryRefused(err.status, err.message) : err;
        }
      }),
    );
  }
  if (packs) {
    /** Runs a pack action for a server that has packs, mapping its refusals to their status. */
    const pack = async (c: Context<Env>, fn: (id: string, user: Me) => Promise<unknown>, status: 200 | 202 = 200) => {
      const id = c.req.param('id')!;
      if (!packs.has(id)) return c.notFound();
      try {
        const answer = await fn(id, c.get('user'));
        return answer === undefined ? c.body(null, 204) : c.json(answer as object, status);
      } catch (err) {
        if (err instanceof PackRefused || err instanceof LibraryRefused) return c.text(err.message, err.status);
        throw err;
      }
    };
    const id = (c: Context<Env>, key: string) => Number(/^[1-9]\d{0,15}$/.test(c.req.param(key) ?? '') ? c.req.param(key) : NaN);
    app.get('/servers/:id/pack', (c) => pack(c, async (sid) => (await packs.state(sid)) satisfies PackState));
    app.post('/servers/:id/pack/compare', (c) =>
      pack(c, async (sid, user) => (await packs.compare(sid, await jsonBody(c.req), actor(user))) satisfies CompareReport),
    );
    app.post('/servers/:id/pack/adopt', (c) =>
      pack(c, async (sid, user) => (await packs.adopt(sid, (await jsonBody(c.req)).keep, actor(user), user.username)) satisfies PackState),
    );
    app.post('/servers/:id/pack/update', (c) =>
      pack(
        c,
        async (sid, user) => {
          const body = await jsonBody(c.req);
          return { id: packs.update(sid, body.pending === true ? 'pending' : body, actor(user), user.username) } satisfies PackUpdateAnswer;
        },
        202,
      ),
    );
    app.put('/servers/:id/pack/runtime', (c) =>
      pack(c, async (sid, user) => (await packs.setRuntime(sid, (await jsonBody(c.req)).runtime, actor(user))) satisfies PackState),
    );
    app.post('/servers/:id/pack/update/cancel', (c) => pack(c, async (sid, user) => packs.cancel(sid, actor(user), user.username)));
    app.post('/servers/:id/pack/extras', (c) =>
      pack(c, async (sid, user) => (await packs.addExtra(sid, await jsonBody(c.req), actor(user), user.username)) satisfies PackState),
    );
    app.put('/servers/:id/pack/extras/:extra', (c) =>
      pack(c, async (sid, user) => (await packs.updateExtra(sid, id(c, 'extra'), await jsonBody(c.req), actor(user))) satisfies PackState),
    );
    app.delete('/servers/:id/pack/extras/:extra', (c) =>
      pack(c, async (sid, user) => (await packs.removeExtra(sid, id(c, 'extra'), actor(user))) satisfies PackState),
    );
    app.post('/servers/:id/pack/edits/preview', (c) =>
      pack(c, async (sid) => {
        const { path, find } = await jsonBody(c.req);
        return (await packs.previewEdit(sid, path, find)) satisfies EditPreview;
      }),
    );
    app.post('/servers/:id/pack/edits', (c) =>
      pack(c, async (sid, user) => (await packs.addEdit(sid, await jsonBody(c.req), actor(user), user.username)) satisfies PackState),
    );
    app.put('/servers/:id/pack/edits/:edit', (c) =>
      pack(c, async (sid, user) => (await packs.updateEdit(sid, id(c, 'edit'), await jsonBody(c.req), actor(user))) satisfies PackState),
    );
    app.delete('/servers/:id/pack/edits/:edit', (c) =>
      pack(c, async (sid, user) => (await packs.removeEdit(sid, id(c, 'edit'), actor(user))) satisfies PackState),
    );
  }
}
