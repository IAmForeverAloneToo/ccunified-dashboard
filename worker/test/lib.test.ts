import { describe, expect, test } from "vitest";
import { fetchLatestRelease } from "../src/lib/releases";
import { compareVersions } from "../src/lib/semver";
import { addDays, bucketFor, daysBetween, isValidTimezone, todayIn } from "../src/lib/time";

describe("compareVersions", () => {
  test.each([
    ["1.0.0", "1.0.0", 0],
    ["1.0.1", "1.0.0", 1],
    ["1.2.0", "1.10.0", -1],
    ["v2.0.0", "1.9.9", 1],
    ["1.0.0-rc.1", "1.0.0", -1],
    ["1.0.0-rc.2", "1.0.0-rc.10", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-1", "1.0.0-alpha", -1],
    ["1.0.0+build.5", "1.0.0", 0],
  ])("%s vs %s", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b) ?? Number.NaN)).toBe(sign);
  });

  test("non-release versions are not comparable", () => {
    expect(compareVersions("dev", "1.0.0")).toBeUndefined();
    expect(compareVersions("1.0", "1.0.0")).toBeUndefined();
  });
});

describe("time helpers", () => {
  test("todayIn uses the time zone's calendar date", () => {
    const instant = Date.parse("2026-10-14T02:30:00Z");
    expect(todayIn("UTC", instant)).toBe("2026-10-14");
    expect(todayIn("America/Toronto", instant)).toBe("2026-10-13");
    expect(todayIn("Asia/Tehran", instant)).toBe("2026-10-14");
  });

  test("addDays and daysBetween cross month and year ends", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-10-07", "2026-10-13")).toBe(7);
    expect(daysBetween("2026-10-13", "2026-10-13")).toBe(1);
  });

  test("isValidTimezone", () => {
    expect(isValidTimezone("America/Toronto")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});

describe("fetchLatestRelease", () => {
  const offline = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;

  test("says GitHub couldn't be reached when the network fails", async () => {
    expect(await fetchLatestRelease(offline)).toEqual({ error: "GitHub couldn't be reached" });
  });

  test("tries the releases page when the API can't be reached", async () => {
    const pageOnly = ((url: string) =>
      url.startsWith("https://api.github.com/")
        ? Promise.reject(new TypeError("fetch failed"))
        : Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: "https://github.com/o/r/releases/tag/v1.2.3" },
            }),
          )) as unknown as typeof fetch;
    expect(await fetchLatestRelease(pageOnly)).toEqual({ version: "1.2.3" });
  });
});

describe("bucketFor", () => {
  test.each([
    [1, "day"],
    [92, "day"],
    [93, "week"],
    [365, "week"],
    [731, "week"],
    [732, "month"],
    [3660, "month"],
  ])("%i days: %s", (days, bucket) => {
    expect(bucketFor(days)).toBe(bucket);
  });
});
