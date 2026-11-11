import { describe, expect, test } from "vitest";
import type { Machine } from "./api";
import { machineSeries, OTHER, REMOVED, seriesOf, stableSeries } from "./series";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id${String(i).padStart(2, "0")}`);
const colors = (map: Map<string, { colorClass: string }>, keys: string[]) =>
  keys.map((k) => map.get(k)?.colorClass);

describe("stable series", () => {
  test("ids past the eighth get a color when few are shown", () => {
    // 20 ids overall, three shown: none fold.
    const all = ids(20);
    const map = stableSeries(all, ["id00", "id12", "id15"], (id) => id, "Other");
    expect(colors(map, ["id00", "id12", "id15"])).toEqual(["s1", "s2", "s3"]);
    expect(seriesOf(map, ["id00", "id12", "id15"]).map((s) => s.id)).toEqual([
      "id00",
      "id12",
      "id15",
    ]);
  });

  test("shown ids keep their own colors among the first eight", () => {
    const map = stableSeries(ids(20), ["id03", "id09"], (id) => id, "Other");
    // id03 owns s4; id09 takes the first color no shown id owns.
    expect(colors(map, ["id03", "id09"])).toEqual(["s4", "s1"]);
  });

  test("past eight shown, the oldest seven shown keep colors and the rest fold", () => {
    // Nine shown, mostly beyond the eighth id: still seven colors, not three.
    const shown = ["id00", "id01", "id02", "id10", "id11", "id12", "id13", "id14", "id15"];
    const map = stableSeries(ids(20), shown, (id) => id, "Other");
    const series = seriesOf(map, shown);
    expect(series.map((s) => s.id)).toEqual([...shown.slice(0, 7), OTHER]);
    expect(new Set(series.map((s) => s.colorClass)).size).toBe(8);
    expect(series.at(-1)).toEqual({ id: OTHER, label: "Other", colorClass: "s-other" });
  });

  test("gray comes last in the legend", () => {
    const shown = ids(9);
    const map = stableSeries([...ids(20)].reverse(), shown, (id) => id, "Other");
    expect(seriesOf(map, shown).at(-1)?.id).toBe(OTHER);
  });
});

function machine(id: string, created_at: number, removed = false): Machine {
  return {
    id,
    name: `pc-${id}`,
    os: "linux",
    arch: "amd64",
    agent_version: "0.7.1",
    ccusage_version: null,
    sync_interval_minutes: 15,
    created_at,
    last_seen_at: null,
    revoked_at: removed ? 1 : null,
    removed_at: removed ? 2 : null,
    tools: [],
    department: null,
    owner: null,
    status: "ok",
    update_available: false,
    can_manage: true,
  };
}

describe("machine series", () => {
  // Nine machines, as on a dashboard where only three report today.
  const machines = ids(9).map((id, i) => machine(id, i));

  test("three of nine machines shown are three colored series, no Other", () => {
    const shown = ["id00", "id07", "id08"];
    const map = machineSeries(machines, shown);
    expect(seriesOf(map, shown).map((s) => `${s.label} ${s.colorClass}`)).toEqual([
      "pc-id00 s1",
      "pc-id07 s8",
      "pc-id08 s2",
    ]);
  });

  test("all nine shown: seven colors and Other machines", () => {
    const shown = ids(9);
    const series = seriesOf(machineSeries(machines, shown), shown);
    expect(series.map((s) => s.label)).toEqual([
      ...ids(7).map((id) => `pc-${id}`),
      "Other machines",
    ]);
  });

  test("removed machines are Removed machines, or part of Other when there is one", () => {
    const withRemoved = [...machines, machine("gone", 100, true)];
    const few = machineSeries(withRemoved, ["id00", "gone"]);
    expect(few.get("gone")?.id).toBe(REMOVED);
    expect(seriesOf(few, ["id00", "gone"]).map((s) => s.label)).toEqual([
      "pc-id00",
      "Removed machines",
    ]);
    const all = machineSeries(withRemoved, [...ids(9), "gone"]);
    expect(all.get("gone")?.id).toBe(OTHER);
  });

  test("on the Machines page, only the first eight have a color of their own", () => {
    const map = machineSeries(machines, []);
    expect(map.get("id07")?.colorClass).toBe("s8");
    expect(map.get("id08")?.id).toBe(OTHER);
  });

  test("usage of a machine the list doesn't have is still drawn", () => {
    const map = machineSeries(machines, ["id00", "unknown"]);
    expect(seriesOf(map, ["id00", "unknown"]).map((s) => s.label)).toEqual([
      "pc-id00",
      "Unknown machine",
    ]);
  });
});
