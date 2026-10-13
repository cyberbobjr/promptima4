/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

// The game resources are extracted once from the original install (`npm run extract`) into
// assets/original/. The dev server serves them from the project root; a build copies them into
// dist/ when they exist (local builds only: they are derived from the original game).
function extractedAssets(): Plugin {
  let outDir = "dist";
  return {
    name: "u4-extracted-assets",
    apply: "build",
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    closeBundle() {
      const src = path.resolve("assets/original");
      if (!fs.existsSync(path.join(src, "manifest.json"))) {
        this.warn("assets/original/ not found: the build will ask for `npm run extract` at startup");
        return;
      }
      fs.cpSync(src, path.join(outDir, "assets/original"), { recursive: true });
      for (const extra of ["i18n", "packs", "sounds"]) {
        const dir = path.resolve("assets", extra);
        if (fs.existsSync(dir)) fs.cpSync(dir, path.join(outDir, "assets", extra), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [extractedAssets()],
  clearScreen: false,
  // Cargo build artifacts are locked while compiling; watching them crashes Vite on Windows.
  server: { host: "127.0.0.1", port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/test-output/**"] } },
  build: { target: "es2022", rollupOptions: { output: { manualChunks: { three: ["three"] } } } },
  test: { include: ["tests/**/*.test.ts"] },
});
