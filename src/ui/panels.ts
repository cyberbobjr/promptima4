// The panels of the HTML interface and their menu entries / function keys.
import { config } from "../config/config";
import type { Game } from "../game/game";
import { installJournal } from "../game/journal";
import type { Shell } from "./dom/shell";
import { createDebugPanel } from "./panels/debug";
import { createHelpPanel } from "./panels/help";
import { createInventoryPanel } from "./panels/inventory";
import { createSettingsPanel } from "./panels/settings";
import { createWorldmapPanel } from "./panels/worldmap";
import { createQuitPanel } from "./panels/quit";

export function installPanels(shell: Shell, g: Game): void {
  installJournal(g); // discovered places (world map), saved in EXTRA.json
  shell.addPanel(() => createInventoryPanel(g), { key: "F2" });
  shell.addPanel(() => createWorldmapPanel(g), { key: "F3" });
  shell.addPanel(() => createHelpPanel(g), { key: "F1" });
  shell.addPanel(() => createSettingsPanel(g), { key: "F10" });
  shell.addPanel(() => createQuitPanel(g), { key: "F9", visible: () => !!g.save });
  shell.addPanel(() => createDebugPanel(g), { key: "F12", visible: () => config().debug.enabled });
}
