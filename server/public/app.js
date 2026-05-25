const SYMBOLS = ["cross", "t", "circle", "diamond", "triangle"];
const SYMBOL_NAMES = {
  cross: "Croix",
  t: "T",
  circle: "Rond",
  diamond: "Losange",
  triangle: "Triangle"
};
const DEFAULT_ROOM = "ura-helper";
const DEFAULT_AUTO_CLEAR_MS = 20_000;
const HTTP_FALLBACK_POLL_MS = 750;
const HTTP_FALLBACK_PENDING_POLL_MS = 250;
const WS_STATE_ACK_TIMEOUT_MS = 900;
const ACTION_ACK_FALLBACK_MS = 550;

const params = new URLSearchParams(window.location.search);
const view = normalizeView(params.get("view"));
const mode = view === "palette" ? "leader" : normalizeMode(params.get("mode") || params.get("role"));
const room = normalizeRoom(params.get("room")) || DEFAULT_ROOM;
const relayUrl = getRelayUrl(params.get("relay"));
const shouldResetOnJoin = mode === "leader" && params.get("reset") === "1";
const sourceId = createSourceId();

window.__uraHandlesDesktopBridge = true;

if (view !== "page") {
  document.body.innerHTML = createCompactMarkup(view);
}

document.body.classList.add(view === "overlay" ? "overlay-body" : view === "palette" ? "palette-body" : "viewer-body");

const elements = {
  clearSequence: document.getElementById("clear-sequence"),
  expiryFill: document.getElementById("expiry-fill"),
  expiryTrack: document.getElementById("expiry-track"),
  leaderControls: document.getElementById("leader-controls"),
  leaderMode: document.getElementById("leader-mode"),
  modeCopy: document.getElementById("mode-copy"),
  modeEyebrow: document.getElementById("mode-eyebrow"),
  sequence: document.getElementById("sequence"),
  symbolActions: document.getElementById("symbol-actions"),
  statusPill: document.getElementById("status-pill"),
  statusText: document.getElementById("status-text"),
  viewerMode: document.getElementById("viewer-mode")
};

const state = {
  autoClearMs: DEFAULT_AUTO_CLEAR_MS,
  connected: false,
  expiresAt: null,
  pendingSourceRevision: 0,
  revision: 0,
  sequence: []
};

let didResetOnJoin = false;
let eventSource = null;
let eventSourceConnected = false;
let expiryTimer = null;
let fallbackPollInFlight = false;
let fallbackPollTimer = null;
let httpActionKeysInFlight = new Set();
let localSourceRevision = 0;
let pendingActions = [];
let reconnectTimer = null;
let socket = null;
let webSocketConfirmed = false;
let webSocketStateTimer = null;

document.title = `Ura Helper Web - ${mode === "leader" ? "Leader" : "Viewer"}`;

configureModeUi();
renderSequence();
renderLeaderControls();
syncExpiryBar();
setStatus("Connexion au relais...", "pending");
connectRelay();

if (shouldResetOnJoin) {
  window.setTimeout(resetLeaderStateOnce, 250);
}

function createCompactMarkup(targetView) {
  if (targetView === "palette") {
    return `
      <main class="palette-stage">
        <nav class="leader-palette" id="leader-controls" aria-label="Symboles leader">
          <span class="drag-grip" aria-hidden="true">${dragGripSvg()}</span>
          <div class="symbol-actions" id="symbol-actions"></div>
          <button class="clear-button icon-clear-button" id="clear-sequence" type="button" title="Effacer" aria-label="Effacer la sequence">
            ${resetSvg()}
          </button>
        </nav>
      </main>
    `;
  }

  return `
    <main class="sequence-stage">
      <section class="sequence-panel is-empty" aria-label="Sequence">
        <div class="sequence-row">
          <span class="drag-grip" aria-hidden="true">${dragGripSvg()}</span>
          <ol class="symbol-sequence overlay" id="sequence" aria-label="Sequence de symboles"></ol>
        </div>
        <div class="expiry-track is-hidden" id="expiry-track" aria-hidden="true">
          <span class="expiry-fill" id="expiry-fill"></span>
        </div>
      </section>
    </main>
  `;
}

