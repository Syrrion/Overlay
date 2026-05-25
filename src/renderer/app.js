const root = document.getElementById("app");
const api = window.overlayApi;

let currentState = null;
let lastError = "";
let lastRenderKey = "";

document.body.classList.add("control-body");

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
  renderControl();
}

function getRenderKey() {
  return [
    currentState.role,
    currentState.connected,
    currentState.movementLocked,
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
      lastRenderKey = "";
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
  const connectionLabel = currentState.connected ? "Page chargee" : "Chargement";

  return `
    <section class="session-panel">
      <div class="session-topline">
        <span class="role-pill">${roleLabel}</span>
        <span class="connection-dot ${currentState.connected ? "is-on" : ""}"></span>
        <span>${connectionLabel}</span>
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}