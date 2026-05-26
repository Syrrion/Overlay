const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const AUTO_CLEAR_MS = 20_000;
const STATE_POLL_MS = 100;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const STATE_WRITE_DEBOUNCE_MS = 50;
const SYMBOLS = ["cross", "t", "circle", "diamond", "triangle"];
const UNKNOWN_SYMBOL = "unknown";
// Bump only when the desktop Electron client must be updated.
const EXPECTED_DESKTOP_CLIENT_VERSION = 1;
const DEFAULT_ROOM = "ura-helper";
const PUBLIC_DIR = path.join(__dirname, "public");
const STATE_FILE = process.env.URA_RELAY_STATE_FILE || path.join(__dirname, ".relay-state.json");
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

const rooms = new Map();
const metrics = {
  httpActionUpdates: 0,
  httpStateUpdates: 0,
  ignoredStaleStateUpdates: 0,
  lastActionAt: 0,
  lastActionRoom: "",
  lastActionTransport: "",
  lastJoinAt: 0,
  lastJoinRole: "",
  lastJoinRoom: "",
  eventStreamConnections: 0,
  eventStreamEvents: 0,
  stateWriteErrors: 0,
  stateWrites: 0,
  lastStateWriteError: ""
};
let serverRevision = Date.now() * 1000;
let stateStore = readStateStoreFromDisk();
let stateWriteDirty = false;
let stateWriteInFlight = false;
let stateWriteTimer = null;
const sharedStatePoller = setInterval(syncRoomsFromSharedState, STATE_POLL_MS);
sharedStatePoller.unref?.();

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");

  if (requestUrl.pathname === "/health") {
    const store = readStateStore();
    const knownRooms = new Set([...rooms.keys(), ...Object.keys(store.rooms)]);

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      expectedDesktopClientVersion: EXPECTED_DESKTOP_CLIENT_VERSION,
      rooms: knownRooms.size,
      clientsByRoom: getClientsByRoom(),
      localRooms: rooms.size,
      localClients: countLocalClients(),
      storedRooms: Object.keys(store.rooms).length,
      stateFile: STATE_FILE,
      metrics,
      pid: process.pid
    }));
    return;
  }

  if (requestUrl.pathname.startsWith("/api/rooms/")) {
    handleApiRequest(request, response, requestUrl);
    return;
  }

  if (!["GET", "HEAD"].includes(request.method || "GET")) {
    response.writeHead(405, {
      "allow": "GET, HEAD",
      "content-type": "text/plain; charset=utf-8"
    });
    response.end("Method not allowed\n");
    return;
  }

  serveStaticAsset(requestUrl.pathname, response, request.method === "HEAD");
});

server.listen(PORT, () => {
  console.log(`Ura Helper relay listening on :${PORT}`);
});

function handleApiRequest(request, response, requestUrl) {
  const match = /^\/api\/rooms\/([a-z0-9_-]{3,48})(?:\/(state|events|presence))?$/i.exec(requestUrl.pathname);
  const requestedRoomName = normalizeRoom(match?.[1]);
  const roomName = requestedRoomName ? DEFAULT_ROOM : "";
  const roomResource = match?.[2] || "";

  if (!roomName) {
    sendJson(response, 404, { ok: false, error: "Salon invalide." });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, createJsonHeaders({
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, HEAD, POST, OPTIONS"
    }));
    response.end();
    return;
  }

  if (roomResource === "events") {
    if (request.method === "GET") {
      openRoomEventStream(request, response, roomName, requestUrl);
      return;
    }

    response.writeHead(405, {
      ...createJsonHeaders(),
      "allow": "GET, OPTIONS"
    });
    response.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  if (roomResource === "presence" && request.method === "POST") {
    readJsonBody(request, response, (message) => {
      const room = getRoom(roomName);
      const clientId = normalizeClientId(message.clientId || requestUrl.searchParams.get("client"));
      const action = String(message.action || requestUrl.searchParams.get("action") || "").trim().toLowerCase();

      if (!clientId || action !== "leave") {
        sendJson(response, 400, { ok: false, error: "Presence invalide." });
        return;
      }

      const removed = removeClientEventStreams(roomName, room, clientId);
      sendJson(response, 200, { ok: true, removed });
    });
    return;
  }

  if (!roomResource && (request.method === "GET" || request.method === "HEAD")) {
    sendJson(response, 200, getRoomStateMessage(roomName), request.method === "HEAD");
    return;
  }

  if (request.method === "POST" && roomResource === "state") {
    readJsonBody(request, response, (message) => {
      const room = getRoom(roomName);
      metrics.httpStateUpdates += 1;

      const changed = message.type === "action"
        ? applyRoomAction(room, message)
        : applyIncomingRoomState(room, message);

      if (message.type === "action") {
        recordActionMetric(roomName, "http");
        metrics.httpActionUpdates += 1;
      }

      if (changed) {
        scheduleRoomClear(roomName, room);
        broadcastRoomState(room);
        persistRoomState(room);
      } else {
        metrics.ignoredStaleStateUpdates += 1;
      }

      sendJson(response, 200, createStateMessage(room));
    });
    return;
  }

  response.writeHead(405, {
    ...createJsonHeaders(),
    "allow": "GET, HEAD, POST, OPTIONS"
  });
  response.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
}

