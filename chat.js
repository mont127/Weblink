// Alkus Web: chat with Alkus in the browser. Sign-in is Google's; every request carries the ID token
// and the server checks it like any other. Conversations are kept in this browser only, separately for
// each account, so that on a shared computer one person does not see another's.
// Everything that comes from the model or the server is placed as text, never as markup.
"use strict";

const SYSTEM = "You are Alkus, an AI assistant. Answer in the language of the user's message. " +
  "Use Markdown where it helps: lists, **bold**, and fenced code blocks for code.";
const EXAMPLES = [
  "Napíš e-mail, že stretnutie presúvame na štvrtok o 10:00",
  "Vysvetli mi jednoducho, ako funguje fotosyntéza",
  "Napíš v Pythone skript, ktorý premenuje fotky podľa dátumu",
  "Naplánuj mi týždeň: škola, šport a oddych",
];

const $ = (id) => document.getElementById(id);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function icon(path) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", path);
  svg.appendChild(p);
  return svg;
}
const ICONS = {
  up: "M7 22V11M2 13v7a2 2 0 0 0 2 2h12.4a2 2 0 0 0 2-1.7l1.4-8A2 2 0 0 0 17.8 10H14V5a3 3 0 0 0-3-3l-4 9",
  down: "M17 2v11M22 11V4a2 2 0 0 0-2-2H7.6a2 2 0 0 0-2 1.7l-1.4 8A2 2 0 0 0 6.2 14H10v5a3 3 0 0 0 3 3l4-9",
  copy: "M8 8h12v12H8zM4 16V4h12",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
};

// --- small storage helpers: storage can be missing (private windows) -------------------------
function load(storage, key, fallback) {
  try { const v = JSON.parse(storage.getItem(key) || "null"); return v === null ? fallback : v; } catch (e) { return fallback; }
}
function keep(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); } catch (e) { /* nothing to do */ }
}

// --- state ------------------------------------------------------------------------------------
let server = null;          // {url, status}
let token = "";             // Google ID token
let email = "";
let chats = [];             // this account's conversations
let current = null;         // the open conversation
let busy = null;            // AbortController of the reply being written

function chatsKey() { return "alkus.chats." + email.toLowerCase(); }

function saveChats() {
  chats = chats.filter((c) => c.messages.length).slice(0, 100);
  if (email) keep(localStorage, chatsKey(), chats);
}

function loadChats() {
  chats = email ? load(localStorage, chatsKey(), []) : [];
  if (!busy) showChat(chats[0] || null);
}

// --- sign-in ------------------------------------------------------------------------------------
function claims(jwt) {
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(part))));
  } catch (e) { return {}; }
}

function restoreToken() {
  const saved = load(sessionStorage, "alkus.signin", null);
  if (saved && saved.token && claims(saved.token).exp * 1000 > Date.now() + 60000) {
    token = saved.token; email = saved.email;
  }
}

function setToken(jwt) {
  const c = claims(jwt);
  const changed = String(c.email || "") !== email;
  token = jwt; email = String(c.email || "");
  keep(sessionStorage, "alkus.signin", { token, email });
  $("account").hidden = false;
  $("account-email").textContent = email;
  if (changed) loadChats();
}

function signOut() {
  token = ""; email = "";
  if (busy) busy.abort();
  chats = [];
  showChat(null);
  try { sessionStorage.removeItem("alkus.signin"); } catch (e) { /* nothing */ }
  if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
  $("account").hidden = true;
  showGate("signin");
}

function loadGoogle(clientId) {
  if (window.google && google.accounts) return setupGoogle(clientId);
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.onload = () => setupGoogle(clientId);
  script.onerror = () => showGate("message", "Prihlasovanie cez Google sa nepodarilo načítať. Skontroluj pripojenie alebo blokovanie reklám.");
  document.head.appendChild(script);
}

function setupGoogle(clientId) {
  google.accounts.id.initialize({
    client_id: clientId, auto_select: true, itp_support: true,
    callback: (response) => { setToken(response.credential); checkAccess(); },
  });
  google.accounts.id.renderButton($("gsi"), { theme: "filled_blue", size: "large", shape: "pill", text: "signin_with", locale: "sk" });
  if (!token) google.accounts.id.prompt();
}

