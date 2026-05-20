const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const AUTO_CLEAR_MS = 20_000;
const STATE_POLL_MS = 250;
const SYMBOLS = ["cross", "t", "circle", "diamond", "triangle"];
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
      rooms: knownRooms.size,
      localRooms: rooms.size,
      localClients: countLocalClients(),
      storedRooms: Object.keys(store.rooms).length,
      pid: process.pid
    }));
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

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  socket.room = null;
  socket.role = "reader";

  socket.on("message", (data) => {
    handleMessage(socket, data);
  });

  socket.on("close", () => {
    leaveRoom(socket);
  });

  socket.on("error", () => {
    leaveRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Ura Helper relay listening on :${PORT}`);
});

function handleMessage(socket, data) {
  let message = null;
  try {
    message = JSON.parse(data.toString());
  } catch (_error) {
    send(socket, { type: "error", message: "Message JSON invalide." });
    return;
  }

  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "join") {
    joinRoom(socket, message);
    return;
  }

  if (message.type === "state") {
    updateRoomState(socket, message);
  }
}

function joinRoom(socket, message) {
  const roomName = normalizeRoom(message.room);
  if (!roomName) {
    send(socket, { type: "error", message: "Salon invalide." });
    return;
  }

  leaveRoom(socket);
  socket.room = roomName;
  socket.role = message.role === "leader" ? "leader" : "reader";

  const room = getRoom(roomName);
  const storedRoom = readStoredRoom(roomName);
  if (storedRoom) {
    applyRoomState(room, storedRoom);
  } else {
    persistRoomState(room);
  }

  room.clients.add(socket);
  sendRoomState(socket, room);
}

function updateRoomState(socket, message) {
  if (!socket.room || socket.role !== "leader") {
    return;
  }

  const room = getRoom(socket.room);
  room.sequence = filterSequence(message.sequence);
  room.expiresAt = room.sequence.length === SYMBOLS.length ? Date.now() + AUTO_CLEAR_MS : null;
  room.updatedAt = Date.now();
  persistRoomState(room);
  scheduleRoomClear(socket.room, room);
  broadcastRoomState(room);
}

function leaveRoom(socket) {
  if (!socket.room) {
    return;
  }

  const room = rooms.get(socket.room);
  if (room) {
    room.clients.delete(socket);
    if (room.clients.size === 0) {
      clearTimeout(room.clearTimer);
      rooms.delete(socket.room);
    }
  }

  socket.room = null;
}

function getRoom(roomName) {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, {
      name: roomName,
      clients: new Set(),
      sequence: [],
      expiresAt: null,
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
  return Number(storedRoom.updatedAt || 0) > Number(room.updatedAt || 0)
    || JSON.stringify(storedRoom.sequence || []) !== JSON.stringify(room.sequence || [])
    || normalizeExpiresAt(storedRoom.expiresAt) !== normalizeExpiresAt(room.expiresAt);
}

function applyRoomState(room, storedRoom) {
  room.sequence = filterSequence(storedRoom.sequence);
  room.expiresAt = normalizeExpiresAt(storedRoom.expiresAt);
  room.updatedAt = Number(storedRoom.updatedAt || Date.now());
}

function persistRoomState(room) {
  const store = readStateStore();
  store.rooms[room.name] = {
    sequence: filterSequence(room.sequence),
    expiresAt: normalizeExpiresAt(room.expiresAt),
    updatedAt: Number(room.updatedAt || Date.now())
  };
  store.updatedAt = Date.now();
  writeStateStore(store);
}

function readStoredRoom(roomName) {
  const store = readStateStore();
  return store.rooms[roomName] || null;
}

function readStateStore() {
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

function writeStateStore(store) {
  const stateDir = path.dirname(STATE_FILE);
  const tempFile = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(store), "utf8");
    fs.renameSync(tempFile, STATE_FILE);
  } catch (error) {
    console.warn(`Unable to write relay state: ${error.message}`);
    try {
      fs.rmSync(tempFile, { force: true });
    } catch (_cleanupError) {
      // Ignore cleanup errors.
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
    count += room.clients.size;
  }

  return count;
}

function sendRoomState(socket, room) {
  send(socket, createStateMessage(room));
}

function broadcastRoomState(room) {
  const message = createStateMessage(room);
  for (const client of room.clients) {
    send(client, message);
  }
}

function createStateMessage(room) {
  return {
    type: "state",
    room: room.name,
    sequence: room.sequence,
    expiresAt: room.expiresAt,
    autoClearMs: AUTO_CLEAR_MS
  };
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
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