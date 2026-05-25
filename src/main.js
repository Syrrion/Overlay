const { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocket } = require("ws");

const DEFAULT_SERVER_URL = "ura.syrion.site";
const DEFAULT_ROOM = "ura-helper";
const SYMBOLS = ["cross", "t", "circle", "diamond", "triangle"];
const BASE_WINDOW_SIZES = {
  sequence: { width: 410, height: 96 },
  palette: { width: 486, height: 96 }
};
const DEFAULT_WINDOW_SCALES = {
  sequence: 1,
  palette: 1
};
const DEFAULT_OVERLAY_OPACITY = 1;
const MIN_WINDOW_SCALE = 0.5;
const MAX_WINDOW_SCALE = 2;
const SCALE_MENU_OPTIONS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const MIN_OVERLAY_OPACITY = 0.5;
const MAX_OVERLAY_OPACITY = 1;
const OPACITY_MENU_OPTIONS = [0.5, 0.6, 0.7, 0.8, 0.9, 1];

let controlWindow = null;
let sequenceWindow = null;
let paletteWindow = null;
let desktopRelaySocket = null;
let desktopRelayQueue = [];
let desktopRelayReconnectTimer = null;
let saveSettingsTimer = null;
let settings = {};
let suppressManagedWindowCloseQuit = false;

const state = {
  role: "idle",
  connected: false,
  serverUrl: DEFAULT_SERVER_URL,
  room: DEFAULT_ROOM,
  message: "",
  movementLocked: false,
  overlayOpacity: DEFAULT_OVERLAY_OPACITY,
  windowScales: {
    sequence: DEFAULT_WINDOW_SCALES.sequence,
    palette: DEFAULT_WINDOW_SCALES.palette
  }
};

app.commandLine.appendSwitch("disable-renderer-backgrounding");

app.whenReady().then(() => {
  settings = readSettings();
  state.message = "";
  state.room = DEFAULT_ROOM;
  state.movementLocked = Boolean(settings.movementLocked);
  state.overlayOpacity = getOverlayOpacity();
  state.windowScales.sequence = getWindowScale("sequence");
  state.windowScales.palette = getWindowScale("palette");

  createControlWindow();
  registerGlobalShortcuts();

  screen.on("display-added", fitWidgetWindowsToDisplays);
  screen.on("display-removed", fitWidgetWindowsToDisplays);
  screen.on("display-metrics-changed", fitWidgetWindowsToDisplays);
});

app.on("before-quit", () => {
  stopSession({ notify: false });
  flushSettingsSave();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  app.quit();
});

ipcMain.handle("status:get", () => serializeState());

ipcMain.handle("session:start", (_event, options = {}) => {
  try {
    const role = normalizeRole(options.role);
    const serverUrl = normalizeServerUrl(DEFAULT_SERVER_URL);
    const room = DEFAULT_ROOM;

    stopSession({ notify: false });

    state.role = role;
    state.serverUrl = serverUrl;
    state.room = room;
    state.connected = false;
    state.message = "Chargement de la page web...";

    connectDesktopRelay();

    createSequenceWindow();

    if (role === "leader") {
      createPaletteWindow();
    } else {
      closePaletteWindow();
    }

    sendStateToWindows();
    hideControlWindowSoon();
    return { ok: true, state: serializeState() };
  } catch (error) {
    state.message = error.message;
    sendStateToWindows();
    return { ok: false, error: error.message, state: serializeState() };
  }
});

ipcMain.handle("session:stop", () => {
  stopSession();
  showControlWindow();
  return serializeState();
});

ipcMain.handle("movement:setLocked", (_event, locked) => {
  setMovementLocked(Boolean(locked));
  return serializeState();
});

ipcMain.handle("window:setScale", (_event, target, scale) => {
  const windowKey = normalizeWindowKey(target);
  const nextScale = normalizeWindowScale(scale);

  setWindowScale(windowKey, nextScale);
  return serializeState();
});

