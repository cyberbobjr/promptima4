// Web fonts of the 2026 edition (public/fonts, SIL OFL), loaded once on demand: the title screen's logo and
// credit faces, also used by the layered pack for the painted letters of the signs.
export const DISPLAY_FONT = "Pirata One";
export const SCRIPT_FONT = "Dancing Script";

const FONTS: [string, string, FontFaceDescriptors?][] = [
  [DISPLAY_FONT, "fonts/PirataOne-Regular.woff2"],
  [SCRIPT_FONT, "fonts/DancingScript-Bold.woff2", { weight: "700" }],
];
let loaded: Promise<void> | null = null;

/** Resolves when the faces are usable (or failed to load: the fallbacks of the CSS stacks are used then). */
export function loadEditionFonts(): Promise<void> {
  if (typeof document === "undefined" || typeof FontFace === "undefined") return Promise.resolve();
  loaded ??= Promise.all(FONTS.map(async ([family, file, desc]) => {
    try { document.fonts.add(await new FontFace(family, `url(${import.meta.env.BASE_URL}${file})`, desc).load()); }
    catch (e) { console.warn(`font ${family} unavailable`, e); }
  })).then(() => undefined);
  return loaded;
}
