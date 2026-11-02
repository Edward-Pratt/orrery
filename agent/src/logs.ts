// The log files the agent serves to the hub (`logs`, `log`, `journal`), and its own `agent.log`.
//
// `Logs`, the logs the hub may read, by fixed name only (a name from the hub is looked up in the list, never joined
// into a path): `list` (`logs`: each of `factorio-current.log` and `factorio-previous.log` in the server's data
// folder and `agent.log` in the agent's, `{ name, size, modified }`, if there as a regular file); `log(name)` (its
// last 1000 lines); `journal(unit)` (the last 200 lines of the unit's own log file: `factorio-current.log` for the
// server's unit, `agent.log` for `orrery-agent.service`; any other unit refused, since the agent's user may not read
// the system journal). Read through `files.ts`, cut by `replyLines`. `redact` strips every URL's query string (and
// fragment). `AgentLog`, `<root>/agent.log`: a line per entry with its time, redacted, renamed to `agent.log.1` past
// 4 MiB; `logTo` sends `console.log`/`info`/`warn`/`error` through `redact` to the journal and it.
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import type { LogFile } from '../../hub/src/types.ts';
import { openPlain, tail } from './files.ts';
import { LIMITS, replyLines } from './wire.ts';

/** The agent's own log, in its folder (`/srv/orrery-agent`), which the container never mounts. */
export const AGENT_LOG = 'agent.log';
/** The agent's own unit, whose `journal` is `agent.log`: its user may not read the system journal. */
export const AGENT_UNIT = 'orrery-agent.service';
/** The lines of a `journal` reply (docs/protocol.md). */
export const JOURNAL_LINES = 200;

export type LogsOptions = {
  /** The server's data folder, where Factorio writes `factorio-current.log` and `factorio-previous.log`. */
  data: string;
  /** The agent's folder, which holds `agent.log`. */
  root: string;
  /** The server's unit (`factorio.service`), whose `journal` is `factorio-current.log`. */
  unit: string;
};

/**
 * The three logs the agent serves, by fixed name: Factorio's `factorio-current.log` and `factorio-previous.log`, and
 * its own `agent.log`. A name from the hub is only looked up in that list, never joined into a path; each file is
 * read from a handle opened without following a symlink or blocking, only if it is a regular file on its folder's
 * filesystem. `journal` maps a unit to its own log file, since the agent's user is not let read the system journal.
 */
export class Logs {
  #files: Map<string, string>;
  #units: Map<string, string>;

  constructor(o: LogsOptions) {
    this.#files = new Map([
      ['factorio-current.log', join(o.data, 'factorio-current.log')],
      ['factorio-previous.log', join(o.data, 'factorio-previous.log')],
      [AGENT_LOG, join(o.root, AGENT_LOG)],
    ]);
    this.#units = new Map([
      [o.unit, 'factorio-current.log'],
      [AGENT_UNIT, AGENT_LOG],
    ]);
  }

  /** The `logs` reply: each of the three that is there now, with its size and modified time. */
  async list(): Promise<{ files: LogFile[] }> {
    const files: LogFile[] = [];
    for (const [name, path] of this.#files) {
      const file = await openPlain(path).catch(() => null);
      if (!file) continue;
      await file.fh.close();
      files.push({ name, size: file.st.size, modified: Math.round(file.st.mtimeMs) });
    }
    return { files };
  }

  /** The `log` reply: the last 1000 lines of a listed log; any other name is refused. */
  log(name: string): Promise<{ lines: string[] }> {
    return this.#tail(name, LIMITS.logLines);
  }

  /** The `journal` reply: the last 200 lines of the unit's own log file (the server's, or the agent's); any other unit is refused. */
  journal(unit: string): Promise<{ lines: string[] }> {
    const name = this.#units.get(unit);
    if (name === undefined) return Promise.reject(new Error(`${unit} is not a unit of this agent`));
    return this.#tail(name, JOURNAL_LINES);
  }

  async #tail(name: string, count: number): Promise<{ lines: string[] }> {
    const path = this.#files.get(name);
    if (path === undefined) throw new Error('not a log this agent serves');
    const lines = await tail(path, count);
    if (lines === null) throw new Error(`${name} is not there`);
    return { lines: replyLines(lines, count) };
  }
}

/** A URL's query string and fragment: what follows `?` or `#` up to a space or a quote (a signed link's credentials). */
const QUERY = /\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>`]*)[?#][^\s"'<>`]*/gi;

/** `text` with every URL's query string (and fragment) stripped: no signed download link's credentials are ever logged. */
export const redact = (text: string): string => text.replace(QUERY, '$1');

/**
 * The agent's own `agent.log`: one line per entry, its time first, URL query strings stripped. Past `maxBytes` it is
 * renamed to `agent.log.1` (replacing the previous one) and starts again, so it stays bounded. A failed write is
 * reported on stderr once until a write works again; it never stops the agent.
 */
export class AgentLog {
  #file: string;
  #max: number;
  #size: number;
  #failing = false;

  constructor(file: string, maxBytes = 4 * 1024 * 1024) {
    this.#file = file;
    this.#max = maxBytes;
    try {
      this.#size = statSync(file).size;
    } catch {
      this.#size = 0;
    }
  }

  write(line: string): void {
    const entry = `${new Date().toISOString()} ${redact(line)}\n`;
    const bytes = Buffer.byteLength(entry);
    try {
      if (this.#size > 0 && this.#size + bytes > this.#max) {
        renameSync(this.#file, `${this.#file}.1`);
        this.#size = 0;
      }
      appendFileSync(this.#file, entry);
      this.#size += bytes;
      this.#failing = false;
    } catch (err) {
      if (!this.#failing) process.stderr.write(`[agent] can't write ${this.#file}: ${(err as Error).message}\n`);
      this.#failing = true;
    }
  }
}

/**
 * Sends everything the agent logs (`console.log`, `info`, `warn`, `error`) through `redact`, to the journal (stdout and
 * stderr, as before) and to `log`.
 */
export function logTo(log: AgentLog): void {
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const line = redact(format(...args));
      original('%s', line);
      log.write(line);
    };
  }
}
