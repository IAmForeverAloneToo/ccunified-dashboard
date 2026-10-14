import type { Series } from "./chart";

/**
 * Chart series that keep their colors. Ids get colors in the order given,
 * usually the order the dashboard first saw them, so a new id never repaints
 * the others; ids that appear but aren't in the order come after, by name.
 * Past eight ids, the newest fold into one gray series, `other`.
 */
export function stableSeries(
  order: string[],
  seen: Iterable<string>,
  label: (id: string) => string,
  other: string,
): Map<string, Series> {
  const all = [...new Set(order)];
  for (const id of [...new Set(seen)].sort()) if (!all.includes(id)) all.push(id);
  const fold = all.length > 8;
  const map = new Map<string, Series>();
  all.forEach((id, i) => {
    map.set(
      id,
      fold && i >= 7
        ? { id: "other", label: other, colorClass: "s-other" }
        : { id, label: label(id), colorClass: `s${i + 1}` },
    );
  });
  return map;
}

/** The series the given keys map to, once each, in color order. */
export function seriesOf(map: Map<string, Series>, keys: Iterable<string>): Series[] {
  const wanted = new Set([...keys].map((k) => map.get(k)?.id ?? "other"));
  const unique = new Map([...map.values()].map((s) => [s.id, s]));
  return [...unique.values()].filter((s) => wanted.has(s.id));
}
