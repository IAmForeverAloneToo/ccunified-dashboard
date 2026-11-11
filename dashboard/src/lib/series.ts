import type { Machine } from "./api";
import type { Series } from "./chart";

/**
 * The id of the gray series that the rest fold into. No tool, model family,
 * department or machine can have it: none of their ids contain a NUL.
 */
export const OTHER = "\u0000other";

/**
 * Chart series that keep their colors. Ids get colors in the order given,
 * usually the order the dashboard first saw them, so a new id never repaints
 * the others; ids that appear but aren't in the order come after, by name.
 *
 * There are eight colors, and only the ids shown (in `seen`) count: however
 * many ids there are overall, up to eight shown ids each get a color. The
 * first eight ids own theirs; a shown id beyond the eighth takes a color no
 * other shown id uses. Only when more than eight are shown do the newest of
 * them fold into one gray series, `OTHER`, beside seven colored ones. Ids
 * that aren't shown keep their own color among the first eight, and fold
 * after that.
 */
export function stableSeries(
  order: string[],
  seen: Iterable<string>,
  label: (id: string) => string,
  other: string,
): Map<string, Series> {
  const all = [...new Set(order)];
  const shownSet = new Set(seen);
  for (const id of [...shownSet].sort()) if (!all.includes(id)) all.push(id);
  const shown = all.filter((id) => shownSet.has(id));
  // Shown ids that keep a color: all of them, or the oldest seven.
  const kept = new Set(shown.length <= 8 ? shown : shown.slice(0, 7));
  const taken = new Set([...kept].map((id) => all.indexOf(id)).filter((i) => i < 8));
  const free = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => !taken.has(i));
  const folded: Series = { id: OTHER, label: other, colorClass: "s-other" };
  const map = new Map<string, Series>();
  all.forEach((id, i) => {
    let slot: number | undefined;
    if (kept.has(id)) slot = i < 8 ? i : free.shift();
    else if (!shownSet.has(id) && i < 8) slot = i;
    map.set(id, slot === undefined ? folded : { id, label: label(id), colorClass: `s${slot + 1}` });
  });
  return map;
}

/** The series the given keys map to, once each, in color order, gray last. */
export function seriesOf(map: Map<string, Series>, keys: Iterable<string>): Series[] {
  const wanted = new Set([...keys].map((k) => map.get(k)?.id ?? OTHER));
  const unique = new Map([...map.values()].map((s) => [s.id, s]));
  const series = [...unique.values()].filter((s) => wanted.has(s.id));
  const gray = (s: Series) => (s.colorClass === "s-other" ? 1 : 0);
  return series.sort((a, b) => gray(a) - gray(b));
}

/** The series and table row that removed machines' usage counts under. */
export const REMOVED = "removed";

/**
 * Machines keep the color of their position in the order they joined
 * (oldest first), so filtering never repaints anyone. Like tools and models,
 * only the machines shown (in `seen`) count: only when more than eight are
 * shown do the newest of them fold into a gray "Other machines". Removed machines (their usage kept) are gray "Removed
 * machines", or part of "Other machines" when there is one.
 */
export function machineSeries(machines: Machine[], seen: Iterable<string>): Map<string, Series> {
  const active = machines
    .filter((m) => m.removed_at === null)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  const names = new Map(active.map((m) => [m.id, m.name]));
  const shown = new Set(seen);
  const removedIds = new Set(machines.filter((m) => m.removed_at !== null).map((m) => m.id));
  const map = stableSeries(
    active.map((m) => m.id),
    [...shown].filter((id) => !removedIds.has(id)),
    (id) => names.get(id) ?? "Unknown machine",
    "Other machines",
  );
  const folded = [...shown].some((id) => !removedIds.has(id) && map.get(id)?.id === OTHER);
  const removed: Series = folded
    ? { id: OTHER, label: "Other machines", colorClass: "s-other" }
    : { id: REMOVED, label: "Removed machines", colorClass: "s-other" };
  for (const m of machines) if (m.removed_at !== null) map.set(m.id, removed);
  return map;
}
