// The GitHub reader for `Deploys`: GitHub's published releases and their assets, injected as `GitHub` so tests need no
// network; `githubReader` is the real REST one (`fetch`, the token from `GITHUB_TOKEN`), whose `download(tag, asset)`
// gives a release asset's bytes (a New server's Mod). Hub core.

import type { Release } from '../types.ts';

/** A release as GitHub lists it, drafts and prereleases included. */
export type GitHubRelease = Release & { draft: boolean; prerelease: boolean };
/** GitHub's published releases and their assets, passed in so tests need no network. */
export type GitHub = {
  releases: () => Promise<GitHubRelease[]>;
  download: (tag: string, asset: string) => Promise<Uint8Array>;
};

/** The real GitHub REST API, with the token; `fetch` follows an asset's redirect (dropping the token off GitHub). */
export function githubReader(repo: string, token: string): GitHub {
  const api = `https://api.github.com/repos/${repo}`;
  const call = async (url: string, accept = 'application/vnd.github+json') => {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
    return res;
  };
  type Raw = { tag_name: string; draft: boolean; prerelease: boolean; published_at: string | null; assets: { name: string; url: string }[] };
  return {
    releases: async () =>
      ((await (await call(`${api}/releases?per_page=100`)).json()) as Raw[]).map((r) => ({
        tag: r.tag_name,
        draft: r.draft,
        prerelease: r.prerelease,
        publishedAt: Date.parse(r.published_at ?? '') || 0,
        assets: r.assets.map((a) => a.name),
      })),
    download: async (tag, asset) => {
      const release = (await (await call(`${api}/releases/tags/${encodeURIComponent(tag)}`)).json()) as Raw;
      const found = release.assets.find((a) => a.name === asset);
      if (!found) throw new Error(`${tag} has no asset ${asset}`);
      return new Uint8Array(await (await call(found.url, 'application/octet-stream')).arrayBuffer());
    },
  };
}
