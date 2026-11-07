// Register the offline service worker (app shell only; vault data is cached encrypted in localStorage).
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
