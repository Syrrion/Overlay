const SYMBOLS = ["cross", "t", "circle", "diamond", "triangle"];
const DEFAULT_ROOM = "ura-helper";
const DEFAULT_AUTO_CLEAR_MS = 20_000;
const HTTP_POLL_MS = 500;

const params = new URLSearchParams(window.location.search);
const room = normalizeRoom(params.get("room")) || DEFAULT_ROOM;
const relayUrl = getRelayUrl(params.get("relay"));
const relayHttpUrl = getRelayHttpUrl(relayUrl);

const elements = {
  expiryFill: document.getElementById("expiry-fill"),
  expiryTrack: document.getElementById("expiry-track"),
  note: document.getElementById("viewer-note"),
  relayPill: document.getElementById("relay-pill"),
  roomPill: document.getElementById("room-pill"),
  sequence: document.getElementById("sequence"),
  statusPill: document.getElementById("status-pill"),
  statusText: document.getElementById("status-text")
};

const state = {
  autoClearMs: DEFAULT_AUTO_CLEAR_MS,
  connected: false,
  httpConnected: false,
  expiresAt: null,
  sequence: []
};

let expiryTimer = null;
let pollInFlight = false;
let pollTimer = null;
let reconnectTimer = null;
let socket = null;

document.title = `Ura Helper Web`;

renderSequence();
setStatus("Connexion au relais...", "pending");
connectReader();
startHttpPolling();

function connectReader() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  try {
    socket = new WebSocket(relayUrl);
  } catch (error) {
    setStatus(`Relais invalide: ${error.message}`, "error");
    return;
  }

  socket.addEventListener("open", () => {
    state.connected = true;
    setStatus("Connecté", "connected");
    socket.send(JSON.stringify({ type: "join", role: "reader", room }));
  });

  socket.addEventListener("message", (event) => {
    handleMessage(event.data);
  });

  socket.addEventListener("close", () => {
    state.connected = false;
    if (!state.httpConnected) {
      setStatus("Relais deconnecte. Reconnexion...", "pending");
    }
    reconnectTimer = window.setTimeout(connectReader, 2000);
  });

  socket.addEventListener("error", () => {
    if (!state.connected && !state.httpConnected) {
      setStatus("Connexion impossible. Nouvelle tentative...", "error");
    }
  });
}

function startHttpPolling() {
  clearInterval(pollTimer);
  pollTimer = window.setInterval(pollRoomState, HTTP_POLL_MS);
  pollRoomState();
}

async function pollRoomState() {
  if (pollInFlight) {
    return;
  }

  pollInFlight = true;
  try {
    const response = await fetch(`${relayHttpUrl}/api/rooms/${encodeURIComponent(room)}`, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    state.httpConnected = true;
    if (!state.connected) {
      setStatus("Connecté", "connected");
    }

    applyStateMessage(await response.json());
  } catch (_error) {
    state.httpConnected = false;
    if (!state.connected) {
      setStatus("API relais indisponible. Nouvelle tentative...", "error");
    }
  } finally {
    pollInFlight = false;
  }
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

  applyStateMessage(message);
}

function applyStateMessage(message) {
  state.sequence = filterSequence(message.sequence);
  state.expiresAt = Number.isFinite(message.expiresAt) ? message.expiresAt : null;
  state.autoClearMs = Number.isFinite(message.autoClearMs) ? message.autoClearMs : DEFAULT_AUTO_CLEAR_MS;

  renderSequence();
  syncExpiryBar();
}

function renderSequence() {
  elements.sequence.innerHTML = SYMBOLS.map((_symbol, reverseIndex) => {
    const index = SYMBOLS.length - 1 - reverseIndex;
    const selected = state.sequence[index];

    return `
      <li class="sequence-slot ${selected ? "is-filled" : "is-empty"}">
        ${selected ? symbolSvg(selected) : ""}
      </li>
    `;
  }).join("");
}

function syncExpiryBar() {
  clearInterval(expiryTimer);
  expiryTimer = null;

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
  elements.statusText.textContent = message;
  elements.statusPill.className = "status-pill";

  if (variant === "connected") {
    elements.statusPill.textContent = "Connecte";
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

function normalizeRoom(value) {
  const candidate = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_-]{3,48}$/.test(candidate) ? candidate : "";
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

  return new URL(withScheme).toString().replace(/\/$/, "");
}

function getDefaultRelayUrl() {
  if (!window.location.host) {
    return "ws://127.0.0.1:8787";
  }

  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
}

function getRelayHttpUrl(webSocketUrl) {
  const url = new URL(webSocketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.toString().replace(/\/$/, "");
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