/** A duration as Discord's `/top` and `/playtime` give it: its two largest units, e.g. "2 h 5 m" or "45 s". */
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
