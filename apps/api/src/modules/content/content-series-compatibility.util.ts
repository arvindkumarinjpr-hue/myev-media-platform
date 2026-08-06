/**
 * Module 1E Engineering Plan §5 (final correction round, "Project-Series
 * Compatibility"): a workspace-level series (projectId null) accepts any
 * content item, including one with no project of its own. A project-
 * specific series only accepts items whose projectId exactly matches —
 * an unassigned (null-project) item is never compatible with a
 * project-specific series, even though the series' own project is
 * "specific" in only one direction of the comparison.
 *
 * Pure and total — no I/O, so callers can run it after acquiring locks
 * without any risk of it being the thing that blocks.
 */
export function isSeriesProjectCompatible(seriesProjectId: string | null, itemProjectId: string | null): boolean {
  if (seriesProjectId === null) return true;
  return itemProjectId !== null && itemProjectId === seriesProjectId;
}