function configureModeUi() {
  if (view === "page") {
    elements.modeEyebrow.textContent = mode === "leader" ? "Leader Web" : "Viewer Web";
    elements.modeCopy.textContent = mode === "leader"
      ? "Pilote la sequence depuis le navigateur et synchronise les viewers en direct."
      : "Consulte la sequence en direct depuis une simple URL, sans installer le client lourd.";

    elements.leaderControls.classList.toggle("is-hidden", mode !== "leader");
    elements.viewerMode.classList.toggle("is-active", mode === "viewer");
    elements.leaderMode.classList.toggle("is-active", mode === "leader");
    elements.viewerMode.setAttribute("aria-pressed", String(mode === "viewer"));
    elements.leaderMode.setAttribute("aria-pressed", String(mode === "leader"));

    elements.viewerMode.addEventListener("click", () => switchMode("viewer"));
    elements.leaderMode.addEventListener("click", () => switchMode("leader"));
  }

  if (elements.clearSequence) {
    elements.clearSequence.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      clearLeaderSequence();
    });
  }
}

function connectRelay() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  try {
    socket = new WebSocket(relayUrl);
  } catch (error) {
    setStatus(`Relais invalide: ${error.message}`, "error");
    startHttpFallback();
    return;
  }

  socket.addEventListener("open", () => {
    webSocketConfirmed = false;
    state.connected = false;
    setStatus("Connexion au salon...", "pending");
    sendSocketMessage({ type: "join", role: mode === "leader" ? "leader" : "reader", room });
    scheduleWebSocketStateTimeout();
    resetLeaderStateOnce();
    flushPendingActions();
  });

  socket.addEventListener("message", (event) => {
    handleMessage(event.data);
  });

  socket.addEventListener("close", () => {
    clearWebSocketStateTimeout();
    webSocketConfirmed = false;
    state.connected = false;
    setStatus("WebSocket deconnecte. Relais HTTP actif...", "pending");
    startHttpFallback();
    reconnectTimer = window.setTimeout(connectRelay, 2000);
  });

  socket.addEventListener("error", () => {
    if (!state.connected) {
      clearWebSocketStateTimeout();
      webSocketConfirmed = false;
      setStatus("WebSocket indisponible. Relais HTTP actif...", "pending");
      startHttpFallback();
    }
  });
}

function handleMessage(rawMessage) {
  let message = null;

  try {
    message = JSON.parse(rawMessage);
  } catch (_error) {
    return;
  }

  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "error" && typeof message.message === "string") {
    setStatus(message.message, "error");
    return;
  }

  if (message.type !== "state") {
    return;
  }

  confirmWebSocketState();
  applyStateMessage(message);
}

function applyStateMessage(message) {
  const revision = normalizeRevision(message.revision);
  if (revision && state.revision && revision < state.revision) {
    return;
  }

  if (isOlderThanPendingPublish(message)) {
    return;
  }

  if (revision) {
    state.revision = revision;
  }

  acknowledgePublish(message);

  state.sequence = filterSequence(message.sequence);
  state.expiresAt = Number.isFinite(message.expiresAt) ? message.expiresAt : null;
  state.autoClearMs = Number.isFinite(message.autoClearMs) ? message.autoClearMs : DEFAULT_AUTO_CLEAR_MS;

  renderSequence();
  renderLeaderControls();
  syncExpiryBar();
}

function renderSequence() {
  if (!elements.sequence) {
    return;
  }

  elements.sequence.innerHTML = SYMBOLS.map((_symbol, reverseIndex) => {
    const index = SYMBOLS.length - 1 - reverseIndex;
    const selected = state.sequence[index];

    return `
      <li class="sequence-slot ${selected ? "is-filled" : "is-empty"}">
        ${selected ? symbolSvg(selected) : ""}
      </li>
    `;
  }).join("");

  const sequencePanel = document.querySelector(".sequence-panel");
  if (sequencePanel) {
    sequencePanel.classList.toggle("is-active", state.sequence.length > 0);
    sequencePanel.classList.toggle("is-empty", state.sequence.length === 0);
  }
}

