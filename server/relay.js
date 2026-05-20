const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const AUTO_CLEAR_MS = 20_000;
const SYMBOLS = ["cross", "t", "circle", "diamond", "triangle"];
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

const rooms = new Map();

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");

  if (requestUrl.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
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
      clearTimer: null
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
    broadcastRoomState(currentRoom);
  }, Math.max(0, room.expiresAt - Date.now()));
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