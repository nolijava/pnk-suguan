"use strict";

// The packaged Next standalone server is a detached Windows console process.
// Windows taskkill without /F cannot deliver a close event to that process, so
// provide a local, same-user control channel that lets the application close its
// own HTTP servers before exiting.
const net = require("node:net");

const pipe = process.env.PNK_APP_CONTROL_PIPE;
let controlServer = null;
let shuttingDown = false;

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || typeof server.close !== "function" || !server.listening) {
      resolve();
      return;
    }
    try {
      server.close(() => resolve());
      // Keep shutdown bounded if a keep-alive or upgraded connection never drains.
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
      setTimeout(() => {
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        resolve();
      }, 1500).unref();
    } catch {
      resolve();
    }
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (controlServer) {
    await closeServer(controlServer);
    controlServer = null;
  }

  // Next's standalone server does not expose its http.Server to the launcher,
  // but it is an active handle in this process. Closing every HTTP server here
  // drains the production listener without terminating the process tree.
  const servers = process
    ._getActiveHandles()
    .filter((handle) => handle && handle.constructor && handle.constructor.name === "Server");
  for (const server of servers) await closeServer(server);

  // The standalone server has no remaining application-owned work after its
  // listener is closed. Exit from inside the application, rather than asking
  // the launcher to force-terminate the process.
  process.exitCode = 0;
  setImmediate(() => process.exit(0));
}

function requestShutdown(socket) {
  let body = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    body += chunk;
    if (body.trim() === "shutdown") {
      socket.end("ok\n");
      void shutdown();
    }
  });
  socket.on("error", () => {});
}

if (pipe) {
  controlServer = net.createServer(requestShutdown);
  controlServer.on("error", () => {
    // The launcher will fall back to its existing verified process path if the
    // control channel cannot be created.
  });
  controlServer.listen(pipe);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGBREAK", () => void shutdown());