function renderLeaderControls() {
  if (mode !== "leader" || !elements.symbolActions) {
    return;
  }

  elements.symbolActions.innerHTML = SYMBOLS.map((symbol) => {
    const selected = state.sequence.includes(symbol);

    return `
      <button class="symbol-button ${selected ? "is-selected" : ""}" data-symbol="${symbol}" type="button" aria-label="${SYMBOL_NAMES[symbol]}">
        ${symbolSvg(symbol)}
      </button>
    `;
  }).join("");

  for (const button of elements.symbolActions.querySelectorAll("[data-symbol]")) {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      handleLeaderSymbol(button.dataset.symbol);
    });
  }

  if (elements.clearSequence) {
    elements.clearSequence.disabled = false;
  }
}

function handleLeaderSymbol(symbol) {
  if (mode !== "leader") {
    return;
  }

  if (!SYMBOLS.includes(symbol)) {
    return;
  }

  if (!state.sequence.includes(symbol) && state.sequence.length < SYMBOLS.length) {
    const nextSequence = [...state.sequence, symbol];
    if (nextSequence.length === SYMBOLS.length - 1) {
      const lastSymbol = SYMBOLS.find((candidate) => !nextSequence.includes(candidate));
      if (lastSymbol) {
        nextSequence.push(lastSymbol);
      }
    }

    state.sequence = nextSequence;
    state.expiresAt = state.sequence.length === SYMBOLS.length ? Date.now() + DEFAULT_AUTO_CLEAR_MS : null;
    renderSequence();
    renderLeaderControls();
    syncExpiryBar();
  }

  publishLeaderAction("append", { symbol });
}

function clearLeaderSequence() {
  if (mode !== "leader") {
    return;
  }

  state.sequence = [];
  state.expiresAt = null;
  publishLeaderAction("clear");
  renderSequence();
  renderLeaderControls();
  syncExpiryBar();
}

function resetLeaderStateOnce() {
  if (!shouldResetOnJoin || didResetOnJoin || mode !== "leader") {
    return;
  }

  didResetOnJoin = true;
  state.sequence = [];
  state.expiresAt = null;
  publishLeaderAction("clear");
  renderSequence();
  renderLeaderControls();
  syncExpiryBar();
}

function publishLeaderAction(action, extra = {}) {
  const sourceRevision = nextLocalSourceRevision();

  const message = {
    type: "action",
    action,
    room,
    sourceId,
    sourceRevision,
    ...extra,
    autoClearMs: DEFAULT_AUTO_CLEAR_MS
  };

  pendingActions.push(message);
  updatePendingSourceRevision();

  const sentDesktop = sendDesktopLeaderAction(message);
  const sentSocket = sendSocketMessage(message);

  if (!sentSocket) {
    sendHttpLeaderAction(message);
  } else {
    scheduleHttpActionFallback(message);
  }

  if (sentSocket) {
    setStatus(webSocketConfirmed ? "Connecté" : "Attente confirmation relais...", webSocketConfirmed ? "connected" : "pending");
    return;
  }

  if (sentDesktop) {
    setStatus("Bridge Electron envoye, attente du relais...", "pending");
    return;
  }

  setStatus("Action en attente du relais HTTP...", "pending");
}

function sendDesktopLeaderAction(message) {
  if (!window.desktopOverlay || typeof window.desktopOverlay.sendLeaderAction !== "function") {
    return false;
  }

  if (typeof window.desktopOverlay.sendLeaderActionResult === "function") {
    window.desktopOverlay.sendLeaderActionResult(message)
      .then((result) => {
        if (!result || result.ok !== true) {
          sendHttpLeaderAction(message);
        }
      })
      .catch(() => {
        sendHttpLeaderAction(message);
      });
    return true;
  }

  return window.desktopOverlay.sendLeaderAction(message) === true;
}

