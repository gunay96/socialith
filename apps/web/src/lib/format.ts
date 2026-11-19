/**
 * Formats a count for KPI cards (e.g. dashboard "Total Views").
 * Full localized number formatting is revisited in Phase 03.
 */
export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact" }).format(value);
}
