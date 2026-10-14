import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startWorker, type TestWorker } from "./harness";

/** A stand-in for GitHub: its API, and the releases page it redirects from. */
const github = {
  api: (): Response => Response.json({ tag_name: "v0.3.0" }),
  page: (): Response => new Response("not found", { status: 404 }),
  requests: [] as string[],
};
// Miniflare turns any failure of a stand-in into HTTP 500; a real network
// failure is covered in lib.test.ts.
const down = () => new Response("unavailable", { status: 503 });
const redirectTo = (tag: string) => () =>
  new Response(null, {
    status: 302,
    headers: { location: `https://github.com/owner/repo/releases/tag/${tag}` },
  });

let w: TestWorker;
let viewer: { cookie: string };

beforeAll(async () => {
  // A released version: only those check for updates on their own.
  w = await startWorker({
    version: "0.2.0",
    outbound: (request) => {
      const url = new URL(request.url);
      github.requests.push(url.href);
      if (url.hostname === "api.github.com") return github.api();
      if (url.hostname === "github.com") return github.page();
      return new Response("unexpected", { status: 500 });
    },
  });
  viewer = await w.createUser({ role: "viewer", username: "vera" });
});
afterAll(() => w.dispose());

interface SettingsBody {
  server_version: string;
  latest_version: string | null;
  latest_checked_at: number | null;
  latest_check_error: string | null;
}

const settings = async () =>
  (await (await w.fetch("/api/settings", { cookie: viewer.cookie })).json()) as SettingsBody;

async function checkNow(): Promise<SettingsBody> {
  const res = await w.fetch("/api/settings/check-updates", {
    method: "POST",
    cookie: viewer.cookie,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SettingsBody;
}

describe("checking for updates", () => {
  test("opening Settings starts a check in the background; the next visit shows its result", async () => {
    const first = await settings();
    expect(first).toMatchObject({
      server_version: "0.2.0",
      latest_version: "0.2.0",
      latest_checked_at: null,
      latest_check_error: null,
    });
    await expect.poll(async () => (await settings()).latest_checked_at).not.toBeNull();
    const next = await settings();
    expect(next.latest_version).toBe("0.3.0");
    expect(next.latest_check_error).toBeNull();
    expect(Date.now() - (next.latest_checked_at ?? 0)).toBeLessThan(60_000);
  });

  test("Check for updates asks GitHub right away", async () => {
    github.api = () => Response.json({ tag_name: "v0.4.0" });
    const before = github.requests.length;
    const after = await checkNow();
    expect(after).toMatchObject({ latest_version: "0.4.0", latest_check_error: null });
    expect(github.requests.slice(before)).toEqual([
      "https://api.github.com/repos/IAmForeverAloneToo/ccunified-dashboard/releases/latest",
    ]);
    // A recent check isn't repeated just because Settings was opened.
    await settings();
    expect(github.requests.length).toBe(before + 1);
  });

  test("when the API is limited, the releases page answers", async () => {
    github.api = () => new Response("rate limited", { status: 403 });
    github.page = redirectTo("v0.5.0");
    expect(await checkNow()).toMatchObject({ latest_version: "0.5.0", latest_check_error: null });
  });

  test("when GitHub can't be checked, Settings says so and keeps the last known version", async () => {
    github.api = down;
    github.page = down;
    const error = "GitHub answered with an error (HTTP 503)";
    const after = await checkNow();
    expect(after).toMatchObject({ latest_version: "0.5.0", latest_check_error: error });
    expect(after.latest_checked_at).not.toBeNull();
    expect(await settings()).toMatchObject({ latest_check_error: error });

    // Working again: the error is gone.
    github.api = () => Response.json({ tag_name: "v0.5.0" });
    expect(await checkNow()).toMatchObject({ latest_check_error: null });
  });

  test.each([
    [
      "rate limited, and the releases page doesn't help",
      () => new Response("slow down", { status: 429 }),
      () => new Response("blocked", { status: 429 }),
      "GitHub is limiting requests right now",
    ],
    [
      "no releases",
      () => new Response("not found", { status: 404 }),
      redirectTo("v9.9.9"),
      "GitHub has no releases of IAmForeverAloneToo/ccunified-dashboard",
    ],
    [
      "a tag that isn't a version",
      () => Response.json({ tag_name: "nightly" }),
      redirectTo("nightly"),
      "GitHub's answer didn't name a version",
    ],
  ])("explains %s", async (_name, api, page, error) => {
    github.api = api;
    github.page = page;
    expect(await checkNow()).toMatchObject({ latest_check_error: error, latest_version: "0.5.0" });
  });

  test("a dashboard updated from 0.1 checks again, instead of claiming its last check worked", async () => {
    // 0.1 recorded when it checked, but not whether that worked.
    await w.sql("DELETE FROM settings WHERE key = 'latest_check_error'");
    await w.sql(
      "UPDATE settings SET value = ?1 WHERE key = 'latest_checked_at'",
      String(Date.now()),
    );
    github.api = () => Response.json({ tag_name: "v0.6.0" });
    expect((await settings()).latest_checked_at).toBeNull();
    await expect.poll(async () => (await settings()).latest_version).toBe("0.6.0");
    expect((await settings()).latest_check_error).toBeNull();
  });

  test("needs a login, and comes from the dashboard's own pages", async () => {
    expect((await w.fetch("/api/settings/check-updates", { method: "POST" })).status).toBe(401);
    const forged = await w.fetch("/api/settings/check-updates", {
      method: "POST",
      cookie: viewer.cookie,
      headers: { origin: "https://evil.example" },
    });
    expect(forged.status).toBe(403);
  });
});