function syncExpiryBar() {
  clearInterval(expiryTimer);
  expiryTimer = null;

  if (!elements.expiryTrack || !elements.expiryFill) {
    return;
  }

  if (!state.expiresAt) {
    elements.expiryTrack.classList.add("is-hidden");
    elements.expiryFill.style.transform = "scaleX(0)";
    return;
  }

  elements.expiryTrack.classList.remove("is-hidden");
  updateExpiryBar();
  expiryTimer = window.setInterval(updateExpiryBar, 120);
}

function updateExpiryBar() {
  if (!elements.expiryTrack || !elements.expiryFill) {
    clearInterval(expiryTimer);
    expiryTimer = null;
    return;
  }

  if (!state.expiresAt) {
    elements.expiryTrack.classList.add("is-hidden");
    elements.expiryFill.style.transform = "scaleX(0)";
    clearInterval(expiryTimer);
    expiryTimer = null;
    return;
  }

  const remaining = Math.max(0, state.expiresAt - Date.now());
  const progress = Math.min(1, Math.max(0, remaining / Math.max(1, state.autoClearMs)));

  elements.expiryFill.style.transform = `scaleX(${progress})`;

  if (remaining === 0) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }
}

function setStatus(message, variant) {
  if (!elements.statusText || !elements.statusPill) {
    return;
  }

  elements.statusText.textContent = message;
  elements.statusPill.className = "status-pill";

  if (variant === "connected") {
    elements.statusPill.textContent = "Connecté";
    return;
  }

  if (variant === "error") {
    elements.statusPill.classList.add("is-error");
    elements.statusPill.textContent = "Attente";
    return;
  }

  elements.statusPill.classList.add("is-pending");
  elements.statusPill.textContent = "Connexion";
}

function sendSocketMessage(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  socket.send(JSON.stringify(message));
  return true;
}

function scheduleWebSocketStateTimeout() {
  clearWebSocketStateTimeout();
  webSocketStateTimer = window.setTimeout(() => {
    if (!webSocketConfirmed) {
      setStatus("WebSocket sans reponse. Relais temps reel actif...", "pending");
      startHttpFallback();
    }
  }, WS_STATE_ACK_TIMEOUT_MS);
}

function clearWebSocketStateTimeout() {
  clearTimeout(webSocketStateTimer);
  webSocketStateTimer = null;
}

function confirmWebSocketState() {
  webSocketConfirmed = true;
  state.connected = true;
  clearWebSocketStateTimeout();
  stopHttpFallback();
  setStatus("Connecté", "connected");
}

function isWebSocketConfirmedOpen() {
  return webSocketConfirmed && socket && socket.readyState === WebSocket.OPEN;
}

function scheduleHttpActionFallback(message) {
  window.setTimeout(() => {
    if (isActionPending(message)) {
      sendHttpLeaderAction(message);
    }
  }, ACTION_ACK_FALLBACK_MS);
}

function isActionPending(message) {
  return pendingActions.some((action) => {
    return action.sourceId === message.sourceId && normalizeRevision(action.sourceRevision) === normalizeRevision(message.sourceRevision);
  });
}

function startHttpFallback() {
  if (isEventSourceFallbackOpen() || startEventSourceFallback()) {
    return;
  }

  if (fallbackPollTimer || fallbackPollInFlight) {
    return;
  }

  scheduleHttpFallbackPoll(0);
}

function stopHttpFallback() {
  closeEventSourceFallback();
  clearTimeout(fallbackPollTimer);
  fallbackPollTimer = null;
  fallbackPollInFlight = false;
}

