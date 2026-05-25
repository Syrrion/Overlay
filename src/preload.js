const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlayApi", {
  getStatus: () => ipcRenderer.invoke("status:get"),
  startSession: (options) => ipcRenderer.invoke("session:start", options),
  stopSession: () => ipcRenderer.invoke("session:stop"),
  setMovementLocked: (locked) => ipcRenderer.invoke("movement:setLocked", Boolean(locked)),
  setWindowScale: (target, scale) => ipcRenderer.invoke("window:setScale", target, scale),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("state:update", listener);
    return () => ipcRenderer.removeListener("state:update", listener);
  }
});