import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 5 * 60_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  projects: [
    // The full rehearsal starts its own browser (it needs a proxy set at launch).
    { name: "rehearsal", testMatch: "rehearsal.spec.ts" },
    {
      name: "chrome",
      testMatch: "dashboard.spec.ts",
      use: { browserName: "chromium", channel: "chrome" },
    },
    { name: "firefox", testMatch: "dashboard.spec.ts", use: { browserName: "firefox" } },
  ],
});