function startEventSourceFallback() {
  if (eventSource || typeof EventSource !== "function") {
    return false;
  }

  try {
    eventSource = new EventSource(getRoomEventsUrl());
  } catch (_error) {
    eventSource = null;
    return false;
  }

  eventSource.addEventListener("open", () => {
    eventSourceConnected = true;
    clearTimeout(fallbackPollTimer);
    fallbackPollTimer = null;
    setStatus("Relais temps reel actif (WebSocket indisponible)", "pending");
  });

  eventSource.addEventListener("state", (event) => {
    applyEventStreamState(event.data);
  });

  eventSource.addEventListener("message", (event) => {
    applyEventStreamState(event.data);
  });

  eventSource.addEventListener("error", () => {
    eventSourceConnected = false;
    setStatus("Relais temps reel en reconnexion...", "pending");
    if (!fallbackPollTimer && !fallbackPollInFlight) {
      scheduleHttpFallbackPoll(getHttpFallbackPollDelay());
    }
  });

  return true;
}

function closeEventSourceFallback() {
  if (eventSource) {
    eventSource.close();
  }
  eventSource = null;
  eventSourceConnected = false;
}

function isEventSourceFallbackOpen() {
  return eventSource && eventSource.readyState !== EventSource.CLOSED;
}

function applyEventStreamState(rawMessage) {
  try {
    applyStateMessage(JSON.parse(rawMessage));
    eventSourceConnected = true;
    clearTimeout(fallbackPollTimer);
    fallbackPollTimer = null;
    setStatus("Relais temps reel actif (WebSocket indisponible)", "pending");
  } catch (_error) {
    // Ignore malformed stream frames.
  }
}

function scheduleHttpFallbackPoll(delay = getHttpFallbackPollDelay()) {
  clearTimeout(fallbackPollTimer);
  fallbackPollTimer = window.setTimeout(pollHttpState, delay);
}

