// Settings panel: languages, tile pack, font, controls, debug mode and the (future) LLM provider.
// Every change is saved at once with updateConfig(); the languages, the tile pack and the font are
// read at start-up, so changing them shows a "Reload to apply" button.
import { assets } from "../../assets/store";
import { config, updateConfig, type Config } from "../../config/config";
import type { Game } from "../../game/game";
import { LANGS, t } from "../../i18n/i18n";
import { h } from "../dom/dom";
import type { Panel } from "../dom/panels";
import "./settings.css";

/** Packs the store may hold (it cannot list folders); any other name can be typed. */
const KNOWN_PACKS = ["original", "scale4x-derived", "scale3x-derived", "scale2x-derived"];
const LANG_NAMES: Record<string, string> = { en: "English", fr: "Français" };
const LLM_PROVIDERS = ["anthropic", "openai", "ollama"];

type Opt = { value: string; label: string };

/** Values read at start-up: when they differ from the config, a reload is needed. */
const startup = (c: Config) => JSON.stringify([c.lang.game, c.lang.ui, c.tiles.pack, c.display.font]);

export function createSettingsPanel(g: Game): Panel {
  void g;
  const loaded = startup(config());
  /** Packs found in the store (checked once, in the background). */
  const available = new Map<string, boolean>();

  return {
    id: "settings",
    title: () => t("menu.settings"),
    render(body, ctx) {
      const c = config();
      const save = async (change: Parameters<typeof updateConfig>[0]) => {
        await updateConfig(change);
        ctx.refresh();
      };

      const select = (id: string, value: string, opts: Opt[], onChange: (v: string) => void) =>
        h("select", { id, class: "set-input", onchange: (e) => onChange((e.target as HTMLSelectElement).value) },
          opts.map((o) => h("option", { value: o.value, selected: o.value === value }, o.label)));
      const check = (id: string, value: boolean, onChange: (v: boolean) => void) =>
        h("input", { id, type: "checkbox", class: "set-check", checked: value, onchange: (e) => onChange((e.target as HTMLInputElement).checked) });
      const text = (id: string, value: string, onChange: (v: string) => void, attrs: Record<string, string> = {}) =>
        h("input", { id, class: "set-input", value, spellcheck: "false", autocomplete: "off", ...attrs, onchange: (e) => onChange((e.target as HTMLInputElement).value.trim()) });
      const row = (id: string, label: string, control: HTMLElement, hint?: string) =>
        h("div", { class: "set-row" },
          h("label", { for: id }, label),
          control,
          hint ? h("small", { class: "set-hint" }, hint) : null);
      const section = (title: string, ...rows: (HTMLElement | null)[]) =>
        h("fieldset", { class: "set-section" }, h("legend", {}, title), rows);

      const langs: Opt[] = LANGS.map((l) => ({ value: l, label: LANG_NAMES[l] ?? l }));
      const packs = [...new Set([...KNOWN_PACKS, c.tiles.pack])];
      const packLabel = (p: string) => available.get(p) === false ? `${p} (${t("settings.packMissing")})` : p;
      const modes = (prefix: string, values: string[]): Opt[] => values.map((v) => ({ value: v, label: t(`${prefix}.${v}`) }));

      const needsReload = startup(c) !== loaded;
      body.append(
        needsReload
          ? h("div", { class: "set-reload", role: "status" },
            h("span", {}, t("settings.reloadNeeded")),
            h("button", { class: "set-reload-btn", onclick: () => location.reload() }, t("settings.reload")))
          : "",
        section(t("settings.language"),
          row("set-lang-game", t("settings.langGame"), select("set-lang-game", c.lang.game, langs, (v) => save({ lang: { game: v as Config["lang"]["game"] } }))),
          row("set-lang-ui", t("settings.langUi"), select("set-lang-ui", c.lang.ui, langs, (v) => save({ lang: { ui: v as Config["lang"]["ui"] } })))),
        section(t("settings.display"),
          row("set-pack", t("settings.pack"), select("set-pack", c.tiles.pack, packs.map((p) => ({ value: p, label: packLabel(p) })), (v) => save({ tiles: { pack: v } }))),
          row("set-pack-other", t("settings.packOther"), text("set-pack-other", KNOWN_PACKS.includes(c.tiles.pack) ? "" : c.tiles.pack,
            (v) => { if (v) void save({ tiles: { pack: v } }); }, { placeholder: t("settings.packOtherHint") })),
          row("set-font", t("settings.font"), select("set-font", c.display.font, modes("settings.font", ["auto", "original", "modern"]),
            (v) => save({ display: { font: v as Config["display"]["font"] } })), t("settings.fontHint"))),
        section(t("settings.controls"),
          row("set-bar", t("settings.commandBar"), select("set-bar", c.controls.commandBar, modes("settings.bar", ["auto", "always", "never"]), async (v) => {
            await save({ controls: { commandBar: v as Config["controls"]["commandBar"] } });
            dispatchEvent(new Event("resize")); // the shell re-reads the setting on resize
          })),
          row("set-tap", t("settings.tapToMove"), check("set-tap", c.controls.tapToMove, (v) => save({ controls: { tapToMove: v } })))),
        section(t("settings.sound"),
          row("set-sound", t("settings.soundEnabled"), check("set-sound", c.sound.enabled, (v) => save({ sound: { enabled: v } })), t("settings.soundHint")),
          row("set-volume", t("settings.volume"), h("input", {
            id: "set-volume", type: "range", class: "set-range", min: "0", max: "100", step: "5",
            value: String(Math.round(c.sound.volume * 100)), disabled: !c.sound.enabled,
            onchange: (e) => save({ sound: { volume: Number((e.target as HTMLInputElement).value) / 100 } }),
          }))),
        section(t("settings.debug"),
          row("set-debug", t("settings.debugMode"), check("set-debug", c.debug.enabled, (v) => save({ debug: { enabled: v } })), t("settings.debugHint"))),
        section(t("settings.llm"),
          h("p", { class: "set-note" }, t("settings.llmNotUsed")),
          row("set-llm-provider", t("settings.llmProvider"), select("set-llm-provider", c.llm.provider,
            [...new Set([...LLM_PROVIDERS, c.llm.provider])].map((p) => ({ value: p, label: p })), (v) => save({ llm: { provider: v } }))),
          row("set-llm-model", t("settings.llmModel"), text("set-llm-model", c.llm.model, (v) => save({ llm: { model: v } }))),
          row("set-llm-key", t("settings.llmKey"), text("set-llm-key", c.llm.apiKey, (v) => save({ llm: { apiKey: v } }), { type: "password" }), t("settings.llmKeyHint"))),
      );

      // Mark the packs that are not installed (each checked once; the list is re-rendered when known).
      const unchecked = packs.filter((p) => !available.has(p));
      if (unchecked.length) {
        for (const p of unchecked) available.set(p, true);
        void Promise.all(unchecked.map((p) => assets.tilePack(p).then(() => true, () => false).then((ok) => { available.set(p, ok); })))
          .then(() => { if (body.isConnected && unchecked.some((p) => !available.get(p))) ctx.refresh(); });
      }
    },
  };
}
