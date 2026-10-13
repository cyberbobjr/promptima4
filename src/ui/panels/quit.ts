// Back to the title screen from a game: save first where the game allows it (Q)uit & save: on the overworld or
// in a dungeon), or leave without saving. The page restarts on the title (any ?skipintro is dropped).
import { quitSave } from "../../game/actions";
import type { Game } from "../../game/game";
import { t } from "../../i18n/i18n";
import { h } from "../dom/dom";
import type { Panel } from "../dom/panels";

/** Reloads the page on the title screen. */
function toTitle() {
  const url = new URL(location.href);
  url.searchParams.delete("skipintro");
  location.href = url.toString();
}

/** Q)uit & save is possible here: on the overworld (not in a town) or in a dungeon, at the command prompt. */
const canSave = (g: Game) => !!g.save && g.atPrompt && (g.mode === "dungeon" || (g.mode === "world" && g.save.location === 0));

export function createQuitPanel(g: Game): Panel {
  return {
    id: "quit",
    title: () => t("menu.quit"),
    render(body, ctx) {
      const saving = canSave(g);
      body.append(
        h("p", {}, t("quit.text")),
        h("div", { class: "quit-actions" },
          h("button", {
            type: "button", disabled: !saving, onclick: () => {
              if (!canSave(g)) return;
              ctx.close();
              g.runAtPrompt(async () => { await quitSave(g); toTitle(); });
            },
          }, t("quit.save")),
          h("button", { type: "button", onclick: toTitle }, t("quit.leave")),
          h("button", { type: "button", onclick: () => ctx.close() }, t("quit.cancel"))));
      if (!saving) body.append(h("p", { class: "quit-note" }, t(g.save ? "quit.cantSave" : "quit.noGame")));
    },
  };
}