ipcMain.on("desktop:leader-action", (_event, message) => {
  sendDesktopLeaderAction(message);
});

ipcMain.handle("desktop:leader-action", (_event, message) => sendDesktopLeaderActionResult(message));

function createControlWindow() {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.show();
    return;
  }

  controlWindow = new BrowserWindow({
    width: 460,
    height: 520,
    minWidth: 420,
    minHeight: 500,
    title: "Ura Helper",
    backgroundColor: "#101114",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  controlWindow.removeMenu();

  controlWindow.loadFile(path.join(__dirname, "renderer", "index.html"), {
    query: { view: "control" }
  });

  controlWindow.on("closed", () => {
    controlWindow = null;
  });
}

function createSequenceWindow() {
  closeSequenceWindow();

  const bounds = getSavedBounds("sequence", getDefaultSequenceBounds());
  sequenceWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    focusable: false,
    fullscreenable: false,
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  prepareNoFocusTopmostWindow(sequenceWindow);
  installFloatingWindowContextMenu(sequenceWindow, "sequence");
  installBoundsPersistence(sequenceWindow, "sequence");
  applyMovementLock();
  applyOverlayOpacity();
  applyWindowScale("sequence");

  loadManagedWebApp(sequenceWindow, "overlay", "viewer");

  sequenceWindow.once("ready-to-show", () => {
    if (!sequenceWindow || sequenceWindow.isDestroyed()) {
      return;
    }

    sequenceWindow.showInactive();
    sendStateToWindows();
  });

  sequenceWindow.on("closed", () => {
    sequenceWindow = null;
    maybeQuitFromManagedWindowClose();
  });
}

function createPaletteWindow() {
  closePaletteWindow();

  const bounds = getSavedBounds("palette", getDefaultPaletteBounds());
  paletteWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    focusable: false,
    fullscreenable: false,
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  prepareNoFocusTopmostWindow(paletteWindow);
  installFloatingWindowContextMenu(paletteWindow, "palette");
  installBoundsPersistence(paletteWindow, "palette");
  applyMovementLock();
  applyOverlayOpacity();
  applyWindowScale("palette");

  loadManagedWebApp(paletteWindow, "palette", "leader", { reset: true });

  paletteWindow.once("ready-to-show", () => {
    if (!paletteWindow || paletteWindow.isDestroyed()) {
      return;
    }

    paletteWindow.showInactive();
    sendStateToWindows();
  });

  paletteWindow.on("closed", () => {
    paletteWindow = null;
    maybeQuitFromManagedWindowClose();
  });
}

function prepareNoFocusTopmostWindow(window) {
  window.setAlwaysOnTop(true, "screen-saver", 1);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setFocusable(false);
  window.on("focus", () => window.blur());
}

function applyMovementLock() {
  const movable = !state.movementLocked;

  for (const window of [sequenceWindow, paletteWindow]) {
    if (window && !window.isDestroyed()) {
      window.setMovable(movable);
    }
  }
}

function setMovementLocked(locked) {
  state.movementLocked = Boolean(locked);
  settings.movementLocked = state.movementLocked;
  applyMovementLock();
  scheduleSettingsSave();
  sendStateToWindows();
}

function applyOverlayOpacity() {
  for (const window of [sequenceWindow, paletteWindow]) {
    if (window && !window.isDestroyed()) {
      window.setOpacity(state.overlayOpacity);
    }
  }
}

function setOverlayOpacity(nextOpacity) {
  state.overlayOpacity = nextOpacity;
  settings.overlayOpacity = nextOpacity;
  applyOverlayOpacity();
  scheduleSettingsSave();
  sendStateToWindows();
}

function setWindowScale(windowKey, nextScale) {
  state.windowScales[windowKey] = nextScale;
  settings.windowScales = settings.windowScales || {};
  settings.windowScales[windowKey] = nextScale;
  applyWindowScale(windowKey);
  scheduleSettingsSave();
  sendStateToWindows();
}

function installFloatingWindowContextMenu(window, windowKey) {
  const openMenu = (popupPoint) => {
    const menu = buildFloatingWindowMenu(window, windowKey);
    if (popupPoint && Number.isFinite(popupPoint.x) && Number.isFinite(popupPoint.y)) {
      menu.popup({
        window,
        x: Math.max(0, Math.round(popupPoint.x)),
        y: Math.max(0, Math.round(popupPoint.y))
      });
      return;
    }

    menu.popup({ window });
  };

  window.webContents.on("context-menu", (event, params) => {
    event.preventDefault();
    openMenu(params);
  });

  window.on("system-context-menu", (event, point) => {
    event.preventDefault();
    const bounds = window.getBounds();
    const dipPoint = point && typeof screen.screenToDipPoint === "function"
      ? screen.screenToDipPoint(point)
      : point;

    openMenu(dipPoint ? {
      x: dipPoint.x - bounds.x,
      y: dipPoint.y - bounds.y
    } : null);
  });
}

function buildFloatingWindowMenu(window, windowKey) {
  return Menu.buildFromTemplate([
    {
      label: state.movementLocked ? "Deverrouiller le deplacement" : "Verrouiller le deplacement",
      click: () => {
        if (!window.isDestroyed()) {
          setMovementLocked(!state.movementLocked);
        }
      }
    },
    { type: "separator" },
    ...SCALE_MENU_OPTIONS.map((scale) => ({
      label: `${Math.round(scale * 100)}%`,
      type: "radio",
      checked: Math.abs(scale - state.windowScales[windowKey]) < 0.001,
      click: () => {
        if (!window.isDestroyed()) {
          setWindowScale(windowKey, scale);
        }
      }
    })),
    { type: "separator" },
    ...OPACITY_MENU_OPTIONS.map((opacity) => ({
      label: `Opacite ${Math.round(opacity * 100)}%`,
      type: "radio",
      checked: Math.abs(opacity - state.overlayOpacity) < 0.001,
      click: () => {
        if (!window.isDestroyed()) {
          setOverlayOpacity(opacity);
        }
      }
    })),
    { type: "separator" },
    {
      label: "Quitter",
      click: () => {
        app.quit();
      }
    }
  ]);
}

function maybeQuitFromManagedWindowClose() {
  if (!suppressManagedWindowCloseQuit && state.role !== "idle") {
    app.quit();
  }
}

function applyWindowScale(windowKey) {
  const window = getManagedWindow(windowKey);
  if (!window || window.isDestroyed()) {
    return;
  }

  const currentBounds = window.getBounds();
  const nextSize = getScaledSize(windowKey);

  window.webContents.setZoomFactor(state.windowScales[windowKey]);
  window.setBounds(
    fitBoundsToDisplays({
      x: Math.round(currentBounds.x + (currentBounds.width - nextSize.width) / 2),
      y: Math.round(currentBounds.y + (currentBounds.height - nextSize.height) / 2),
      width: nextSize.width,
      height: nextSize.height
    })
  );
}

function getManagedWindow(windowKey) {
  return windowKey === "sequence" ? sequenceWindow : paletteWindow;
}

function closeSequenceWindow() {
  if (sequenceWindow && !sequenceWindow.isDestroyed()) {
    saveWindowBounds("sequence", sequenceWindow);
    sequenceWindow.close();
  }
  sequenceWindow = null;
}

function closePaletteWindow() {
  if (paletteWindow && !paletteWindow.isDestroyed()) {
    saveWindowBounds("palette", paletteWindow);
    paletteWindow.close();
  }
  paletteWindow = null;
}

function fitWidgetWindowsToDisplays() {
  for (const window of [sequenceWindow, paletteWindow]) {
    if (window && !window.isDestroyed()) {
      window.setBounds(fitBoundsToDisplays(window.getBounds()));
    }
  }
}

function getDefaultSequenceBounds() {
  const display = screen.getPrimaryDisplay();
  const size = getScaledSize("sequence");

  return {
    x: Math.round(display.workArea.x + (display.workArea.width - size.width) / 2),
    y: Math.round(display.workArea.y + 64),
    width: size.width,
    height: size.height
  };
}

function getDefaultPaletteBounds() {
  const display = screen.getPrimaryDisplay();
  const size = getScaledSize("palette");

  return {
    x: Math.round(display.workArea.x + (display.workArea.width - size.width) / 2),
    y: Math.round(display.workArea.y + display.workArea.height - size.height - 28),
    width: size.width,
    height: size.height
  };
}

function getScaledSize(windowKey) {
  const baseSize = BASE_WINDOW_SIZES[windowKey];
  const scale = state.windowScales[windowKey];
  return {
    width: Math.round(baseSize.width * scale),
    height: Math.round(baseSize.height * scale)
  };
}

function getSavedBounds(key, fallback) {
  const saved = settings.windows && settings.windows[key];
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) {
    return fitBoundsToDisplays(fallback);
  }

  return fitBoundsToDisplays({
    x: saved.x,
    y: saved.y,
    width: fallback.width,
    height: fallback.height
  });
}