// --- the gate over the composer: sign in, ask for access, or why it is not available ---------
function showGate(kind, text) {
  const gate = $("gate");
  for (const part of gate.querySelectorAll("[data-gate]")) part.hidden = part.dataset.gate !== kind;
  if (text) $("gate-message").textContent = text;
  gate.hidden = !kind;
  $("composer").classList.toggle("locked", Boolean(kind));
}

async function checkAccess() {
  let info;
  try {
    info = await api("GET", "/v1/access");
  } catch (error) {
    return showGate("message", error.message);
  }
  if (info.allowed) return showGate(null);
  $("access-email").textContent = info.email || email;
  const state = info.state;
  $("access-ask").hidden = state === "pending" || (state === "declined" && !canAskAgain(info));
  $("access-state").textContent = state === "pending"
    ? "Tvoja žiadosť čaká na schválenie. Keď ju schvália, stačí obnoviť túto stránku."
    : state === "declined"
      ? "Tvoja žiadosť bola zamietnutá." + (info.ask_again_after ? " Znova môžeš požiadať po " + info.ask_again_after.slice(0, 10) + "." : "")
      : "Účty @lyceum.sk majú prístup hneď. Ostatní môžu požiadať o prístup.";
  showGate("access");
}

function canAskAgain(info) {
  return info.ask_again_after && info.ask_again_after.slice(0, 10) <= new Date().toISOString().slice(0, 10);
}

async function askForAccess(event) {
  event.preventDefault();
  const button = $("access-send");
  button.disabled = true;
  try {
    await api("POST", "/v1/access/request", { reason: $("access-reason").value.trim() });
    await checkAccess();
  } catch (error) {
    $("access-state").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

// --- talking to the server --------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function explain(status, detail) {
  detail = String(detail || "");
  if (status === 401) return "Prihlásenie vypršalo. Prihlás sa znova.";
  if (status === 403 && detail.includes("does not have access")) return "Tento účet zatiaľ nemá prístup k Alkusu.";
  if (status === 403) return "Tento účet nemôže používať Alkus: " + detail;
  if (status === 409) return detail;
  if (status === 413) return "Táto konverzácia je už pre model príliš dlhá. Začni nový chat.";
  if (status === 429) return detail.includes("in progress") ? "Alkus ešte odpovedá na tvoju predchádzajúcu správu." : "Príliš veľa požiadaviek naraz. Skús to o chvíľu.";
  if (status === 503 || status === 502) return "Alkus je práve nedostupný alebo preťažený. Skús to o chvíľu.";
  return "Server odpovedal chybou " + status + (detail ? ": " + detail : ".");
}

async function api(method, path, body) {
  if (!server) throw new ApiError(0, "Alkus je práve nedostupný. Skús to o chvíľu.");
  let response;
  try {
    response = await fetch(server.url + path, {
      method, cache: "no-store",
      headers: Object.assign({ Authorization: "Bearer " + token }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    await reconnect();
    throw new ApiError(0, "Spojenie so serverom sa prerušilo. Skús to znova.");
  }
  if (response.status === 204) return {};
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) signOut();
    throw new ApiError(response.status, explain(response.status, data.detail || data.error));
  }
  return data;
}

async function reconnect() {
  server = await Alkus.findServer(true);
  showState();
}

function showState() {
  const pill = $("state");
  const model = server ? server.status.model : "offline";
  pill.textContent = { online: "online", waking: "prebúdza sa", offline: "offline" }[model] || model;
  pill.className = "pill " + (model === "online" ? "on" : model === "waking" ? "wait" : "off");
}

// --- markdown, built as elements ---------------------------------------------------------------
const INLINE = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;

function inline(parent, text) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[2] !== undefined) parent.appendChild(el("code", m[2]));
    else if (m[3] !== undefined) inline(parent.appendChild(el("strong")), m[3]);
    else if (m[4] !== undefined) inline(parent.appendChild(el("em")), m[4]);
    else {
      const a = el("a", m[5] !== undefined ? m[5] : m[7]);
      a.href = m[5] !== undefined ? m[6] : m[7];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      parent.appendChild(a);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function codeBlock(code, lang) {
  const wrap = el("div", null, "code");
  const bar = el("div", null, "code-bar");
  bar.appendChild(el("span", lang || "kód"));
  const copy = el("button", "Kopírovať", "code-copy");
  copy.type = "button";
  copy.addEventListener("click", () => copyText(code, copy, "Kopírovať"));
  bar.appendChild(copy);
  wrap.appendChild(bar);
  const pre = el("pre");
  pre.appendChild(el("code", code));
  wrap.appendChild(pre);
  return wrap;
}

function markdown(text, into) {
  into.replaceChildren();
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const lang = line.trim().slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      into.appendChild(codeBlock(code.join("\n"), lang));
    } else if (/^#{1,6}\s/.test(line)) {
      const level = Math.min(line.match(/^#+/)[0].length + 1, 6);
      inline(into.appendChild(el("h" + level)), line.replace(/^#+\s*/, ""));
      i++;
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const list = into.appendChild(el(ordered ? "ol" : "ul"));
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && /^\s*\d/.test(lines[i]) === ordered) {
        inline(list.appendChild(el("li")), lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
        i++;
      }
    } else if (/^>\s?/.test(line)) {
      const quote = into.appendChild(el("blockquote"));
      const parts = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) parts.push(lines[i++].replace(/^>\s?/, ""));
      inline(quote, parts.join(" "));
    } else if (/^\s*([-*_]\s*){3,}$/.test(line)) {
      into.appendChild(el("hr"));
      i++;
    } else if (!line.trim()) {
      i++;
    } else {
      const p = into.appendChild(el("p"));
      let first = true;
      while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|([-*+]|\d+[.)])\s+|>)/.test(lines[i])) {
        if (!first) p.appendChild(el("br"));
        inline(p, lines[i++]);
        first = false;
      }
    }
  }
}