function readJsonBody(request, response, callback) {
  let body = "";
  let tooLarge = false;

  request.on("data", (chunk) => {
    body += chunk.toString("utf8");
    if (Buffer.byteLength(body, "utf8") > MAX_JSON_BODY_BYTES) {
      tooLarge = true;
      sendJson(response, 413, { ok: false, error: "Payload trop volumineux." });
      request.destroy();
    }
  });

  request.on("end", () => {
    if (tooLarge) {
      return;
    }

    try {
      callback(body ? JSON.parse(body) : {});
    } catch (_error) {
      sendJson(response, 400, { ok: false, error: "JSON invalide." });
    }
  });

  request.on("error", () => {
    if (!response.headersSent) {
      sendJson(response, 400, { ok: false, error: "Lecture de la requete impossible." });
    }
  });
}

function openRoomEventStream(request, response, roomName, requestUrl) {
  const room = getRoom(roomName);
  const storedRoom = readStoredRoom(roomName);
  if (storedRoom) {
    applyRoomState(room, storedRoom);
  } else {
    persistRoomState(room);
  }

  response.writeHead(200, createEventStreamHeaders());
  response.flushHeaders?.();
  response.uraClientId = normalizeClientId(requestUrl.searchParams.get("client")) || createAnonymousClientId();
  room.eventStreams.add(response);
  metrics.eventStreamConnections += 1;
  metrics.lastJoinAt = Date.now();
  metrics.lastJoinRoom = roomName;
  metrics.lastJoinRole = "event-stream";

  broadcastRoomState(room);

  const keepAliveTimer = setInterval(() => {
    if (!response.writableEnded) {
      response.write(": keepalive\n\n");
    }
  }, 15_000);
  keepAliveTimer.unref?.();

  request.on("close", () => {
    clearInterval(keepAliveTimer);
    const wasConnected = room.eventStreams.delete(response);
    if (wasConnected && room.eventStreams.size > 0) {
      broadcastRoomState(room);
    }
    maybeDeleteRoom(roomName, room);
  });
}

function createEventStreamHeaders() {
  return {
    "access-control-allow-origin": "*",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no"
  };
}

function getRoomStateMessage(roomName) {
  const activeRoom = rooms.get(roomName);
  if (activeRoom) {
    const storedRoom = readStoredRoom(roomName);
    if (storedRoom && isNewerRoomState(activeRoom, storedRoom)) {
      applyRoomState(activeRoom, storedRoom);
    }

    return createStateMessage(activeRoom);
  }

  const storedRoom = readStoredRoom(roomName);
  const room = {
    name: roomName,
    eventStreams: new Set(),
    sequence: [],
    expiresAt: null,
    revision: 0,
    sourceId: "",
    sourceRevision: 0,
    sourceRevisions: {},
    updatedAt: 0
  };

  if (storedRoom) {
    applyRoomState(room, storedRoom);
  }

  return createStateMessage(room);
}

function getRoom(roomName) {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, {
      name: roomName,
      eventStreams: new Set(),
      sequence: [],
      expiresAt: null,
      revision: 0,
      sourceId: "",
      sourceRevision: 0,
      sourceRevisions: {},
      clearTimer: null,
      updatedAt: 0
    });
  }

  return rooms.get(roomName);
}

