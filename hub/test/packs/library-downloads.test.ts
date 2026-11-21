// Downloads: Actions artifacts, redirects and resuming (#140).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha, URL_NEW } from './pack-world.ts';
import { libraryHub, NEW, URL_FORGE } from './library-hub.ts';

const ARTIFACT = 'https://github.com/GTNewHorizons/DreamAssemblerXXL/actions/runs/123/artifacts/456';
const ARTIFACT_API = 'https://api.github.com/repos/GTNewHorizons/DreamAssemblerXXL/actions/artifacts/456/zip';
const BLOB = 'https://blob.example/artifact.zip?sig=abc';

test('an Actions artifact is fetched through the API with the token, which never goes to the blob link it redirects to', async (t) => {
  const { w, s, lib, add, finished } = await libraryHub(t, { githubToken: 'ghp_secret' });
  w.urls[BLOB] = w.urls[URL_FORGE]!;
  s.fake.redirects[ARTIFACT_API] = BLOB;
  await add({ url: ARTIFACT, name: 'GT New Horizons', version: 'nightly-123' });
  assert.deepEqual(await finished(), ['ok', '']);
  assert.deepEqual(
    s.fake.requests.map((r) => [r.url, r.headers.authorization]),
    [
      [ARTIFACT_API, 'Bearer ghp_secret'],
      [BLOB, undefined],
    ],
  );
  const [entry] = (await lib()).packs;
  assert.deepEqual([entry!.source, entry!.sha256], [ARTIFACT, sha(w.urls[URL_FORGE]!)]);
  // A pasted api.github.com link is no artifact: the hub's token is never lent to it.
  s.fake.requests.length = 0;
  w.urls['https://api.github.com/repos/someone/private/zipball'] = w.urls[URL_NEW]!;
  await add({ url: 'https://api.github.com/repos/someone/private/zipball', ...NEW });
  await finished(2);
  assert.deepEqual(s.fake.requests.map((r) => r.headers.authorization), [undefined]);
});

test('an Actions artifact without a token is refused, saying why', async (t) => {
  const { s } = await libraryHub(t);
  const res = await s.req('POST', '/api/library/packs', { url: ARTIFACT, ...NEW });
  assert.equal(res.status, 400);
  assert.equal(await res.text(), 'An Actions artifact needs a GitHub token: set GITHUB_TOKEN (Actions: read) for the hub, or paste a release link.');
  assert.deepEqual(s.fake.requests, []);
});

test('a dropped download resumes with Range and If-Range, an artifact through the API again for a fresh link', async (t) => {
  const { w, s, lib, add, finished } = await libraryHub(t, { githubToken: 'ghp_secret' });
  w.urls[BLOB] = w.urls[URL_FORGE]!;
  s.fake.redirects[ARTIFACT_API] = BLOB;
  s.fake.drops = 2;
  await add({ url: ARTIFACT, name: 'GT New Horizons', version: 'nightly-123' });
  assert.deepEqual(await finished(), ['ok', '']);
  const etag = `"${sha(w.urls[URL_FORGE]!)}"`;
  assert.deepEqual(
    s.fake.requests.map((r) => [r.url, r.headers.range, r.headers['if-range']]),
    [
      [ARTIFACT_API, undefined, undefined],
      [BLOB, undefined, undefined],
      [ARTIFACT_API, 'bytes=100-', etag],
      [BLOB, 'bytes=100-', etag],
      [ARTIFACT_API, 'bytes=200-', etag],
      [BLOB, 'bytes=200-', etag],
    ],
  );
  assert.equal((await lib()).packs[0]!.sha256, sha(w.urls[URL_FORGE]!));
  // A plain URL resumes against itself.
  s.fake.requests.length = 0;
  s.fake.drops = 1;
  await add({ url: URL_NEW, ...NEW });
  assert.deepEqual(await finished(2), ['ok', '']);
  assert.deepEqual(s.fake.requests.map((r) => [r.url, r.headers.range]), [[URL_NEW, undefined], [URL_NEW, 'bytes=100-']]);
  assert.equal((await lib()).packs.find((p) => p.version === '2.7.5')!.sha256, sha(w.urls[URL_NEW]!));
});

test('a 200 to a Range starts the file over; a fourth drop fails the add', async (t) => {
  const { w, s, lib, add, finished, files } = await libraryHub(t);
  s.fake.drops = 1;
  s.fake.ignoreRange = true;
  await add({ url: URL_NEW, ...NEW });
  assert.deepEqual(await finished(), ['ok', '']);
  assert.deepEqual(s.fake.requests.map((r) => r.headers.range), [undefined, 'bytes=100-']);
  assert.equal((await lib()).packs[0]!.sha256, sha(w.urls[URL_NEW]!)); // not the first 100 bytes twice
  s.fake.ignoreRange = false;
  s.fake.drops = 4;
  await add({ url: URL_FORGE, name: 'GT New Horizons', version: '2.7.6' });
  assert.deepEqual(await finished(2), ['failed', 'Downloading the pack failed: connection reset (after 3 resumes)']);
  assert.deepEqual(files(), [`${sha(w.urls[URL_NEW]!)}.zip`]);
});

test('more than 5 redirects, a redirect off https, and an HTTP error fail the add without resuming', async (t) => {
  const { w, s, add, finished } = await libraryHub(t);
  for (let i = 0; i < 6; i++) s.fake.redirects[`https://hop.example/${i}`] = `https://hop.example/${i + 1}`;
  w.urls['https://hop.example/6'] = w.urls[URL_NEW]!;
  s.fake.redirects['https://plain.example/a.zip'] = 'http://plain.example/a.zip';
  for (const [i, [url, why]] of [
    ['https://hop.example/0', 'more than 5 redirects'],
    ['https://plain.example/a.zip', "a redirect to http://plain.example/a.zip isn't https: refused"],
    ['https://packs.example/missing.zip', 'HTTP 404'],
  ].entries()) {
    s.fake.requests.length = 0;
    await add({ url, ...NEW });
    assert.deepEqual(await finished(i + 1), ['failed', `Downloading the pack failed: ${why}`]);
  }
  assert.equal(s.fake.requests.length, 1); // the 404: asked once
  s.fake.requests.length = 0;
  delete s.fake.redirects['https://hop.example/0'];
  s.fake.redirects['https://hop.example/1'] = 'https://hop.example/2';
  await add({ url: 'https://hop.example/1', ...NEW }); // five redirects are fine
  assert.deepEqual(await finished(4), ['ok', '']);
});