function fitBoundsToDisplays(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);

  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height
  };
}

function installBoundsPersistence(window, key) {
  const save = () => saveWindowBounds(key, window);
  window.on("move", save);
  window.on("moved", save);
}

function saveWindowBounds(key, window) {
  if (!window || window.isDestroyed()) {
    return;
  }

  settings.windows = settings.windows || {};
  settings.windows[key] = window.getBounds();
  scheduleSettingsSave();
}

function loadManagedWebApp(window, view, mode, options = {}) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  window.webContents.on("did-finish-load", () => {
    installDesktopPaletteForwarder(window, view);

    if (state.role !== "idle") {
      state.connected = true;
      state.message = "Page web chargee";
      sendStateToWindows();
    }
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    if (errorCode === -3 || state.role === "idle") {
      return;
    }

    state.connected = false;
    state.message = `Chargement web impossible: ${errorDescription}`;
    sendStateToWindows();
  });

  window.loadURL(buildWebAppUrl(view, mode, options));
}

function installDesktopPaletteForwarder(window, view) {
  if (view !== "palette" || !window || window.isDestroyed()) {
    return;
  }

  window.webContents.executeJavaScript(`
    (() => {
      if (window.__uraDesktopForwarderInstalled || !window.desktopOverlay) {
        return;
      }

      window.__uraDesktopForwarderInstalled = true;
      const symbols = new Set(${JSON.stringify(SYMBOLS)});
      const sourceId = "desktop-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      let sourceRevision = 0;

      const sendAction = (action, extra = {}) => {
        sourceRevision += 1;
        window.desktopOverlay.sendLeaderAction({
          type: "action",
          action,
          sourceId,
          sourceRevision,
          ...extra
        });
      };

      document.addEventListener("pointerdown", (event) => {
        const symbolButton = event.target.closest("[data-symbol]");
        if (symbolButton && symbols.has(symbolButton.dataset.symbol)) {
          sendAction("append", { symbol: symbolButton.dataset.symbol });
          return;
        }

        if (event.target.closest("#clear-sequence")) {
          sendAction("clear");
        }
      }, true);
    })();
  `, true).catch(() => {});
}