function copyText(text, button, label) {
  const done = () => { button.textContent = "Skopírované"; setTimeout(() => { button.textContent = label; }, 1500); };
  try { navigator.clipboard.writeText(text).then(done, () => {}); } catch (e) { /* nothing */ }
}

// --- the conversation on screen -----------------------------------------------------------------
function scrollDown(force) {
  const box = $("scroll");
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}

function userBubble(text) {
  const row = el("div", null, "msg user");
  row.appendChild(el("div", text, "bubble"));
  $("thread").appendChild(row);
  return row;
}

function answerBubble() {
  const row = el("div", null, "msg alkus");
  const avatar = el("img", null, "avatar");
  avatar.src = "assets/alkus-logo.svg";
  avatar.alt = "";
  row.appendChild(avatar);
  const body = el("div", null, "body");
  const thinking = el("details", null, "thinking");
  thinking.hidden = true;
  thinking.appendChild(el("summary", "Premýšľanie"));
  const thoughts = el("div", null, "thoughts");
  thinking.appendChild(thoughts);
  body.appendChild(thinking);
  const status = el("div", "Alkus premýšľa…", "status");
  body.appendChild(status);
  const content = el("div", null, "content");
  body.appendChild(content);
  row.appendChild(body);
  $("thread").appendChild(row);
  return { row, body, thinking, thoughts, status, content };
}

function answerActions(view, message, request) {
  const bar = el("div", null, "actions");
  const copy = el("button", null, "act");
  copy.type = "button";
  copy.title = "Kopírovať odpoveď";
  copy.appendChild(icon(ICONS.copy));
  copy.addEventListener("click", () => copyText(message.content, copy, ""));
  bar.appendChild(copy);
  for (const [rating, path, title] of [["good", ICONS.up, "Dobrá odpoveď"], ["bad", ICONS.down, "Zlá odpoveď"]]) {
    const button = el("button", null, "act" + (message.rated === rating ? " chosen" : ""));
    button.type = "button";
    button.title = title;
    button.appendChild(icon(path));
    button.addEventListener("click", async () => {
      if (message.rated) return;
      message.rated = rating;
      button.classList.add("chosen");
      saveChats();
      try {
        await api("POST", "/v1/feedback", { rating, request, answer: message.content, steps: [], client: "web" });
        thanks.textContent = "Ďakujeme za spätnú väzbu.";
      } catch (error) {
        message.rated = null;
        button.classList.remove("chosen");
        thanks.textContent = error.message;
      }
    });
    bar.appendChild(button);
  }
  const thanks = el("span", "", "thanks");
  bar.appendChild(thanks);
  view.body.appendChild(bar);
}

