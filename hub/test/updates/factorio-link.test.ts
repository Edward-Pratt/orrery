// A mod's signed download link (`factorio-link.ts`, through `FactorioCatalog.link`).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactorioCatalog, GameRefused, type PortalFetch } from '../../src/updates/factorio.ts';
import { ACCOUNT, portal } from './factorio-portal.ts';

test('a download link is the signed dl-mod.factorio.com one: asked with the account, never following a redirect, and passed on without it', async () => {
  const download = '/download/flib/5f9f3d3c3a5f4c0001b8c9e4';
  const asked = `https://mods.factorio.com${download}?username=owner&token=${ACCOUNT.token}`;
  const signed = 'https://dl-mod.factorio.com/files/5f/flib_0.16.2.zip?secure=Lk4AJh-V9cC_2wLJ8_7B5w,1730393211';
  const answer = (location: string | null, status = 302) => portal({ [asked]: { status, headers: location === null ? {} : { location } } });

  const ok = answer(signed);
  assert.equal(await new FactorioCatalog(ok.fetch, ACCOUNT).link(download), signed);
  assert.deepEqual(ok.asked, [{ url: asked, redirect: 'manual' }]);

  const refusals: [ReturnType<typeof answer>, string][] = [
    [answer(`https://dl-mod.factorio.com/files/5f/flib.zip?secure=x&token=${ACCOUNT.token}`), 'signed'],
    [answer('https://dl-mod.factorio.com/files/5f/flib.zip?secure=x&username=owner'), 'signed'],
    [answer(`https://dl-mod.factorio.com/files/${ACCOUNT.token}/flib.zip?secure=x`), 'signed'],
    [answer('https://evil.example/flib.zip?secure=x'), 'signed'],
    [answer('http://dl-mod.factorio.com/flib.zip?secure=x'), 'signed'],
    [answer('https://dl-mod.factorio.com:8443/flib.zip?secure=x'), 'signed'],
    [answer('https://dl-mod.factorio.com/flib.zip'), 'signed'],
    [answer(`https://dl-mod.factorio.com/${'x'.repeat(2100)}.zip?secure=x`), 'over 2048 characters'],
    [answer(null, 200), 'HTTP 200'],
    [answer(null, 403), 'HTTP 403: check FACTORIO_USERNAME and FACTORIO_TOKEN'],
  ];
  for (const [fake, why] of refusals) {
    await assert.rejects(new FactorioCatalog(fake.fetch, ACCOUNT).link(download), (err: GameRefused) => {
      assert.equal(err.status, 502);
      assert.ok(err.message.includes(why), err.message);
      assert.ok(!err.message.includes(ACCOUNT.token) && !err.message.includes('username='), err.message);
      return true;
    });
  }
  const down: PortalFetch = async () => {
    throw new TypeError(`fetch failed for ${asked}`, { cause: { code: 'ECONNRESET' } });
  };
  await assert.rejects(new FactorioCatalog(down, ACCOUNT).link(download), (err: GameRefused) => err.message === "The mod portal didn't give a download link: ECONNRESET.");
  // Without the account: refused, saying how to fix it; nothing asked.
  const none = answer(signed);
  await assert.rejects(new FactorioCatalog(none.fetch).link(download), (err: GameRefused) => err.status === 409 && /FACTORIO_USERNAME and FACTORIO_TOKEN aren't set/.test(err.message));
  assert.deepEqual(none.asked, []);
});
