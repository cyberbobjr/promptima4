// Language of the legal pages: ?lang=, else the game's interface language (its saved settings), else the
// browser's. Each page holds one <article lang="..."> per language and a [data-lang] switch; the links between
// the pages keep the language.
(() => {
  const LANGS = ["en", "fr"];
  const fromUrl = new URLSearchParams(location.search).get("lang");
  let fromGame = null;
  try { fromGame = JSON.parse(localStorage.getItem("u4config") || "null")?.lang?.ui ?? null; } catch { /* no storage */ }
  const fromBrowser = (navigator.language || "en").slice(0, 2);
  const pick = [fromUrl, fromGame, fromBrowser].find((l) => LANGS.includes(l)) || "en";

  function show(lang) {
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll("[lang]:not(html)")) el.hidden = el.lang !== lang;
    for (const b of document.querySelectorAll("[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
    // links between the legal pages keep the language (not the way back to the game: its own setting rules)
    for (const a of document.querySelectorAll("a[href*='.html']")) {
      const url = new URL(a.getAttribute("href"), location.href);
      url.searchParams.set("lang", lang);
      a.href = url.pathname + url.search;
    }
    const t = document.querySelector(`meta[name="title-${lang}"]`);
    if (t) document.title = t.content;
  }
  for (const b of document.querySelectorAll("[data-lang]")) b.addEventListener("click", () => {
    show(b.dataset.lang);
    history.replaceState(null, "", `?lang=${b.dataset.lang}`);
  });
  show(pick);
})();