function scheduleRoomClear(roomName, room) {
  clearTimeout(room.clearTimer);
  room.clearTimer = null;

  if (!room.expiresAt) {
    return;
  }

  room.clearTimer = setTimeout(() => {
    const currentRoom = rooms.get(roomName);
    if (!currentRoom) {
      return;
    }

    currentRoom.sequence = [];
    currentRoom.expiresAt = null;
    currentRoom.revision = nextServerRevision(currentRoom.revision);
    currentRoom.updatedAt = Date.now();
    persistRoomState(currentRoom);
    broadcastRoomState(currentRoom);
  }, Math.max(0, room.expiresAt - Date.now()));
}

function syncRoomsFromSharedState() {
  if (rooms.size === 0) {
    return;
  }

  const store = readStateStore();
  for (const room of rooms.values()) {
    const storedRoom = store.rooms[room.name];
    if (!storedRoom || !isNewerRoomState(room, storedRoom)) {
      continue;
    }

    applyRoomState(room, storedRoom);
    scheduleRoomClear(room.name, room);
    broadcastRoomState(room);
  }
}

function isNewerRoomState(room, storedRoom) {
  const storedRevision = normalizeRevision(storedRoom.revision) || normalizeRevision(storedRoom.updatedAt);
  const roomRevision = normalizeRevision(room.revision) || normalizeRevision(room.updatedAt);

  return storedRevision > roomRevision;
}

function applyRoomState(room, storedRoom) {
  const expiresAt = normalizeExpiresAt(storedRoom.expiresAt);
  const expired = Boolean(storedRoom.expiresAt) && !expiresAt;

  room.sequence = expired ? [] : completeDeducedSequence(filterSequence(storedRoom.sequence));
  room.expiresAt = expiresAt;
  room.revision = normalizeRevision(storedRoom.revision) || normalizeRevision(storedRoom.updatedAt);
  room.sourceId = normalizeSourceId(storedRoom.sourceId);
  room.sourceRevision = normalizeRevision(storedRoom.sourceRevision);
  room.sourceRevisions = normalizeSourceRevisions(storedRoom.sourceRevisions);
  recordRoomSourceRevision(room, room.sourceId, room.sourceRevision);
  room.updatedAt = Number(storedRoom.updatedAt || Date.now());
}

function applyIncomingRoomState(room, message) {
  const incomingSourceId = normalizeSourceId(message.sourceId);
  const incomingSourceRevision = normalizeRevision(message.sourceRevision);

  if (isStaleSourceRevision(room, incomingSourceId, incomingSourceRevision)) {
    return false;
  }

  room.sequence = completeDeducedSequence(filterSequence(message.sequence));
  room.expiresAt = isCompleteSequence(room.sequence) ? Date.now() + AUTO_CLEAR_MS : null;
  room.revision = nextServerRevision(room.revision);
  recordRoomSourceRevision(room, incomingSourceId, incomingSourceRevision);
  room.updatedAt = Date.now();
  return true;
}

function applyRoomAction(room, message) {
  const incomingSourceId = normalizeSourceId(message.sourceId);
  const incomingSourceRevision = normalizeRevision(message.sourceRevision);

  if (isStaleSourceRevision(room, incomingSourceId, incomingSourceRevision)) {
    return false;
  }

  const action = message.action === "clear" ? "clear" : message.action === "append" ? "append" : "";
  if (!action) {
    return false;
  }

  if (action === "clear") {
    room.sequence = [];
    room.expiresAt = null;
  } else {
    appendRoomSymbol(room, message.symbol);
  }

  room.revision = nextServerRevision(room.revision);
  recordRoomSourceRevision(room, incomingSourceId, incomingSourceRevision);
  room.updatedAt = Date.now();
  return true;
}

function appendRoomSymbol(room, symbol) {
  const token = normalizeSequenceToken(symbol);
  const nextSequence = filterSequence(room.sequence);

  if (!token || nextSequence.length >= SYMBOLS.length) {
    return;
  }

  if (token === UNKNOWN_SYMBOL) {
    if (nextSequence.includes(UNKNOWN_SYMBOL)) {
      return;
    }

    nextSequence.push(UNKNOWN_SYMBOL);
  } else {
    if (nextSequence.includes(token)) {
      return;
    }

    nextSequence.push(token);
  }

  room.sequence = completeDeducedSequence(nextSequence);
  room.expiresAt = isCompleteSequence(room.sequence) ? Date.now() + AUTO_CLEAR_MS : null;
}

