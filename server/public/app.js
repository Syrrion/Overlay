const SYMBOLS = ["cross", "t", "circle", "diamond", "triangle"];
const UNKNOWN_SYMBOL = "unknown";
const SYMBOL_ACTIONS = [...SYMBOLS, UNKNOWN_SYMBOL];
const SYMBOL_NAMES = {
  cross: "Croix",
  t: "T",
  circle: "Rond",
  diamond: "Losange",
  triangle: "Triangle",
  unknown: "Caractere inconnu"
};
const DEFAULT_ROOM = "ura-helper";
const DEFAULT_AUTO_CLEAR_MS = 20_000;
const STATE_POLL_MS = 1000;
const PENDING_STATE_POLL_MS = 250;
const MIN_VISIBLE_EXPIRY_PROGRESS = 0.012;

const params = new URLSearchParams(window.location.search);
const view = normalizeView(params.get("view"));
const mode = view === "palette" ? "leader" : normalizeMode(params.get("mode") || params.get("role"));
const room = DEFAULT_ROOM;
const relayBaseUrl = getRelayBaseUrl(params.get("relay"));
const shouldResetOnJoin = mode === "leader" && params.get("reset") === "1";
const clientId = normalizeClientId(params.get("client")) || createSourceId();
const sourceId = clientId;
let leavePresenceSent = false;

enforceCanonicalRoomUrl();

if (view !== "page") {
  document.body.innerHTML = createCompactMarkup(view);
}

document.body.classList.add(view === "overlay" ? "overlay-body" : view === "palette" ? "palette-body" : "viewer-body");

