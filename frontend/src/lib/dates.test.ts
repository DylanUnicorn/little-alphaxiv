import { describe, it, expect } from "vitest";
import { groupByDate } from "./dates";

const DAY = 24 * 60 * 60 * 1000;
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Local noon today so small hour-offsets never cross a midnight boundary.
function noonNow(): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

describe("groupByDate", () => {
  it("returns no groups for empty input", () => {
    expect(groupByDate([], () => 0, noonNow())).toEqual([]);
  });

  it("puts each recency tier in its own bucket, newest first", () => {
    const now = noonNow();
    const items = [
      { id: "old30", ts: now - 12 * DAY }, // Previous 30 Days
      { id: "yday", ts: now - 26 * 60 * 60 * 1000 }, // Yesterday (26h)
      { id: "old7", ts: now - 3 * DAY }, // Previous 7 Days
      { id: "today", ts: now - 1 * 60 * 60 * 1000 }, // Today (1h)
      { id: "future", ts: now + 1 * 60 * 60 * 1000 }, // future -> Today
    ];
    const groups = groupByDate(items, (i) => i.ts, now);
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      "Previous 7 Days",
      "Previous 30 Days",
    ]);
    const byId = (g: typeof groups[number]) => g.items.map((i) => i.id);
    expect(byId(groups[0])).toEqual(["today", "future"]); // input order preserved
    expect(byId(groups[1])).toEqual(["yday"]);
    expect(byId(groups[2])).toEqual(["old7"]);
    expect(byId(groups[3])).toEqual(["old30"]);
  });

  it("collapses >30d items into calendar-month groups, newer months first", () => {
    const now = noonNow();
    const older = now - 70 * DAY; // ~2 months back
    const newer = now - 45 * DAY; // ~1.5 months back, still >30d
    const olderD = new Date(older);
    const newerD = new Date(newer);
    const olderLabel = `${MONTHS[olderD.getMonth()]} ${olderD.getFullYear()}`;
    const newerLabel = `${MONTHS[newerD.getMonth()]} ${newerD.getFullYear()}`;

    const items = [
      { id: "older", ts: older },
      { id: "newer", ts: newer },
    ];
    const groups = groupByDate(items, (i) => i.ts, now);
    // Two distinct month buckets (unless they happen to land in the same
    // calendar month); newest month comes first.
    const labels = groups.map((g) => g.label);
    if (olderLabel === newerLabel) {
      expect(labels).toEqual([olderLabel]);
      expect(groups[0].items.map((i) => i.id)).toEqual(["older", "newer"]);
    } else {
      expect(labels).toEqual([newerLabel, olderLabel]);
      expect(groups[0].items.map((i) => i.id)).toEqual(["newer"]);
      expect(groups[1].items.map((i) => i.id)).toEqual(["older"]);
    }
  });

  it("keeps input order within a single bucket", () => {
    const now = noonNow();
    const items = [
      { id: "a", ts: now - 1 * 60 * 1000 },
      { id: "b", ts: now - 2 * 60 * 1000 },
      { id: "c", ts: now - 3 * 60 * 1000 },
    ];
    const groups = groupByDate(items, (i) => i.ts, now);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Today");
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});
