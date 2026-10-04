import type { Register } from 'claude-code'

type Run = (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string }>
type Part = { part: string; tag?: string; ahead: number }

const PARTS = ['hub', 'mod', 'web'] as const
const MOD_RELEASE = /release\.sh\s+mod\b/

// Each part's latest tag and the commits under <part>/ since it (what release.sh's notes would list).
export const parts = async (run: Run): Promise<Part[] | undefined> => {
  const root = await run(['git', 'rev-parse', '--show-toplevel'])
  if (root.exitCode !== 0) return undefined
  const git = (...args: string[]) => run(['git', '-C', root.stdout.trim(), ...args])
  const out = await Promise.all(PARTS.map(async part => {
    const tags = await git('tag', '-l', `${part}-v*`, '--sort=-v:refname')
    const tag = tags.stdout.split('\n').find(t => /^\w+-v\d+\.\d+\.\d+$/.test(t))
    const count = await git('rev-list', '--count', tag ? `${tag}..HEAD` : 'HEAD', '--', `${part}/`)
    return { part, tag, ahead: Number(count.stdout.trim()) || 0 }
  }))
  return out.some(p => p.tag) ? out : undefined
}

export const statusText = (ps: Part[]) =>
  ps.map(p => `${p.part} ${p.tag?.slice(p.part.length + 1) ?? '—'}${p.ahead ? ` +${p.ahead}` : ''}`).join(' · ')

export const register: Register = on => {
  // ponytail: per-load memory; a reload re-arms the warning, which errs on the safe side.
  const warned = new Set<string>()

  on('session.start', async ($, e, next) => {
    const run: Run = argv => $.process.run(argv)
    const refresh = async () => {
      const ps = await parts(run).catch(() => undefined)
      $.ui.status(ps && statusText(ps))
    }
    void refresh()
    $.clock.every(60_000, () => void refresh())
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const run: Run = argv => $.process.run(argv)
    if (MOD_RELEASE.test(e.command)) {
      const ps = await parts(run).catch(() => undefined)
      const hub = ps?.find(p => p.part === 'hub')
      const head = (await run(['git', 'rev-parse', 'HEAD'])).stdout.trim()
      if (hub && hub.ahead > 0 && !warned.has(head)) {
        warned.add(head)
        return {
          deny: `${$.plugin.name}: hub has ${hub.ahead} commit(s) since ${hub.tag ?? 'the start'} that aren't released. ` +
            'If this Mod release relies on new hub behaviour (deploy logic, protocol), release and deploy the hub first ' +
            '(.github/release.sh hub …, then deploy it from the Host page). Tell the user; if they confirm the Mod ' +
            "doesn't need it, run the same command again and it will go through.",
        }
      }
    }
    const ran = await next(e)
    if (/\bgit\b|release\.sh/.test(e.command)) {
      const ps = await parts(run).catch(() => undefined)
      $.ui.status(ps && statusText(ps))
    }
    return ran
  })
}
