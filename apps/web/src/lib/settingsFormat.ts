/** Display helpers for the Settings sections (backup sizes and times). */

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function formatTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "unknown";
}
