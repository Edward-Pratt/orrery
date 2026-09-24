/** "3 d 4 h", "5 h 12 m", "3 m 12 s", "45 s": the two largest non-zero units. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const parts: [number, string][] = [
    [Math.floor(s / 86_400), 'd'],
    [Math.floor(s / 3600) % 24, 'h'],
    [Math.floor(s / 60) % 60, 'm'],
    [s % 60, 's'],
  ];
  const first = parts.findIndex(([n]) => n > 0);
  if (first === -1) return '0 s';
  return parts
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, unit]) => `${n} ${unit}`)
    .join(' ');
}

/** "512 B", "1.5 KB", "3.2 GB" (1024-based). */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
}

/** Local calendar day "YYYY-MM-DD" (not UTC: toISOString would give yesterday at 00:30 BST). */
export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
