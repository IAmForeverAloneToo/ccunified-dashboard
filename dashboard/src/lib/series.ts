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
 * There are eight colors. Past eight ids overall, an id beyond the eighth that
 * is shown (in `seen`) takes a color no other shown id uses, as long as at
 * most eight are shown; only when more than eight are shown do the newest
 * fold into one gray series, `OTHER`.
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
  const color = (id: string, slot: number): Series => ({
    id,
    label: label(id),
    colorClass: `s${slot + 1}`,
  });
  const folded: Series = { id: OTHER, label: other, colorClass: "s-other" };
  const map = new Map<string, Series>();
  const shown = all.filter((id) => shownSet.has(id));
  if (all.length <= 8 || shown.length <= 8) {
    // Colors the shown ids own; the ones beyond the eighth take what's left.
    const taken = new Set(shown.map((id) => all.indexOf(id)).filter((i) => i < 8));
    const free = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => !taken.has(i));
    all.forEach((id, i) => {
      if (i < 8) map.set(id, color(id, i));
      else if (shownSet.has(id)) map.set(id, color(id, free.shift() ?? 0));
      else map.set(id, folded);
    });
    return map;
  }
  all.forEach((id, i) => {
    map.set(id, i >= 7 ? folded : color(id, i));
  });
  return map;
}

/** The series the given keys map to, once each, in color order. */
export function seriesOf(map: Map<string, Series>, keys: Iterable<string>): Series[] {
  const wanted = new Set([...keys].map((k) => map.get(k)?.id ?? OTHER));
  const unique = new Map([...map.values()].map((s) => [s.id, s]));
  return [...unique.values()].filter((s) => wanted.has(s.id));
}