async function pollHttpState() {
  fallbackPollTimer = null;

  if (isWebSocketConfirmedOpen() || eventSourceConnected) {
    return;
  }

  if (fallbackPollInFlight) {
    scheduleHttpFallbackPoll();
    return;
  }

  fallbackPollInFlight = true;

  try {
    const response = await fetch(getRoomStateUrl(false), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    applyStateMessage(await response.json());
    setStatus("Relais HTTP actif (WebSocket indisponible)", "pending");
  } catch (error) {
    setStatus(`Relais indisponible: ${error.message}`, "error");
  } finally {
    fallbackPollInFlight = false;
    if (!isWebSocketConfirmedOpen() && !eventSourceConnected) {
      scheduleHttpFallbackPoll();
    }
  }
}

function getHttpFallbackPollDelay() {
  return pendingActions.length > 0 ? HTTP_FALLBACK_PENDING_POLL_MS : HTTP_FALLBACK_POLL_MS;
}

async function sendHttpLeaderAction(message) {
  const actionKey = `${message.sourceId}:${message.sourceRevision}`;
  if (httpActionKeysInFlight.has(actionKey)) {
    return true;
  }

  httpActionKeysInFlight.add(actionKey);
  startHttpFallback();

  try {
    const response = await fetch(getRoomStateUrl(true), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    applyStateMessage(await response.json());
    setStatus(getFallbackStatusMessage(), "pending");
    return true;
  } catch (error) {
    setStatus(`Envoi impossible: ${error.message}`, "error");
    return false;
  } finally {
    httpActionKeysInFlight.delete(actionKey);
  }
}

function getRoomStateUrl(forWrite) {
  const url = new URL(getRelayHttpBaseUrl(relayUrl));
  url.pathname = `/api/rooms/${encodeURIComponent(room)}${forWrite ? "/state" : ""}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function getRelayHttpBaseUrl(value) {
  const url = new URL(value);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function filterSequence(sequence) {
  if (!Array.isArray(sequence)) {
    return [];
  }

  const result = [];
  for (const symbol of sequence) {
    if (SYMBOLS.includes(symbol) && !result.includes(symbol)) {
      result.push(symbol);
    }
  }

  return result.slice(0, SYMBOLS.length);
}

function normalizeRevision(value) {
  const revision = Number(value);
  return Number.isFinite(revision) && revision > 0 ? revision : 0;
}

function nextLocalSourceRevision() {
  localSourceRevision += 1;
  return localSourceRevision;
}

function isOlderThanPendingPublish(message) {
  if (!state.pendingSourceRevision) {
    return false;
  }

  return message.sourceId === sourceId && normalizeRevision(message.sourceRevision) < state.pendingSourceRevision;
}

function acknowledgePublish(message) {
  if (!state.pendingSourceRevision || message.sourceId !== sourceId) {
    return;
  }

  const acknowledgedRevision = normalizeRevision(message.sourceRevision);
  if (!acknowledgedRevision) {
    return;
  }

  pendingActions = pendingActions.filter((action) => normalizeRevision(action.sourceRevision) > acknowledgedRevision);
  updatePendingSourceRevision();
}

function updatePendingSourceRevision() {
  state.pendingSourceRevision = pendingActions.reduce((maxRevision, action) => {
    return Math.max(maxRevision, normalizeRevision(action.sourceRevision));
  }, 0);
}

function flushPendingActions() {
  for (const action of pendingActions) {
    sendDesktopLeaderAction(action);
    if (sendSocketMessage(action)) {
      scheduleHttpActionFallback(action);
    } else {
      sendHttpLeaderAction(action);
    }
  }
}

function createSourceId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  const randomPart = Math.random().toString(36).slice(2);
  return `src-${Date.now().toString(36)}-${randomPart}`;
}

function normalizeRoom(value) {
  const candidate = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_-]{3,48}$/.test(candidate) ? candidate : "";
}

function normalizeMode(value) {
  return value === "leader" ? "leader" : "viewer";
}

function normalizeView(value) {
  if (value === "palette") {
    return "palette";
  }

  if (value === "overlay" || value === "sequence") {
    return "overlay";
  }

  return "page";
}

function switchMode(nextMode) {
  if (view !== "page" || nextMode === mode) {
    return;
  }

  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.delete("role");
  nextUrl.searchParams.delete("reset");
  if (nextMode === "leader") {
    nextUrl.searchParams.set("mode", "leader");
  } else {
    nextUrl.searchParams.delete("mode");
  }

  window.location.assign(nextUrl.toString());
}

function getRelayUrl(overrideValue) {
  const defaultRelayUrl = getDefaultRelayUrl();
  const rawValue = String(overrideValue || "").trim();

  if (!rawValue) {
    return defaultRelayUrl;
  }

  let withScheme = rawValue.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
  if (!/^wss?:\/\//i.test(withScheme)) {
    withScheme = `${window.location.protocol === "https:" ? "wss" : "ws"}://${withScheme}`;
  }

  const url = new URL(withScheme);
  if (url.pathname === "/") {
    url.pathname = "/ws";
  }

  return url.toString().replace(/\/$/, "");
}

function getDefaultRelayUrl() {
  if (!window.location.host) {
    return "ws://127.0.0.1:8787/ws";
  }

  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
}

function symbolSvg(symbol) {
  if (symbol === "cross") {
    return `
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M14 14 34 34M34 14 14 34" />
      </svg>
    `;
  }

  if (symbol === "t") {
    return `
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M13 13h22M24 13v25" />
      </svg>
    `;
  }

  if (symbol === "circle") {
    return `
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="14" />
      </svg>
    `;
  }

  if (symbol === "diamond") {
    return `
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M24 7 41 24 24 41 7 24Z" />
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M24 8 41 39H7Z" />
    </svg>
  `;
}

function resetSvg() {
  return `
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M17 15a13 13 0 1 1-3 14" />
      <path d="M17 15h-8v-8" />
    </svg>
  `;
}

function dragGripSvg() {
  return `
    <svg viewBox="0 0 16 48" aria-hidden="true">
      <path d="M5 12h.01M11 12h.01M5 24h.01M11 24h.01M5 36h.01M11 36h.01" />
    </svg>
  `;
}

function getRoomEventsUrl() {
  const url = new URL(getRelayHttpBaseUrl(relayUrl));
  url.pathname = `/api/rooms/${encodeURIComponent(room)}/events`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function getFallbackStatusMessage() {
  return eventSourceConnected
    ? "Relais temps reel actif (WebSocket indisponible)"
    : "Relais HTTP actif (WebSocket indisponible)";
}