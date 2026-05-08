export function timestampToMillis(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }

  return Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value;
}

export function formatTimestamp(value: number | null | undefined): string {
  const millis = timestampToMillis(value);
  if (millis === null) {
    return '--';
  }

  return new Date(millis).toLocaleString();
}

export function isRecentTimestamp(
  value: number | null | undefined,
  windowMs: number,
): boolean {
  const millis = timestampToMillis(value);
  return millis !== null && Date.now() - millis < windowMs;
}
