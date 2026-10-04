import { test, expect } from 'claude-code/testing'
import { parts, statusText } from './register.ts'

const fake = (tags: Record<string, string>, ahead: Record<string, string>) => async (argv: readonly string[]) => {
  const a = argv.join(' ')
  if (a.includes('show-toplevel')) return { exitCode: 0, stdout: '/repo\n' }
  const part = /(hub|mod|web)/.exec(a)![1]
  if (a.includes(' tag ')) return { exitCode: 0, stdout: tags[part] ?? '' }
  return { exitCode: 0, stdout: ahead[part] ?? '0' }
}

test('status shows each part with unreleased counts', async () => {
  const ps = await parts(fake({ hub: 'hub-v2.10.0\nhub-v2.9.0\n', mod: 'mod-v1.5.0\n' }, { hub: '3\n', web: '1\n' }))
  expect(statusText(ps!)).toBe('hub v2.10.0 +3 · mod v1.5.0 · web — +1')
})

test('no tags means no status', async () => {
  expect(await parts(fake({}, {}))).toBe(undefined)
})