const elements = {
  clearSequence: document.getElementById("clear-sequence"),
  connectedCount: document.getElementById("connected-count"),
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
  connectedClients: 0,
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
let hasRenderedSequence = false;
let lastRenderedSequence = [];
let serverTimeOffset = 0;

document.title = `Ura Helper Web - ${mode === "leader" ? "Leader" : "Viewer"}`;

configureModeUi();
renderSequence();
renderLeaderControls();
renderConnectedCount();
syncExpiryBar();
setStatus("Connexion au relais...", "pending");
registerPresenceLifecycleHandlers();
connectRelay();

if (shouldResetOnJoin) {
  window.setTimeout(resetLeaderStateOnce, 250);
}

function createCompactMarkup(targetView) {
  if (targetView === "palette") {
    return `
      <main class="palette-stage">
        <nav class="leader-palette" id="leader-controls" aria-label="Symboles leader">
          <span class="window-handle">
            <span class="drag-grip" aria-hidden="true">${dragGripSvg()}</span>
          </span>
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
          <span class="window-handle">
            <span class="drag-grip" aria-hidden="true">${dragGripSvg()}</span>
          </span>
          <ol class="symbol-sequence overlay" id="sequence" aria-label="Sequence de symboles"></ol>
        </div>
        <div class="expiry-track is-hidden" id="expiry-track" aria-hidden="true">
          <span class="expiry-fill" id="expiry-fill"></span>
        </div>
      </section>
      <span class="client-count compact-client-count" id="connected-count" title="Connectes" aria-label="0 connecte">0</span>
    </main>
  `;
}

function configureModeUi() {
  if (view === "page") {

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
  startRealtimeRelay();
  resetLeaderStateOnce();
  flushPendingActions();
}

function registerPresenceLifecycleHandlers() {
  window.addEventListener("pagehide", notifyPresenceLeave, { capture: true });
  window.addEventListener("beforeunload", notifyPresenceLeave, { capture: true });
}

function notifyPresenceLeave() {
  if (leavePresenceSent) {
    return;
  }

  leavePresenceSent = true;
  closeEventSourceRelay();

  const payload = JSON.stringify({ action: "leave", clientId });
  const presenceUrl = getRoomPresenceUrl();

  if (navigator.sendBeacon) {
    const body = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon(presenceUrl, body)) {
      return;
    }
  }

  fetch(presenceUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true,
    cache: "no-store"
  }).catch(() => {});
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

  if (Number.isFinite(message.serverTime)) {
    serverTimeOffset = Date.now() - message.serverTime;
  }

  state.sequence = filterSequence(message.sequence);
  state.expiresAt = Number.isFinite(message.expiresAt) ? message.expiresAt : null;
  state.autoClearMs = Number.isFinite(message.autoClearMs) ? message.autoClearMs : DEFAULT_AUTO_CLEAR_MS;
  state.connectedClients = normalizeClientCount(message.connectedClients ?? message.clients);

  renderSequence();
  renderLeaderControls();
  renderConnectedCount();
  syncExpiryBar();
}

function renderSequence() {
  if (!elements.sequence) {
    return;
  }

  const previousSequence = lastRenderedSequence;
  const animateNewSymbols = mode === "viewer" && hasRenderedSequence;
  const animatedSlotIndexes = [];
  elements.sequence.innerHTML = SYMBOLS.map((_symbol, reverseIndex) => {
    const index = SYMBOLS.length - 1 - reverseIndex;
    const selected = state.sequence[index];
    const shouldAnimate = animateNewSymbols && shouldAnimateSequenceSlot(previousSequence[index], selected);
    if (shouldAnimate) {
      animatedSlotIndexes.push(reverseIndex);
    }

    return `
      <li class="sequence-slot ${selected ? "is-filled" : "is-empty"} ${selected === UNKNOWN_SYMBOL ? "is-unknown" : ""}" ${shouldAnimate ? 'data-animate="1"' : ""}>
        ${selected ? symbolSvg(selected) : ""}
      </li>
    `;
  }).join("");

  if (animatedSlotIndexes.length > 0) {
    queueSequenceArrivalAnimations();
  }

  lastRenderedSequence = [...state.sequence];
  hasRenderedSequence = true;

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

  const sequenceDetermined = isCompleteSequence(state.sequence);
  elements.symbolActions.innerHTML = SYMBOL_ACTIONS.map((symbol) => {
    const selected = state.sequence.includes(symbol);
    const disabled = symbol === UNKNOWN_SYMBOL && sequenceDetermined;

    return `
      <button class="symbol-button ${selected ? "is-selected" : ""} ${symbol === UNKNOWN_SYMBOL ? "is-unknown" : ""}" data-symbol="${symbol}" type="button" aria-label="${SYMBOL_NAMES[symbol]}" ${disabled ? "disabled" : ""}>
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

  const token = normalizeSequenceToken(symbol);
  if (!token) {
    return;
  }

  const nextSequence = appendSequenceToken(state.sequence, token);
  if (!nextSequence) {
    return;
  }

  state.sequence = nextSequence;
  state.expiresAt = isCompleteSequence(state.sequence) ? Date.now() - serverTimeOffset + DEFAULT_AUTO_CLEAR_MS : null;
  renderSequence();
  renderLeaderControls();
  syncExpiryBar();
  publishLeaderAction("append", { symbol: token });
}

function renderConnectedCount() {
  if (!elements.connectedCount) {
    return;
  }

  const count = normalizeClientCount(state.connectedClients);
  const label = `${count} connecte${count > 1 ? "s" : ""}`;
  elements.connectedCount.textContent = view === "page" ? label : String(count);
  elements.connectedCount.title = label;
  elements.connectedCount.setAttribute("aria-label", label);
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

  sendHttpLeaderAction(message);
  setStatus("Action envoyee au relais...", "pending");
}

function syncExpiryBar() {
  clearInterval(expiryTimer);
  expiryTimer = null;

  if (!elements.expiryTrack || !elements.expiryFill) {
    return;
  }

  if (!state.expiresAt) {
    hideExpiryBar();
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
    hideExpiryBar();
    clearInterval(expiryTimer);
    expiryTimer = null;
    return;
  }

  const remaining = Math.max(0, state.expiresAt - (Date.now() - serverTimeOffset));
  const progress = Math.min(1, Math.max(0, remaining / Math.max(1, state.autoClearMs)));

  if (progress <= MIN_VISIBLE_EXPIRY_PROGRESS) {
    hideExpiryBar();
    clearInterval(expiryTimer);
    expiryTimer = null;
    return;
  }

  elements.expiryFill.style.transform = `scaleX(${progress})`;
}

function hideExpiryBar() {
  elements.expiryTrack.classList.add("is-hidden");
  elements.expiryFill.style.transform = "scaleX(0)";
}

function setStatus(message, variant) {
  if (!elements.statusPill) {
    return;
  }

  if (elements.statusText) {
    elements.statusText.textContent = message;
  }
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

function startRealtimeRelay() {
  if (isEventSourceRelayOpen() || startEventSourceRelay()) {
    return;
  }

  if (fallbackPollTimer || fallbackPollInFlight) {
    return;
  }

  scheduleHttpFallbackPoll(0);
}

function stopRealtimeRelay() {
  closeEventSourceRelay();
  clearTimeout(fallbackPollTimer);
  fallbackPollTimer = null;
  fallbackPollInFlight = false;
}

function startEventSourceRelay() {
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
    state.connected = true;
    setStatus("Connecté", "connected");
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

function closeEventSourceRelay() {
  if (eventSource) {
    eventSource.close();
  }
  eventSource = null;
  eventSourceConnected = false;
}

function isEventSourceRelayOpen() {
  return eventSource && eventSource.readyState !== EventSource.CLOSED;
}

function applyEventStreamState(rawMessage) {
  try {
    applyStateMessage(JSON.parse(rawMessage));
    eventSourceConnected = true;
    state.connected = true;
    clearTimeout(fallbackPollTimer);
    fallbackPollTimer = null;
    setStatus("Connecté", "connected");
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

  if (eventSourceConnected) {
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
    setStatus("Relais HTTP de secours actif", "pending");
  } catch (error) {
    setStatus(`Relais indisponible: ${error.message}`, "error");
  } finally {
    fallbackPollInFlight = false;
    if (!eventSourceConnected) {
      scheduleHttpFallbackPoll();
    }
  }
}

function getHttpFallbackPollDelay() {
  return pendingActions.length > 0 ? PENDING_STATE_POLL_MS : STATE_POLL_MS;
}

async function sendHttpLeaderAction(message) {
  const actionKey = `${message.sourceId}:${message.sourceRevision}`;
  if (httpActionKeysInFlight.has(actionKey)) {
    return true;
  }

  httpActionKeysInFlight.add(actionKey);
  startRealtimeRelay();

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
  const url = new URL(getRelayHttpBaseUrl(relayBaseUrl));
  url.pathname = `/api/rooms/${encodeURIComponent(room)}${forWrite ? "/state" : ""}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function getRelayHttpBaseUrl(value) {
  const url = new URL(value);
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
    const token = normalizeSequenceToken(symbol);
    if (!token) {
      continue;
    }

    if (token === UNKNOWN_SYMBOL) {
      if (!result.includes(UNKNOWN_SYMBOL)) {
        result.push(token);
      }
      continue;
    }

    if (!result.includes(token)) {
      result.push(token);
    }
  }

  return result.slice(0, SYMBOLS.length);
}

function appendSequenceToken(sequence, token) {
  const nextSequence = filterSequence(sequence);
  if (!token || nextSequence.length >= SYMBOLS.length) {
    return null;
  }

  if (token === UNKNOWN_SYMBOL) {
    if (nextSequence.includes(UNKNOWN_SYMBOL)) {
      return null;
    }

    nextSequence.push(UNKNOWN_SYMBOL);
  } else {
    if (nextSequence.includes(token)) {
      return null;
    }

    nextSequence.push(token);
  }

  return completeDeducedSequence(nextSequence);
}

function completeDeducedSequence(sequence) {
  const nextSequence = filterSequence(sequence);
  const unknownIndex = nextSequence.indexOf(UNKNOWN_SYMBOL);

  if (unknownIndex === -1) {
    if (nextSequence.length === SYMBOLS.length - 1) {
      const missingSymbols = getMissingSymbols(nextSequence);
      if (missingSymbols.length === 1) {
        nextSequence.push(missingSymbols[0]);
      }
    }

    return nextSequence;
  }

  if (nextSequence.length === SYMBOLS.length) {
    const missingSymbols = getMissingSymbols(nextSequence);
    if (missingSymbols.length === 1) {
      nextSequence[unknownIndex] = missingSymbols[0];
    }
  }

  return nextSequence;
}

function getMissingSymbols(sequence) {
  return SYMBOLS.filter((symbol) => !sequence.includes(symbol));
}

function isCompleteSequence(sequence) {
  return sequence.length === SYMBOLS.length && sequence.every((symbol) => SYMBOLS.includes(symbol));
}

function normalizeSequenceToken(value) {
  const token = String(value || "").trim().toLowerCase();
  if (token === UNKNOWN_SYMBOL || token === "?") {
    return UNKNOWN_SYMBOL;
  }

  return SYMBOLS.includes(token) ? token : "";
}

function normalizeClientCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
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
    sendHttpLeaderAction(action);
  }
}

function createSourceId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  const randomPart = Math.random().toString(36).slice(2);
  return `src-${Date.now().toString(36)}-${randomPart}`;
}