function showChat(chat) {
  current = chat;
  $("thread").replaceChildren();
  $("welcome").hidden = Boolean(chat && chat.messages.length);
  $("chat-title").textContent = chat && chat.title ? chat.title : "Nový chat";
  let request = "";
  for (const message of chat ? chat.messages : []) {
    if (message.role === "user") {
      userBubble(message.content);
      request = message.content;
    } else {
      const view = answerBubble();
      view.status.hidden = true;
      if (message.reasoning) { view.thinking.hidden = false; view.thoughts.textContent = message.reasoning; }
      markdown(message.content, view.content);
      if (message.note) view.body.appendChild(el("div", message.note, "note"));
      answerActions(view, message, request);
    }
  }
  listChats();
  scrollDown(true);
  document.body.classList.remove("side-open");
}

function listChats() {
  const nav = $("chats");
  nav.replaceChildren(...chats.map((chat) => {
    const row = el("div", null, "chat-row" + (chat === current ? " open" : ""));
    const open = el("button", chat.title || "Nový chat", "chat-open");
    open.type = "button";
    open.addEventListener("click", () => { if (!busy) showChat(chat); });
    const remove = el("button", null, "chat-del");
    remove.type = "button";
    remove.title = "Vymazať konverzáciu";
    remove.appendChild(icon(ICONS.trash));
    remove.addEventListener("click", () => {
      if (busy && chat === current) return;
      chats = chats.filter((c) => c !== chat);
      saveChats();
      if (chat === current) newChat(); else listChats();
    });
    row.appendChild(open);
    row.appendChild(remove);
    return row;
  }));
}

function newChat() {
  if (busy) return;
  showChat({ id: Date.now().toString(36), title: "", messages: [], updated: Date.now() });
  $("input").focus();
}

// --- sending a message and reading the streamed answer ------------------------------------------
async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  if (!token) { showGate("signin"); return; }
  if (!current) newChat();
  const chat = current;
  if (!chats.includes(chat)) chats.unshift(chat);
  if (!chat.title) chat.title = text.replace(/\s+/g, " ").slice(0, 60);
  chat.messages.push({ role: "user", content: text });
  chat.updated = Date.now();
  saveChats();
  $("welcome").hidden = true;
  userBubble(text);
  $("chat-title").textContent = chat.title;
  listChats();
  scrollDown(true);

  const message = { role: "assistant", content: "", reasoning: "" };
  const view = answerBubble();
  busy = new AbortController();
  setBusy(true);
  let finished = false;
  let drawn = 0;
  const draw = () => {
    if (drawn) return;
    drawn = requestAnimationFrame(() => {
      drawn = 0;
      if (message.reasoning) { view.thinking.hidden = false; view.thoughts.textContent = message.reasoning; }
      if (message.content) { view.status.hidden = true; markdown(message.content, view.content); }
      scrollDown(false);
    });
  };
  try {
    const history = chat.messages.slice(0, -1).filter((m) => m.content).map((m) => ({ role: m.role, content: m.content }));
    const response = await fetch(server.url + "/v1/chat/completions", {
      method: "POST", cache: "no-store", signal: busy.signal,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "system", content: SYSTEM }, ...history, { role: "user", content: text }] }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) signOut();
      if (response.status === 403 && String(data.detail).includes("does not have access")) checkAccess();
      throw new ApiError(response.status, explain(response.status, data.detail || data.error));
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut).replace(/\r$/, "");
        buffer = buffer.slice(cut + 1);
        if (line.startsWith(": queue position=")) {
          const position = parseInt(line.split("=")[1], 10);
          view.status.textContent = position > 0 ? "Čakáš v poradí, si " + position + ". na rade…" : "Alkus premýšľa…";
        } else if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") { finished = true; continue; }
          const event = JSON.parse(data);
          if (event.error) throw new ApiError(Number(event.error.code) || 500, explain(Number(event.error.code) || 500, event.error.message));
          for (const choice of event.choices || []) {
            const delta = choice.delta || {};
            if (delta.reasoning_content) message.reasoning += delta.reasoning_content;
            if (delta.content) message.content += delta.content;
          }
          draw();
        }
      }
    }
    if (!finished) throw new ApiError(502, "Odpoveď sa cestou prerušila.");
  } catch (error) {
    if (error.name === "AbortError") message.note = "Zastavené.";
    else if (error instanceof ApiError) message.note = error.message;
    else { message.note = "Spojenie sa prerušilo. Skús to znova."; reconnect(); }
  } finally {
    busy = null;
    setBusy(false);
  }
  cancelAnimationFrame(drawn);
  drawn = 0;
  view.status.hidden = true;
  if (message.reasoning) { view.thinking.hidden = false; view.thoughts.textContent = message.reasoning; }
  markdown(message.content, view.content);
  if (message.note) view.body.appendChild(el("div", message.note, "note"));
  if (message.content) {
    chat.messages.push(message);
    answerActions(view, message, text);
  } else {
    chat.messages.pop();  // never answered: the message goes back into the box
    $("input").value = text;
    autosize();
  }
  chat.updated = Date.now();
  saveChats();
  listChats();
  scrollDown(false);
}

