import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    // The Worker serves these files; keep them in one predictable folder.
    assetsDir: "assets",
  },
  server: {
    // The dashboard shares the password-hashing code with the Worker.
    fs: { allow: [".."] },
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
