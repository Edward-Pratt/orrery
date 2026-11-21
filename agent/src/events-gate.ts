// The UDP gate's rules: what Factorio's log says about its Lua UDP socket, and the size a datagram may have.
//
// After each start (the unit became active, or its change time moved while active: a restart between two readings)
// `GameEvents` takes datagrams only once `factorio-current.log` (`files.ts`'s `head`: a regular file, its first 1 MiB
// (`HEAD_MAX`), whole lines) has Factorio's engine line (`ENGINE`) `Opening socket at (IP ADDR:({127.0.0.1:<port>}))`
// followed by a line that is not `Closing socket`, and no `Opening Lua UDP Socket failed` (`socketState`, the Opening
// line `openingLine`: Factorio writes the Opening line before it binds, so on a taken port it is followed by `Closing
// socket`, `Socket closed` and the failure line, as seen on 2.1.24), so no other local process bound that port first.
// A log not written since the agent saw the unit stopped (inactive, failed or activating), or for an unseen restart
// since the second after it became active, is the previous run's and is read again (every 1 s) until Factorio
// replaces it. The failure line, the Opening line followed by `Closing socket`, or no decision within 60 s: events are
// off until the next start, logged once (`Gate`). A datagram over 4 KiB (`MAX_DATAGRAM`) is dropped.

/** The most bytes of JSON in one datagram: the mod shortens its text to fit, so a bigger one is not the mod's. */
export const MAX_DATAGRAM = 4096;
/** Far over where Factorio logs its sockets (startup, before any map is loaded); the rest of the log is not read. */
export const HEAD_MAX = 1024 * 1024;

/** An engine line of the log (seconds since start, level, `File.cpp:N:`), so a chat line or a mod's `log()` can't pass for one. */
export const ENGINE = String.raw`^ *\d+\.\d+ \w+ [\w.]+:\d+: `;
const FAILED = new RegExp(ENGINE + 'Opening Lua UDP Socket failed');
const CLOSING = new RegExp(ENGINE + 'Closing socket$');

/** Factorio's `Opening socket` line for its Lua UDP socket on 127.0.0.1:`port` (a whole line, `\r` taken off). */
export const openingLine = (port: number) => new RegExp(ENGINE + String.raw`Opening socket at \(IP ADDR:\(\{127\.0\.0\.1:${port}\}\)\)$`);

/**
 * What a log says about Factorio's Lua UDP socket on 127.0.0.1:`port`. Factorio writes `Opening socket at (IP
 * ADDR:({127.0.0.1:34198}))` before it binds, so on a taken port that line is followed by `Closing socket`, `Socket
 * closed` and `Opening Lua UDP Socket failed` (seen on 2.1.24). `off` once the log has the failure line, or the Opening
 * line followed by `Closing socket`; `on` once the Opening line is followed by any other line and there is no failure
 * line; null while neither is known (no Opening line, or it is the last line yet). Only whole lines count.
 */
export function socketState(log: string, port: number): 'on' | 'off' | null {
  const opened = openingLine(port);
  const lines = log.split('\n');
  lines.pop(); // what follows the last newline is a line still being written (or nothing)
  let open = -1;
  for (const [i, raw] of lines.entries()) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    lines[i] = line;
    if (FAILED.test(line)) return 'off';
    if (open < 0 && opened.test(line)) open = i;
  }
  if (open < 0 || open + 1 === lines.length) return null; // the bind's outcome isn't logged yet
  return CLOSING.test(lines[open + 1]!) ? 'off' : 'on';
}

/**
 * Whether UDP events are taken: `closed` while the unit isn't active; after each start `checking` until the log
 * decides, then `on`, or `off` until the next start.
 */
export type Gate = 'closed' | 'checking' | 'on' | 'off';