function persistRoomState(room) {
  const store = readStateStore();
  store.rooms[room.name] = {
    sequence: filterSequence(room.sequence),
    expiresAt: normalizeExpiresAt(room.expiresAt),
    revision: normalizeRevision(room.revision),
    sourceId: normalizeSourceId(room.sourceId),
    sourceRevision: normalizeRevision(room.sourceRevision),
    sourceRevisions: normalizeSourceRevisions(room.sourceRevisions),
    updatedAt: Number(room.updatedAt || Date.now())
  };
  store.updatedAt = Date.now();
  scheduleStateStoreWrite();
}

function readStoredRoom(roomName) {
  const store = readStateStore();
  return store.rooms[roomName] || null;
}

function readStateStore() {
  if (!stateStore || typeof stateStore !== "object") {
    stateStore = createEmptyStore();
  }

  return stateStore;
}

function readStateStoreFromDisk() {
  try {
    const rawStore = fs.readFileSync(STATE_FILE, "utf8");
    const store = JSON.parse(rawStore);
    if (!store || typeof store !== "object" || !store.rooms || typeof store.rooms !== "object") {
      return createEmptyStore();
    }

    return store;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Unable to read relay state: ${error.message}`);
    }
    return createEmptyStore();
  }
}

function scheduleStateStoreWrite() {
  stateWriteDirty = true;
  if (stateWriteTimer || stateWriteInFlight) {
    return;
  }

  stateWriteTimer = setTimeout(flushStateStoreWrite, STATE_WRITE_DEBOUNCE_MS);
  stateWriteTimer.unref?.();
}

async function flushStateStoreWrite() {
  clearTimeout(stateWriteTimer);
  stateWriteTimer = null;

  if (stateWriteInFlight || !stateWriteDirty) {
    return;
  }

  stateWriteDirty = false;
  stateWriteInFlight = true;

  const storeSnapshot = JSON.stringify(readStateStore());
  const stateDir = path.dirname(STATE_FILE);
  const tempFile = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.writeFile(tempFile, storeSnapshot, "utf8");
    await fsp.rename(tempFile, STATE_FILE);
    metrics.stateWrites += 1;
    metrics.lastStateWriteError = "";
  } catch (error) {
    metrics.stateWriteErrors += 1;
    metrics.lastStateWriteError = error.message;
    console.warn(`Unable to write relay state: ${error.message}`);
    try {
      await fsp.rm(tempFile, { force: true });
    } catch (_cleanupError) {
      // Ignore cleanup errors.
    }
  } finally {
    stateWriteInFlight = false;
    if (stateWriteDirty) {
      scheduleStateStoreWrite();
    }
  }
}

function createEmptyStore() {
  return { updatedAt: 0, rooms: {} };
}

function normalizeExpiresAt(value) {
  return Number.isFinite(value) && value > Date.now() ? value : null;
}

function countLocalClients() {
  let count = 0;
  for (const room of rooms.values()) {
    count += getConnectedClientCount(room);
  }

  return count;
}

function getClientsByRoom() {
  return [...rooms.values()].map((room) => ({
    room: room.name,
    clients: getConnectedClientCount(room),
    connectedClients: getConnectedClientCount(room),
    eventStreamClients: room.eventStreams.size,
    sequenceLength: room.sequence.length,
    revision: normalizeRevision(room.revision)
  }));
}

function maybeDeleteRoom(roomName, room) {
  if (room.eventStreams.size === 0) {
    clearTimeout(room.clearTimer);
    rooms.delete(roomName);
  }
}

function removeClientEventStreams(roomName, room, clientId) {
  let removed = 0;

  for (const eventStream of [...room.eventStreams]) {
    if (normalizeClientId(eventStream.uraClientId) !== clientId) {
      continue;
    }

    room.eventStreams.delete(eventStream);
    if (!eventStream.writableEnded) {
      eventStream.end();
    }
    removed += 1;
  }

  if (removed > 0) {
    if (room.eventStreams.size > 0) {
      broadcastRoomState(room);
    }
    maybeDeleteRoom(roomName, room);
  }

  return removed;
}

function recordActionMetric(roomName, transport) {
  metrics.lastActionAt = Date.now();
  metrics.lastActionRoom = roomName;
  metrics.lastActionTransport = transport;
}

function sendJson(response, statusCode, payload, headOnly = false) {
  response.writeHead(statusCode, createJsonHeaders());
  if (headOnly) {
    response.end();
    return;
  }

  response.end(JSON.stringify(payload));
}

function createJsonHeaders(extraHeaders = {}) {
  return {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders
  };
}

function broadcastRoomState(room) {
  const message = createStateMessage(room);
  for (const eventStream of room.eventStreams) {
    sendEventStreamState(eventStream, message);
  }

  metrics.eventStreamEvents += room.eventStreams.size;
}

function createStateMessage(room) {
  return {
    type: "state",
    room: room.name,
    sequence: filterSequence(room.sequence),
    expiresAt: room.expiresAt,
    revision: normalizeRevision(room.revision),
    sourceId: normalizeSourceId(room.sourceId),
    sourceRevision: normalizeRevision(room.sourceRevision),
    updatedAt: Number(room.updatedAt || Date.now()),
    autoClearMs: AUTO_CLEAR_MS,
    connectedClients: getConnectedClientCount(room),
    expectedDesktopClientVersion: EXPECTED_DESKTOP_CLIENT_VERSION,
    serverTime: Date.now()
  };
}

function sendEventStreamState(response, message) {
  if (!response.writableEnded) {
    response.write(`event: state\ndata: ${JSON.stringify(message)}\n\n`);
  }
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

function getConnectedClientCount(room) {
  if (!room?.eventStreams) {
    return 0;
  }

  const clientIds = new Set();
  for (const eventStream of room.eventStreams) {
    clientIds.add(normalizeClientId(eventStream.uraClientId) || `stream-${clientIds.size}`);
  }

  return clientIds.size;
}

function normalizeRevision(value) {
  const revision = Number(value);
  return Number.isFinite(revision) && revision > 0 ? revision : 0;
}

function normalizeSourceId(value) {
  const sourceId = String(value || "").trim();
  return /^[a-z0-9_-]{8,80}$/i.test(sourceId) ? sourceId : "";
}

function normalizeClientId(value) {
  const clientId = String(value || "").trim();
  return /^[a-z0-9_-]{8,80}$/i.test(clientId) ? clientId : "";
}

function createAnonymousClientId() {
  return `anon-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeSourceRevisions(value) {
  const result = {};
  if (!value || typeof value !== "object") {
    return result;
  }

  for (const [sourceId, sourceRevision] of Object.entries(value)) {
    const normalizedSourceId = normalizeSourceId(sourceId);
    const normalizedSourceRevision = normalizeRevision(sourceRevision);
    if (normalizedSourceId && normalizedSourceRevision) {
      result[normalizedSourceId] = normalizedSourceRevision;
    }
  }

  return result;
}

function isStaleSourceRevision(room, sourceId, sourceRevision) {
  if (!sourceId || !sourceRevision) {
    return false;
  }

  return sourceRevision <= normalizeRevision(room.sourceRevisions?.[sourceId]);
}

function recordRoomSourceRevision(room, sourceId, sourceRevision) {
  if (!sourceId || !sourceRevision) {
    return;
  }

  room.sourceRevisions = room.sourceRevisions || {};
  room.sourceRevisions[sourceId] = Math.max(normalizeRevision(room.sourceRevisions[sourceId]), sourceRevision);
  room.sourceId = sourceId;
  room.sourceRevision = room.sourceRevisions[sourceId];
}

function nextServerRevision(currentRevision = 0) {
  const timeRevision = Date.now() * 1000;
  serverRevision = Math.max(serverRevision + 1, timeRevision, normalizeRevision(currentRevision) + 1);
  return serverRevision;
}

function normalizeRoom(value) {
  const room = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_-]{3,48}$/.test(room) ? room : "";
}

function serveStaticAsset(pathname, response, headOnly) {
  let decodedPath = "/";

  try {
    decodedPath = decodeURIComponent(pathname || "/");
  } catch (_error) {
    sendNotFound(response);
    return;
  }

  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendNotFound(response);
    return;
  }

  let fileStat = null;
  try {
    fileStat = fs.statSync(filePath);
  } catch (_error) {
    sendNotFound(response);
    return;
  }

  if (!fileStat.isFile()) {
    sendNotFound(response);
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": getMimeType(filePath)
  });

  if (headOnly) {
    response.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    response.end("Server error\n");
  });
  stream.pipe(response);
}

function getMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function sendNotFound(response) {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found\n");
}