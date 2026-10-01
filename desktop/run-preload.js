const { contextBridge, ipcRenderer } = require("electron");

// The run window's whole reach: its own program, and handing a failed run to the agent.
contextBridge.exposeInMainWorld("run", {
  restart: function () { return ipcRenderer.invoke("run-window-restart"); },
  stop: function () { return ipcRenderer.invoke("run-window-stop"); },
  input: function (text) { return ipcRenderer.invoke("run-window-input", text); },
  fullscreen: function (on) { return ipcRenderer.invoke("run-window-fullscreen", on); },
  fix: function () { return ipcRenderer.invoke("run-window-fix"); },
  close: function () { return ipcRenderer.invoke("run-window-close"); },
  onStarted: function (fn) { ipcRenderer.on("run-started", function (e, d) { fn(d); }); },
  onOutput: function (fn) { ipcRenderer.on("run-output", function (e, d) { fn(d); }); },
  onExit: function (fn) { ipcRenderer.on("run-exit", function (e, d) { fn(d); }); },
});
