// The checks `validateConfig` and each integration's own section checker share: `checks(errors)` gives `err` (a
// problem, prefixed with where it is) and the field checks built on it (`str`, `id` for a Discord ID, `num`, `port`,
// `hostLimits`, `byServer`, `httpUrl`, `list` for an integration's entries with ids), each pushing its problem onto
// `errors`. Hub core, offline.

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const SNOWFLAKE = /^\d{17,20}$/;

/** The field checks over one list of problems. */
export function checks(errors: string[]) {
  const err = (where: string, msg: string) => errors.push(where ? `${where}: ${msg}` : msg);
  const str = (o: Obj, key: string, where: string, required = true): string | undefined => {
    const v = o[key];
    if (v === undefined) {
      if (required) err(where, `"${key}" is required`);
      return undefined;
    }
    if (typeof v !== 'string' || v === '') {
      err(where, `"${key}" must be a non-empty string`);
      return undefined;
    }
    return v;
  };
  const id = (o: Obj, key: string, where: string, required = true) => {
    const v = str(o, key, where, required);
    if (v !== undefined && !SNOWFLAKE.test(v)) err(where, `"${key}" must be a Discord ID (17–20 digits)`);
  };
  const num = (o: Obj, key: string, where: string, ok: (n: number) => boolean, rule: string) => {
    const v = o[key];
    if (v !== undefined && (typeof v !== 'number' || !ok(v))) err(where, `"${key}" must be ${rule}`);
  };

  const port = (o: Obj, where: string, key = 'listenPort') => {
    const v = o[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) {
      err(where, `"${key}" must be a port number (1–65535)`);
    }
  };
  /** A Host's warning limits, in `integrations.host` and an Agent's `host`. */
  const hostLimits = (o: Obj, where: string) => {
    num(o, 'memoryMaxPercent', where, (n) => n >= 1 && n <= 100, 'a number from 1 to 100');
    num(o, 'memoryMinutes', where, (n) => Number.isInteger(n) && n >= 1, 'a whole number of at least 1');
    num(o, 'diskMinFreeGB', where, (n) => n > 0, 'a positive number');
  };
  /** A map keyed by server id: reports unknown ids and returns its entries. */
  const byServer = (o: Obj, key: string, where: string, ids: Set<string> | undefined): [string, unknown][] => {
    const v = o[key];
    if (!isObj(v)) {
      err(where, `"${key}" must be an object keyed by server id`);
      return [];
    }
    const entries = Object.entries(v);
    if (ids) for (const [sid] of entries) if (!ids.has(sid)) err(`${where}.${key}`, `"${sid}" is not a server id`);
    return entries;
  };

  /** An optional http(s) URL. */
  const httpUrl = (o: Obj, key: string, where: string, required = false) => {
    const url = str(o, key, where, required);
    if (url !== undefined && !/^https?:$/.test(URL.parse(url)?.protocol ?? '')) err(where, `"${key}" must be an http(s) URL`);
  };
  /** An integration's list of entries, each with its own id; `each` checks the rest of an entry. Returns the ids. */
  const list = (o: Obj, key: string, what: string, each: (e: Obj, where: string) => void, at = 'integrations'): Set<string> => {
    const seen = new Set<string>();
    const v = o[key];
    if (!Array.isArray(v)) {
      err(at, `"${key}" must be a list`);
      return seen;
    }
    for (const [i, e] of v.entries()) {
      if (!isObj(e)) {
        err(`${key}[${i}]`, 'must be an object');
        continue;
      }
      const eid = str(e, 'id', `${key}[${i}]`);
      const where = eid === undefined ? `${key}[${i}]` : `${what} "${eid}"`;
      each(e, where);
      if (eid !== undefined) {
        if (seen.has(eid)) err(where, 'duplicate id');
        seen.add(eid);
      }
    }
    return seen;
  };
  return { err, str, id, num, port, hostLimits, byServer, httpUrl, list };
}

export type Checks = ReturnType<typeof checks>;
