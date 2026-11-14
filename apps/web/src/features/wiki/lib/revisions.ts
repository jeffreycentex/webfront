/**
 * Revision policy (pure): when to snapshot a page body, and which old revisions to prune.
 */

/** At most one automatic snapshot per page per this interval while editing. */
export const SNAPSHOT_INTERVAL_MS = 5 * 60_000;

export interface RevisionLike {
  id: string;
  createdAt: string;
  body: string;
}

export type SnapshotReason = 'edit' | 'leave' | 'merge' | 'restore' | 'conflict' | 'create';

/**
 * Should a snapshot of `body` be taken now?
 *  - never when it equals the latest revision's body;
 *  - always for merge / restore / conflict / create / leave (forced points);
 *  - for ordinary edits, only if the latest revision is older than SNAPSHOT_INTERVAL_MS.
 */
export function shouldSnapshot(
  latest: RevisionLike | undefined,
  body: string,
  reason: SnapshotReason,
  now: number,
): boolean {
  if (latest && latest.body === body) return false;
  if (!latest) return body.trim().length > 0 || reason !== 'edit';
  if (reason !== 'edit') return true;
  return now - Date.parse(latest.createdAt) >= SNAPSHOT_INTERVAL_MS;
}

export interface RetentionRule {
  /** Always keep this many newest revisions. */
  keepRecent: number;
  /** Beyond that, keep the newest revision of each day for this many days… */
  dailyDays: number;
  /** …and the newest of each 30-day period up to this many days. */
  monthlyDays: number;
  /** Hard cap on revisions per page. */
  max: number;
}

export const DEFAULT_RETENTION: RetentionRule = {
  keepRecent: 20,
  dailyDays: 30,
  monthlyDays: 365,
  max: 80,
};

/**
 * Revisions to prune for one page (ids), given all its live revisions. Keeps the newest
 * `keepRecent`, then thins older ones to one per day (≤ dailyDays old) and one per 30 days
 * (≤ monthlyDays old); anything older than monthlyDays goes, except that the oldest revision
 * is kept as the page's origin. Never prunes `protect` ids (e.g. the page's base revision).
 */
export function revisionsToPrune(
  revisions: readonly RevisionLike[],
  now: number,
  rule: RetentionRule = DEFAULT_RETENTION,
  protect: ReadonlySet<string> = new Set(),
): string[] {
  const sorted = [...revisions].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
  );
  const keep = new Set<string>();
  const buckets = new Set<string>();
  const DAY = 86_400_000;
  sorted.forEach((r, i) => {
    if (i < rule.keepRecent || protect.has(r.id)) {
      keep.add(r.id);
      return;
    }
    const age = now - Date.parse(r.createdAt);
    let bucket: string | null = null;
    if (age <= rule.dailyDays * DAY) bucket = `d${Math.floor(Date.parse(r.createdAt) / DAY)}`;
    else if (age <= rule.monthlyDays * DAY)
      bucket = `m${Math.floor(Date.parse(r.createdAt) / (30 * DAY))}`;
    if (bucket && !buckets.has(bucket)) {
      buckets.add(bucket);
      keep.add(r.id);
    }
  });
  const oldest = sorted[sorted.length - 1];
  if (oldest) keep.add(oldest.id);
  // Hard cap: drop the oldest kept ones (but not protected ones or the origin).
  const kept = sorted.filter((r) => keep.has(r.id));
  let excess = kept.length - rule.max;
  for (let i = kept.length - 2; i >= 0 && excess > 0; i--) {
    const r = kept[i]!;
    if (protect.has(r.id) || i < rule.keepRecent) continue;
    keep.delete(r.id);
    excess--;
  }
  return sorted.filter((r) => !keep.has(r.id)).map((r) => r.id);
}
