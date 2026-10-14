import { describe, expect, test } from "vitest";
import {
  addMonths,
  addMonthsKeepDay,
  daysInclusive,
  formatRange,
  isDate,
  localeFirstDay,
  monthEnd,
  monthGrid,
  ordered,
  parseTyped,
  presets,
  weekdayOrder,
  weekStart,
} from "./dates";

describe("dates", () => {
  test("isDate accepts only real YYYY-MM-DD dates", () => {
    expect(isDate("2026-09-03")).toBe(true);
    expect(isDate("2028-02-29")).toBe(true);
    expect(isDate("2026-02-29")).toBe(false);
    expect(isDate("2026-9-03")).toBe(false);
    expect(isDate("2026-13-01")).toBe(false);
    expect(isDate("")).toBe(false);
  });

  test("daysInclusive counts both ends", () => {
    expect(daysInclusive("2026-09-03", "2026-09-18")).toBe(16);
    expect(daysInclusive("2026-09-03", "2026-09-03")).toBe(1);
    // Daylight saving starts in many zones in March; days are still days.
    expect(daysInclusive("2026-03-01", "2026-03-31")).toBe(31);
    expect(daysInclusive("2025-01-01", "2025-12-31")).toBe(365);
  });

  test("months", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-01");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
    expect(monthEnd("2028-02-10")).toBe("2028-02-29");
    expect(monthEnd("2026-02-10")).toBe("2026-02-28");
    expect(monthEnd("2026-12-01")).toBe("2026-12-31");
    expect(addMonthsKeepDay("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsKeepDay("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonthsKeepDay("2026-05-15", -12)).toBe("2025-05-15");
  });

  test("weeks start on the given day", () => {
    // 2026-10-14 is a Wednesday.
    expect(weekStart("2026-10-14", 1)).toBe("2026-10-12");
    expect(weekStart("2026-10-14", 0)).toBe("2026-10-11");
    expect(weekStart("2026-10-12", 1)).toBe("2026-10-12");
    expect(weekdayOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(weekdayOrder(0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("monthGrid lays out every day of the month once, in weekday columns", () => {
    // October 2026 starts on a Thursday and ends on a Saturday.
    const monday = monthGrid("2026-10-01", 1);
    expect(monday[0]).toEqual([
      null,
      null,
      null,
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    expect(monday).toHaveLength(5);
    expect(monday.at(-1)).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      null,
    ]);
    const sunday = monthGrid("2026-10-01", 0);
    expect(sunday[0]).toEqual([null, null, null, null, "2026-10-01", "2026-10-02", "2026-10-03"]);
    const days = sunday.flat().filter((d) => d !== null);
    expect(days).toHaveLength(31);
    expect(new Set(days).size).toBe(31);
  });

  test("localeFirstDay follows the locale and falls back to Monday", () => {
    expect(localeFirstDay("en-US")).toBe(0);
    expect(localeFirstDay("de-DE")).toBe(1);
    expect(localeFirstDay("not a locale!")).toBe(1);
  });

  test("ordered", () => {
    expect(ordered("2026-09-18", "2026-09-03")).toEqual(["2026-09-03", "2026-09-18"]);
    expect(ordered("2026-09-03", "2026-09-18")).toEqual(["2026-09-03", "2026-09-18"]);
  });

  test("presets end no later than today", () => {
    const byId = (today: string) =>
      Object.fromEntries(presets(today, 1).map((p) => [p.id, [p.from, p.to]]));
    expect(byId("2026-10-14")).toEqual({
      "this-week": ["2026-10-12", "2026-10-14"],
      "last-week": ["2026-10-05", "2026-10-11"],
      "this-month": ["2026-10-01", "2026-10-14"],
      "last-month": ["2026-09-01", "2026-09-30"],
      "this-year": ["2026-01-01", "2026-10-14"],
      "last-year": ["2025-01-01", "2025-12-31"],
    });
    // In January, last month is in last year.
    expect(byId("2026-01-05")["last-month"]).toEqual(["2025-12-01", "2025-12-31"]);
    // Last week across the new year.
    expect(byId("2026-01-01")["last-week"]).toEqual(["2025-12-22", "2025-12-28"]);
  });

  test("parseTyped", () => {
    expect(parseTyped("2026-09-03")).toBe("2026-09-03");
    expect(parseTyped(" 2026/9/3 ")).toBe("2026-09-03");
    expect(parseTyped("2026.09.03")).toBe("2026-09-03");
    expect(parseTyped("2026-02-30")).toBeNull();
    expect(parseTyped("09/03/2026")).toBeNull();
    expect(parseTyped("yesterday")).toBeNull();
  });

  test("formatRange", () => {
    expect(formatRange("2026-09-03", "2026-09-18")).toMatch(/Sep.*3.*18.*2026/);
    expect(formatRange("2025-12-28", "2026-01-04")).toMatch(/2025.*2026/);
    expect(formatRange("2026-09-03", "2026-09-03")).not.toMatch(/–/);
  });
});