function buildWebAppUrl(view, mode, options = {}) {
  const url = new URL(getRelayHttpUrl(state.serverUrl));
  url.searchParams.set("view", view);
  url.searchParams.set("mode", mode);
  url.searchParams.set("room", state.room);
  url.searchParams.set("relay", state.serverUrl);

  if (options.reset) {
    url.searchParams.set("reset", "1");
  }

  return url.toString();
}

function connectDesktopRelay() {
  clearTimeout(desktopRelayReconnectTimer);
  desktopRelayReconnectTimer = null;

  if (desktopRelaySocket && desktopRelaySocket.readyState === WebSocket.OPEN) {
    return;
  }

  if (desktopRelaySocket && desktopRelaySocket.readyState === WebSocket.CONNECTING) {
    return;
  }

  const socket = new WebSocket(state.serverUrl);
  desktopRelaySocket = socket;

  socket.on("open", () => {
    if (desktopRelaySocket !== socket || state.role === "idle") {
      return;
    }

    state.connected = true;
    state.message = "Connecté au relais Node";
    sendDesktopRelayMessage({ type: "join", role: state.role === "leader" ? "leader" : "reader", room: state.room });
    flushDesktopRelayQueue();
    sendStateToWindows();
  });

  socket.on("message", () => {
    if (desktopRelaySocket === socket && state.role !== "idle") {
      state.connected = true;
      sendStateToWindows();
    }
  });

  socket.on("close", () => {
    if (desktopRelaySocket !== socket || state.role === "idle") {
      return;
    }

    desktopRelaySocket = null;
    state.connected = false;
    state.message = "Relais Node deconnecte. Reconnexion...";
    sendStateToWindows();
    desktopRelayReconnectTimer = setTimeout(connectDesktopRelay, 1000);
  });

  socket.on("error", (error) => {
    if (desktopRelaySocket !== socket || state.role === "idle") {
      return;
    }

    state.connected = false;
    state.message = `Relais Node indisponible: ${error.message}`;
    sendStateToWindows();
  });
}

