// Installable web app (iPad home screen, Android): registers the service worker of public/sw.js,
// in production builds only (the dev server must always serve fresh modules). Not in Tauri, nor in the itch.io
// build (npm run build:itch: served from a sub-folder of itch's own domain, inside an iframe).
if (import.meta.env.PROD && import.meta.env.MODE !== "itch" && "serviceWorker" in navigator && !("__TAURI_INTERNALS__" in window)) {
  addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((e) => console.warn("service worker:", e));
  });
}

export {};
