// Date-bucketing for the conversation sidebar (alphaxiv-style recency groups).
//
// Conversations are grouped under recency headers, newest first:
//   Today / Yesterday / Previous 7 Days / Previous 30 Days / <Month Year>
// Items within a bucket keep their input order — callers pre-sort by
// most-recently-touched so each section stays MRU internally.
//
// `now` is an injected parameter (defaulting to Date.now()) so tests are
// deterministic; production callers rely on the default.

export interface DateGroup<T> {
  label: string;
  items: T[];
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Bucket items by recency into alphaxiv-style date groups, newest first.
 *  Items older than 30 days collapse into calendar-month groups
 *  (e.g. "April 2026"), newer months before older ones. */
export function groupByDate<T>(
  items: T[],
  getTs: (item: T) => number,
  now: number = Date.now(),
): DateGroup<T>[] {
  const today = startOfDay(now);
  const yesterday = today - DAY_MS;
  const sevenDays = today - 7 * DAY_MS;
  const thirtyDays = today - 30 * DAY_MS;

  interface Bucket {
    label: string;
    order: number; // fixed buckets 0..3; month tier = 4 (secondary sort by maxTs)
    maxTs: number; // newest item in the bucket — drives newest-first within a tier
    items: T[];
  }
  const buckets = new Map<string, Bucket>();

  function ensure(key: string, label: string, order: number, ts: number): Bucket {
    let b = buckets.get(key);
    if (!b) {
      b = { label, order, maxTs: ts, items: [] };
      buckets.set(key, b);
    } else if (ts > b.maxTs) {
      b.maxTs = ts;
    }
    return b;
  }

  for (const item of items) {
    const ts = getTs(item);
    let key: string;
    let label: string;
    let order: number;
    if (ts >= today) {
      key = "today";
      label = "Today";
      order = 0;
    } else if (ts >= yesterday) {
      key = "yesterday";
      label = "Yesterday";
      order = 1;
    } else if (ts >= sevenDays) {
      key = "7d";
      label = "Previous 7 Days";
      order = 2;
    } else if (ts >= thirtyDays) {
      key = "30d";
      label = "Previous 30 Days";
      order = 3;
    } else {
      const d = new Date(ts);
      key = `m-${d.getFullYear()}-${d.getMonth()}`;
      label = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      order = 4;
    }
    ensure(key, label, order, ts).items.push(item);
  }

  return [...buckets.values()]
    .sort((a, b) => a.order - b.order || b.maxTs - a.maxTs)
    .map(({ label, items }) => ({ label, items }));
}