function closeDesktopRelay() {
  clearTimeout(desktopRelayReconnectTimer);
  desktopRelayReconnectTimer = null;
  desktopRelayQueue = [];

  if (!desktopRelaySocket) {
    return;
  }

  const socket = desktopRelaySocket;
  desktopRelaySocket = null;
  socket.removeAllListeners();
  socket.close();
}

function sendDesktopLeaderAction(message) {
  return sendDesktopLeaderActionResult(message).ok;
}

function sendDesktopLeaderActionResult(message) {
  if (state.role !== "leader") {
    return { ok: false, reason: "not-leader" };
  }

  const actionMessage = normalizeDesktopLeaderAction(message);
  if (!actionMessage) {
    return { ok: false, reason: "invalid-action" };
  }

  if (sendDesktopRelayMessage(actionMessage)) {
    state.message = "Action envoyee au relais Node";
    sendStateToWindows();
    return { ok: true, sent: true, queued: false };
  }

  desktopRelayQueue.push(actionMessage);
  connectDesktopRelay();
  state.message = "Action en attente du relais Node";
  sendStateToWindows();
  return { ok: true, sent: false, queued: true };
}

function sendDesktopRelayMessage(message) {
  if (!desktopRelaySocket || desktopRelaySocket.readyState !== WebSocket.OPEN) {
    return false;
  }

  desktopRelaySocket.send(JSON.stringify(message));
  return true;
}

function flushDesktopRelayQueue() {
  const queue = desktopRelayQueue;
  desktopRelayQueue = [];

  for (const message of queue) {
    if (!sendDesktopRelayMessage(message)) {
      desktopRelayQueue.push(message);
    }
  }
}

function normalizeDesktopLeaderAction(message) {
  const action = message && message.action === "clear" ? "clear" : message && message.action === "append" ? "append" : "";
  if (!action) {
    return null;
  }

  const sourceId = normalizeSourceId(message.sourceId);
  const sourceRevision = normalizeSourceRevision(message.sourceRevision);
  if (!sourceId || !sourceRevision) {
    return null;
  }

  const actionMessage = {
    type: "action",
    action,
    room: state.room,
    sourceId,
    sourceRevision
  };

  if (action === "append") {
    if (!SYMBOLS.includes(message.symbol)) {
      return null;
    }

    actionMessage.symbol = message.symbol;
  }

  return actionMessage;
}

