const SYMBOLS = ["cross", "t", "circle", "diamond", "triangle"];
const SYMBOL_NAMES = {
  cross: "Croix",
  t: "T",
  circle: "Rond",
  diamond: "Losange",
  triangle: "Triangle"
};

const params = new URLSearchParams(window.location.search);
const view = params.get("view") || "control";
const root = document.getElementById("app");
const api = window.overlayApi;

let currentState = null;
let lastError = "";
let lastRenderKey = "";

document.body.classList.add(view === "sequence" ? "overlay-body" : view === "palette" ? "palette-body" : "control-body");

init();

async function init() {
  currentState = await api.getStatus();
  render();
  api.onState((state) => {
    currentState = state;
    render();
  });
}

function render() {
  if (!currentState) {
    return;
  }

  const renderKey = getRenderKey();
  if (renderKey === lastRenderKey) {
    return;
  }

  lastRenderKey = renderKey;
  document.body.classList.toggle("movement-locked", Boolean(currentState.movementLocked));

  if (view === "sequence") {
    renderSequenceOverlay();
    return;
  }

  if (view === "palette") {
    renderPalette();
    return;
  }

  renderControl();
}

function getRenderKey() {
  const sequenceKey = currentState.sequence.join(",");

  if (view === "sequence") {
    return [view, currentState.role, sequenceKey, currentState.expiresAt || "", currentState.movementLocked].join("|");
  }

  if (view === "palette") {
    return [view, currentState.role, sequenceKey, currentState.movementLocked].join("|");
  }

  return [
    view,
    currentState.role,
    currentState.connected,
    currentState.movementLocked,
    sequenceKey,
    currentState.expiresAt || "",
    currentState.message,
    lastError
  ].join("|");
}

function renderControl() {
  const running = currentState.role !== "idle";
  const message = lastError || currentState.message;

  root.innerHTML = `
    <main class="control-shell">
      <header class="control-header">
        <div class="product-mark">UH</div>
        <div>
          <h1>Ura Helper</h1>
        </div>
      </header>

      ${message ? `<p class="status-line ${lastError ? "is-error" : ""}">${escapeHtml(message)}</p>` : ""}

      ${running ? renderRunningControl() : renderStartControl()}
    </main>
  `;

  bindMovementLockToggle();

  if (running) {
    root.querySelector("[data-action='stop']").addEventListener("click", async () => {
      lastError = "";
      currentState = await api.stopSession();
      render();
    });
    return;
  }

  root.querySelector("[data-action='start-leader']").addEventListener("click", () => {
    startSession("leader");
  });

  root.querySelector("[data-action='start-reader']").addEventListener("click", () => {
    startSession("reader");
  });
}

function renderStartControl() {
  return `
    <section class="mode-panel mode-actions">
      <div class="mode-copy">
        <h2>Choisir un mode</h2>
        <p>Leader pilote la sequence. Viewer affiche uniquement l'overlay.</p>
      </div>
      <button class="primary-button" data-action="start-leader" type="button">Lancer en Leader</button>
      <button class="secondary-button" data-action="start-reader" type="button">Lancer en Viewer</button>
    </section>
  `;
}

function renderRunningControl() {
  const roleLabel = currentState.role === "leader" ? "Leader" : "Viewer";
  const connectionLabel = currentState.connected ? "Connecte" : "En attente";

  return `
    <section class="session-panel">
      <div class="session-topline">
        <span class="role-pill">${roleLabel}</span>
        <span class="connection-dot ${currentState.connected ? "is-on" : ""}"></span>
        <span>${connectionLabel}</span>
      </div>

      <div class="preview-block">
        ${renderSequence(currentState.sequence, "preview")}
        ${renderExpiryBar(currentState)}
      </div>

      ${renderMovementLockControl()}

      <button class="danger-button" data-action="stop" type="button">Stopper</button>
    </section>
  `;
}

