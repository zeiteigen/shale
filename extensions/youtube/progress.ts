/** Unique content coverage, independent of visit count and playback speed. */
export type PlayedRange = [number, number];

export function mergeRanges(ranges: readonly PlayedRange[], duration: number): PlayedRange[] {
  const sorted = ranges.map(([start, end]): PlayedRange => [Math.max(0, start), Math.min(duration, end)])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged: PlayedRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

export function playedSeconds(ranges: readonly PlayedRange[], duration: number): number {
  return mergeRanges(ranges, duration).reduce((total, [start, end]) => total + end - start, 0);
}

export function qualifies(ranges: readonly PlayedRange[], duration: number): boolean {
  return Number.isFinite(duration) && duration > 0 && playedSeconds(ranges, duration) >= duration / 2;
}
