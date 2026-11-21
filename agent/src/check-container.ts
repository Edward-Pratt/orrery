// The first-boot check's container checks (`check.ts`): S21 the password in neither the generated unit nor the
// `.container` (read, never printed), `${RCON_PASSWORD}` left there for systemd, and RCON took it; S25 a `factorio`
// process of this uid, `HOME` the data folder (its environment read, never printed), no passwd entry for it in its
// image.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckCtx } from './check-ctx.ts';
import { small } from './check-util.ts';

/**
 * S21: systemd expands `${RCON_PASSWORD}` in the Quadlet `Exec=` (RCON took the password), and the password is in
 * neither the generated unit nor the .container file. Only the result is printed, never either file.
 */
export async function s21(k: CheckCtx): Promise<void> {
  const { unit } = k.c.server;
  const generated = join(k.p.generator, unit);
  const container = join(k.p.quadlet, unit.replace(/\.service$/, '.container'));
  const files = [
    { path: generated, text: await small(generated) },
    { path: container, text: await small(container) },
  ];
  const problems: string[] = [];
  for (const f of files) {
    if (f.text === null) problems.push(`can't read ${f.path}`);
    else if (f.text.includes(k.c.rconPassword)) problems.push(`the RCON password is in ${f.path}`);
  }
  if (files[0]!.text !== null && !files[0]!.text.includes('${RCON_PASSWORD}')) problems.push(`${generated} has no \${RCON_PASSWORD} for systemd to expand`);
  if (k.auth === 'refused') problems.push('RCON refused the password, so systemd may not have expanded ${RCON_PASSWORD}');
  if (problems.length > 0) k.report.say('FAIL', `S21 ${problems.join('; ')}: fallback, the sh -c form`);
  else if (k.auth !== 'ok') k.report.say('warn', 'S21 the password is in neither unit file, but its expansion is not shown (RCON never answered)');
  else k.report.say('ok', 'S21 the password is expanded by systemd (RCON took it), and in neither unit file');
}

/** S25: Factorio runs as this uid (no user namespace) with no passwd entry for it, and HOME the data folder. */
export async function s25(k: CheckCtx): Promise<void> {
  const { data } = k.c.server;
  const uid = process.getuid!();
  const pid = await factorioPid(k, uid);
  if (pid === null) return k.report.say('FAIL', `S25 no factorio process of uid ${uid} in ${k.p.proc}: fallback, bind-mount a one-line passwd file`);
  // The container's environment: only HOME is looked for, and nothing of it is ever printed.
  const environ = await readFile(join(k.p.proc, pid, 'environ')).then(
    (b) => b.toString('utf8').split('\0'),
    () => null,
  );
  if (environ !== null && !environ.includes(`HOME=${data}`)) return k.report.say('FAIL', `S25 Factorio (pid ${pid}, uid ${uid}) has HOME other than ${data}`);
  const passwd = await small(join(k.p.proc, pid, 'root', 'etc', 'passwd'));
  const entry = passwd?.split('\n').some((l) => l.split(':')[2] === String(uid));
  const line = `S25 Factorio (pid ${pid}) runs as uid ${uid}`;
  if (environ === null || passwd === null) {
    k.report.say('warn', `${line}, but its ${environ === null ? 'environment' : '/etc/passwd'} can't be read (SELinux?): HOME and the passwd entry not shown`);
  } else if (entry) k.report.say('warn', `${line}, HOME=${data}, but the image has a passwd entry for it: not exercised`);
  else k.report.say('ok', `${line} with no passwd entry, HOME=${data}`);
}

/** The pid of a process named factorio whose real and effective uid are `uid`; null if none. */
async function factorioPid(k: CheckCtx, uid: number): Promise<string | null> {
  for (const pid of await readdir(k.p.proc)) {
    if (!/^\d+$/.test(pid)) continue;
    const stat = await readFile(join(k.p.proc, pid, 'stat'), 'utf8').catch(() => '');
    if (stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')) !== 'factorio') continue;
    const ids = /^Uid:\s+(\d+)\s+(\d+)/m.exec(await readFile(join(k.p.proc, pid, 'status'), 'utf8').catch(() => ''));
    if (ids && Number(ids[1]) === uid && Number(ids[2]) === uid) return pid;
  }
  return null;
}
