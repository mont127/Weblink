// Finds the Alkus server. Its address changes whenever the server restarts; the server publishes
// the current one in this repository (address.txt), which is where this site is served from.
"use strict";

const Alkus = (() => {
  const REPO = "mont127/Weblink";
  const SOURCES = [
    "https://api.github.com/repos/" + REPO + "/contents/address.txt",  // the freshest copy
    "https://raw.githubusercontent.com/" + REPO + "/main/address.txt",
    "address.txt",
  ];
  const ADDRESS = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
  const LOCAL = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  const CACHE_KEY = "alkus.server";
  const CACHE_MS = 10 * 60 * 1000;

  function timeout(ms) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  }

  async function status(url) {
    const response = await fetch(url + "/status", { cache: "no-store", signal: timeout(8000) });
    const body = await response.json();
    if (!body || !("model" in body)) throw new Error("not an Alkus server");
    return body;
  }

  async function published() {
    for (const source of SOURCES) {
      try {
        const response = await fetch(source, {
          cache: "no-store", signal: timeout(8000), headers: { Accept: "application/vnd.github.raw+json" },
        });
        if (!response.ok) continue;
        const url = (await response.text()).split("\n")[0].trim();
        if (ADDRESS.test(url)) return url;
      } catch (error) { /* try the next copy */ }
    }
    return "";
  }

  // Returns {url, status}, or null if the server cannot be reached right now.
  async function findServer(fresh) {
    // For trying the site on this computer: ?server=http://127.0.0.1:port
    const override = LOCAL ? new URLSearchParams(location.search).get("server") : null;
    if (override) {
      try { return { url: override.replace(/\/$/, ""), status: await status(override.replace(/\/$/, "")) }; } catch (e) { return null; }
    }
    if (!fresh) {
      try {
        const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
        if (cached && Date.now() - cached.at < CACHE_MS && ADDRESS.test(cached.url)) {
          return { url: cached.url, status: await status(cached.url) };
        }
      } catch (error) { /* look it up again */ }
    }
    const url = await published();
    if (!url) return null;
    try {
      const found = { url, status: await status(url) };
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ url, at: Date.now() })); } catch (e) { /* private mode */ }
      return found;
    } catch (error) {
      return null;
    }
  }

  return { findServer };
})();
