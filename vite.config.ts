/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

// The game resources live in assets/: the maps, dialogues and texts of assets/original/ ship with the
// project; the original graphics (tiles, font, pictures, the manifest that announces them), the install's
// PARTY.SAV and the tile packs derived from the original tiles (*-derived) only exist after
// `npm run extract` and are git-ignored. The dev server serves assets/ from the project root; a build copies
// it into dist/ WITHOUT what comes from the original graphics, unless U4_BUNDLE_ORIGINALS=1 (a personal
// build of someone who owns the game: never deploy or publish such a build).
const ORIGINAL_ONLY = ["original/manifest.json", "original/tiles", "original/font", "original/screens", "original/saves/party.sav.json"];
const isOriginalOnly = (rel: string) =>
  ORIGINAL_ONLY.some((p) => rel === p || rel.startsWith(p + "/")) || /^packs\/[^/]+-derived(\/|$)/.test(rel);

function gameAssets(): Plugin {
  let outDir = "dist";
  const bundleOriginals = process.env.U4_BUNDLE_ORIGINALS === "1";
  return {
    name: "u4-game-assets",
    apply: "build",
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    closeBundle() {
      const src = path.resolve("assets");
      fs.cpSync(src, path.join(outDir, "assets"), {
        recursive: true,
        filter: (file) => bundleOriginals || !isOriginalOnly(path.relative(src, file).replace(/\\/g, "/")),
      });
      if (bundleOriginals) this.warn("U4_BUNDLE_ORIGINALS=1: dist/ holds the original graphics, keep this build to yourself");
    },
  };
}

export default defineConfig({
  plugins: [gameAssets()],
  clearScreen: false,
  // Cargo build artifacts are locked while compiling; watching them crashes Vite on Windows.
  server: { host: "127.0.0.1", port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/test-output/**"] } },
  build: { target: "es2022", rollupOptions: { output: { manualChunks: { three: ["three"] } } } },
  test: { include: ["tests/**/*.test.ts"] },
});