function setBusy(on) {
  $("send").hidden = on;
  $("stop").hidden = !on;
  $("new-chat").disabled = on;
}

// --- the composer -------------------------------------------------------------------------------
function autosize() {
  const box = $("input");
  box.style.height = "auto";
  box.style.height = Math.min(box.scrollHeight, 220) + "px";
}

function submit(event) {
  if (event) event.preventDefault();
  const box = $("input");
  const text = box.value;
  if (!text.trim() || busy) return;
  box.value = "";
  autosize();
  send(text);
}

function start() {
  restoreToken();
  if (token) { $("account").hidden = false; $("account-email").textContent = email; }
  for (const example of EXAMPLES) {
    const button = el("button", example, "example");
    button.type = "button";
    button.addEventListener("click", () => { $("input").value = example; autosize(); $("input").focus(); });
    $("examples").appendChild(button);
  }
  $("composer").addEventListener("submit", submit);
  $("input").addEventListener("input", autosize);
  $("input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) submit(event);
  });
  $("stop").addEventListener("click", () => busy && busy.abort());
  $("new-chat").addEventListener("click", newChat);
  $("sign-out").addEventListener("click", signOut);
  $("access-form").addEventListener("submit", askForAccess);
  $("menu").addEventListener("click", () => document.body.classList.toggle("side-open"));
  document.querySelector(".shade").addEventListener("click", () => document.body.classList.remove("side-open"));
  // A message brought from the home page: chat.html#q=...
  const asked = new URLSearchParams(location.hash.slice(1)).get("q");
  if (asked) { $("input").value = asked.slice(0, 4000); history.replaceState(null, "", location.pathname + location.search); }
  chats = email ? load(localStorage, chatsKey(), []) : [];
  showChat(chats[0] && !asked ? chats[0] : null);
  if (asked) { current = { id: Date.now().toString(36), title: "", messages: [], updated: Date.now() }; }
  autosize();
  connect();
}

async function connect() {
  $("state").textContent = "pripája sa";
  server = await Alkus.findServer(false);
  showState();
  if (!server) return showGate("message", "Alkus je práve nedostupný (server sa možno reštartuje). Skús obnoviť stránku o chvíľu.");
  let config = {};
  try { config = await (await fetch(server.url + "/v1/auth/config", { cache: "no-store" })).json(); } catch (e) { /* below */ }
  // For trying the site on this computer: a token for the test server, ?token=...
  const testToken = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? new URLSearchParams(location.search).get("token") : null;
  if (testToken) { setToken(testToken); return checkAccess(); }
  if (!config.web_client_id) {
    return showGate("message", "Prihlasovanie do webového chatu sa ešte pripravuje. Zatiaľ môžeš Alkusa používať v termináli cez AlkusCode.");
  }
  if (token) checkAccess(); else showGate("signin");
  loadGoogle(config.web_client_id);
  setInterval(async () => {  // keep the status current
    try { server.status = await (await fetch(server.url + "/status", { cache: "no-store" })).json(); showState(); } catch (e) { reconnect(); }
  }, 60000);
}

start();