function normalizeClientId(value) {
  const clientId = String(value || "").trim();
  return /^[a-z0-9_-]{8,80}$/i.test(clientId) ? clientId : "";
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

function enforceCanonicalRoomUrl() {
  const nextUrl = new URL(window.location.href);
  if (nextUrl.searchParams.get("room") === DEFAULT_ROOM) {
    return;
  }

  nextUrl.searchParams.set("room", DEFAULT_ROOM);
  window.history.replaceState({}, "", nextUrl.toString());
}

function getRelayBaseUrl(overrideValue) {
  const defaultRelayBaseUrl = getDefaultRelayBaseUrl();
  const rawValue = String(overrideValue || "").trim();

  if (!rawValue) {
    return defaultRelayBaseUrl;
  }

  let withScheme = rawValue;
  if (!/^https?:\/\//i.test(withScheme)) {
    withScheme = `${window.location.protocol === "https:" ? "https" : "http"}://${withScheme}`;
  }

  const url = new URL(withScheme);
  url.pathname = "/";
  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/$/, "");
}

function getDefaultRelayBaseUrl() {
  if (!window.location.host) {
    return "http://127.0.0.1:8787";
  }

  return `${window.location.protocol}//${window.location.host}`;
}

function symbolSvg(symbol) {
  if (symbol === UNKNOWN_SYMBOL) {
    return `<span class="unknown-mark" aria-hidden="true">?</span>`;
  }

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
  const url = new URL(getRelayHttpBaseUrl(relayBaseUrl));
  url.pathname = `/api/rooms/${encodeURIComponent(room)}/events`;
  url.search = "";
  url.searchParams.set("client", clientId);
  url.hash = "";
  return url.toString();
}

function getRoomPresenceUrl() {
  const url = new URL(getRelayHttpBaseUrl(relayBaseUrl));
  url.pathname = `/api/rooms/${encodeURIComponent(room)}/presence`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function getFallbackStatusMessage() {
  return eventSourceConnected
    ? "Relais temps reel actif"
    : "Relais HTTP de secours actif";
}

function shouldAnimateSequenceSlot(previousSymbol, nextSymbol) {
  if (!nextSymbol) {
    return false;
  }

  return previousSymbol !== nextSymbol;
}

function queueSequenceArrivalAnimations() {
  const runAnimation = () => {
    for (const slot of elements.sequence.querySelectorAll("[data-animate='1']")) {
      slot.removeAttribute("data-animate");
      slot.classList.add("is-arriving");
    }
  };

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(runAnimation);
  });
}