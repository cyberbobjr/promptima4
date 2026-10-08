import { loadAssets } from "./render/assets";
import { Renderer } from "./render/renderer";
import { Game } from "./game/game";
import { Input } from "./game/input";
import { runIntro } from "./game/intro";
import { installMagic } from "./game/magic";
import { installItems } from "./game/items";
import { setSeed } from "./game/rng";
import { advanceClock, useManualClock } from "./game/clock";
import { assets as store } from "./assets/store";
import { loadGameLang, setUiLang, t } from "./i18n/i18n";
import { MODERN_FONT, type FontMode } from "./render/renderer";
import "./data/all-texts";
import { MSG_CORE } from "./game/texts/core";
import { loadConfig } from "./config/config";
import { createShell } from "./ui/dom/shell";
import { installPanels } from "./ui/panels";
import { installPointer } from "./ui/dom/pointer";
import * as speaker from "./audio/speaker";
import "./pwa";

async function main() {
  const canvas = document.getElementById("screen") as HTMLCanvasElement;
  const cfg = await loadConfig();
  setUiLang(cfg.lang.ui);
  if (!(await store.manifest())) throw new Error(t("app.notExtracted", { dir: "C:\\Program Files\\GOG Galaxy\\Games\\Ultima 4" }));
  await loadGameLang(store, cfg.lang.game);
  const assets = await loadAssets(new URLSearchParams(location.search).get("pack") ?? cfg.tiles.pack);
  const renderer = new Renderer(canvas, assets);
  // "auto": the original font for English with the original tiles, the modern one otherwise (accents, HD)
  const font: FontMode = cfg.display.font !== "auto" ? cfg.display.font
    : cfg.lang.game === "en" && cfg.lang.ui === "en" && cfg.tiles.pack === "original" ? "original" : "modern";
  if (font === "modern") {
    const face = new FontFace(MODERN_FONT, `url(${import.meta.env.BASE_URL}fonts/PressStart2P-Regular.ttf)`);
    document.fonts.add(await face.load());
  }
  renderer.setFont(font);
  speaker.initSpeaker(); // the AudioContext starts on the first user gesture
  const game = new Game(renderer, new Input());
  const shell = createShell(canvas, game);
  installPanels(shell, game);
  installPointer(shell, game);
  renderer.resize();
  if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game; // used by automated tests
  if (import.meta.env.DEV) (window as unknown as { __speaker: typeof speaker }).__speaker = speaker;
  installMagic(game);
  installItems(game);

  const loop = () => {
    requestAnimationFrame(loop);
    try {
      game.draw();
      renderer.render();
    } catch (e) {
      console.error(e);
    }
  };
  requestAnimationFrame(loop);
  // Dev/tests: ?seed=N seeds the RNG and hands the 250 ms clock to the test driver (window.__tick).
  const seed = import.meta.env.DEV ? new URLSearchParams(location.search).get("seed") : null;
  if (seed !== null) {
    setSeed(Number(seed));
    useManualClock();
    (window as unknown as { __tick: (n?: number) => void }).__tick = (n = 1) => { for (let i = 0; i < n; i++) { game.tick(); advanceClock(250); } };
  } else setInterval(() => game.tick(), 250);

  // Dev shortcut for automated tests: ?skipintro starts directly from the original PARTY.SAV.
  const save = import.meta.env.DEV && location.search.includes("skipintro")
    ? (await store.originalSave() ?? await store.newParty())
    : await runIntro(game);
  if (save.members === 0) { save.members = 1; save.players[0].name ||= MSG_CORE.defaultName; }
  await game.start(save);
}

main().catch((e) => {
  document.body.innerHTML = `<pre style="color:#f55;font:14px monospace;padding:1em">${String(e?.stack ?? e)}</pre>`;
});