function stopSession({ notify = true } = {}) {
  closeDesktopRelay();
  state.role = "idle";
  state.connected = false;
  state.serverUrl = normalizeServerUrl(DEFAULT_SERVER_URL);
  state.room = DEFAULT_ROOM;
  state.message = "";

  suppressManagedWindowCloseQuit = true;
  closeSequenceWindow();
  closePaletteWindow();
  suppressManagedWindowCloseQuit = false;

  if (notify) {
    sendStateToWindows();
  }
}

function getRelayHttpUrl(value) {
  const url = new URL(value);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function sendStateToWindows() {
  const payload = serializeState();
  for (const window of [controlWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send("state:update", payload);
    }
  }
}

function serializeState() {
  return {
    role: state.role,
    connected: state.connected,
    message: state.message,
    movementLocked: state.movementLocked,
    overlayOpacity: state.overlayOpacity,
    windowScales: { ...state.windowScales }
  };
}

function normalizeRole(value) {
  if (value === "leader" || value === "reader") {
    return value;
  }

  throw new Error("Mode inconnu.");
}

function normalizeSourceId(value) {
  const sourceId = String(value || "").trim();
  return /^[a-z0-9_-]{8,80}$/i.test(sourceId) ? sourceId : "";
}

function normalizeSourceRevision(value) {
  const sourceRevision = Number(value);
  return Number.isFinite(sourceRevision) && sourceRevision > 0 ? sourceRevision : 0;
}

function normalizeServerUrl(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    throw new Error("Adresse du relais web requise.");
  }

  let withScheme = rawValue.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
  if (!/^wss?:\/\//i.test(withScheme)) {
    withScheme = `wss://${withScheme}`;
  }

  const url = new URL(withScheme);
  if (url.pathname === "/") {
    url.pathname = "/ws";
  }

  return url.toString().replace(/\/$/, "");
}

function normalizeWindowKey(value) {
  if (value === "sequence" || value === "palette") {
    return value;
  }

  throw new Error("Fenetre invalide.");
}

function normalizeWindowScale(value) {
  const scale = Number.parseFloat(String(value));
  if (!Number.isFinite(scale)) {
    throw new Error("Scale invalide.");
  }

  return Math.min(MAX_WINDOW_SCALE, Math.max(MIN_WINDOW_SCALE, scale));
}

function normalizeOverlayOpacity(value) {
  const opacity = Number.parseFloat(String(value));
  if (!Number.isFinite(opacity)) {
    throw new Error("Opacite invalide.");
  }

  const clampedOpacity = Math.min(MAX_OVERLAY_OPACITY, Math.max(MIN_OVERLAY_OPACITY, opacity));
  return Math.round(clampedOpacity * 100) / 100;
}

function getWindowScale(windowKey) {
  const savedScale = settings.windowScales && settings.windowScales[windowKey];
  if (!Number.isFinite(savedScale)) {
    return DEFAULT_WINDOW_SCALES[windowKey];
  }

  return normalizeWindowScale(savedScale);
}

function getOverlayOpacity() {
  if (!Number.isFinite(settings.overlayOpacity)) {
    return DEFAULT_OVERLAY_OPACITY;
  }

  return normalizeOverlayOpacity(settings.overlayOpacity);
}

function registerGlobalShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+O", () => {
    if (controlWindow && controlWindow.isVisible()) {
      controlWindow.hide();
      return;
    }

    showControlWindow();
  });
}

function showControlWindow() {
  createControlWindow();
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.show();
    controlWindow.focus();
    sendStateToWindows();
  }
}

function hideControlWindowSoon() {
  if (!controlWindow || controlWindow.isDestroyed()) {
    return;
  }

  setTimeout(() => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.hide();
    }
  }, 150);
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
  } catch (_error) {
    return {};
  }
}

function scheduleSettingsSave() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(writeSettings, 120);
}

function flushSettingsSave() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = null;
  writeSettings();
}

function writeSettings() {
  fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}