async function startSession(role) {
  lastError = "";
  const result = await api.startSession({ role });
  currentState = result.state;

  if (!result.ok) {
    lastError = result.error || "Demarrage impossible.";
  }

  lastRenderKey = "";
  render();
}

async function updateMovementLocked(locked) {
  currentState = await api.setMovementLocked(locked);
  lastRenderKey = "";
  render();
}

function bindMovementLockToggle() {
  const toggle = root.querySelector("#movement-locked");
  if (!toggle) {
    return;
  }

  toggle.addEventListener("change", () => {
    updateMovementLocked(toggle.checked);
  });
}

function renderMovementLockControl() {
  return `
    <label class="lock-row" for="movement-locked">
      <span class="lock-copy">
        <strong>Verrouiller le deplacement</strong>
        <span>Bloque le glisser-deplacer des overlays jusqu'a reactivation.</span>
      </span>
      <input id="movement-locked" type="checkbox" ${currentState.movementLocked ? "checked" : ""}>
    </label>
  `;
}

function renderSequenceOverlay() {
  if (currentState.role === "idle") {
    root.innerHTML = "";
    return;
  }

  root.innerHTML = `
    <main class="sequence-stage">
      <section class="sequence-panel ${currentState.sequence.length ? "is-active" : "is-empty"}" aria-label="Sequence">
        <div class="sequence-row">
          <span class="drag-grip" aria-hidden="true">${dragGripSvg()}</span>
          ${renderSequence(currentState.sequence, "overlay")}
        </div>
        ${renderExpiryBar(currentState)}
      </section>
    </main>
  `;
}

function renderPalette() {
  if (currentState.role !== "leader") {
    root.innerHTML = "";
    return;
  }

  root.innerHTML = `
    <main class="palette-stage">
      <nav class="leader-palette" aria-label="Symboles leader">
        <span class="drag-grip" aria-hidden="true">${dragGripSvg()}</span>
        ${SYMBOLS.map((symbol) => renderSymbolButton(symbol)).join("")}
        <button class="reset-button" data-action="clear" type="button" title="Effacer" aria-label="Effacer la sequence">
          ${resetSvg()}
        </button>
      </nav>
    </main>
  `;

  for (const button of root.querySelectorAll("[data-symbol]")) {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => api.pickSymbol(button.dataset.symbol));
  }

  const resetButton = root.querySelector("[data-action='clear']");
  resetButton.addEventListener("mousedown", (event) => event.preventDefault());
  resetButton.addEventListener("click", () => api.clearSequence());
}

function renderSymbolButton(symbol) {
  const isUsed = currentState.sequence.includes(symbol);
  const isLocked = currentState.sequence.length >= SYMBOLS.length;
  return `
    <button class="symbol-button ${isUsed ? "is-used" : ""}" data-symbol="${symbol}" type="button" title="${SYMBOL_NAMES[symbol]}" aria-label="${SYMBOL_NAMES[symbol]}" ${isUsed || isLocked ? "disabled" : ""}>
      ${symbolSvg(symbol)}
    </button>
  `;
}

function renderSequence(sequence, variant) {
  const slots = SYMBOLS.map((_symbol, reverseIndex) => {
    const index = SYMBOLS.length - 1 - reverseIndex;
    const selected = sequence[index];
    return `
      <li class="sequence-slot ${selected ? "is-filled" : ""}">
        ${selected ? symbolSvg(selected) : ""}
      </li>
    `;
  }).join("");

  return `<ol class="symbol-sequence ${variant}">${slots}</ol>`;
}

function renderExpiryBar(state) {
  if (!state.expiresAt) {
    return "";
  }

  const remaining = Math.max(1, state.expiresAt - Date.now());
  return `
    <div class="expiry-track" aria-hidden="true">
      <span class="expiry-fill" style="animation-duration: ${remaining}ms"></span>
    </div>
  `;
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
