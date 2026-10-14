import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "rehearsal.spec.ts",
  timeout: 5 * 60_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
});
