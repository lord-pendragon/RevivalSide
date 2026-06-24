const { parentPort, workerData } = require("worker_threads");
const { spawn } = require("child_process");

let child = null;
let stdoutBuffer = "";
let stderrBuffer = "";
let lastChildError = "";
const pending = [];

startChild();
parentPort.on("close", stopChild);
process.on("exit", stopChild);

parentPort.on("message", (message) => {
  if (!message || !message.sharedBuffer) return;
  const unavailable = childUnavailableError();
  if (unavailable) {
    complete(message.sharedBuffer, JSON.stringify({ ok: false, error: unavailable }));
    return;
  }
  pending.push(message.sharedBuffer);
  child.stdin.write(`${message.input}\n`, (err) => {
    if (!err) return;
    completePending(message.sharedBuffer, `C# combat host stdin failed: ${err.message || err}`);
  });
});

function startChild() {
  const runDirectly = Boolean(workerData.runDirectly);
  const fileName = runDirectly ? workerData.hostPath : workerData.dotnetPath || "dotnet";
  const args = runDirectly ? ["--stdio"] : [workerData.hostPath, "--stdio"];
  child = spawn(fileName, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  child.on("error", (err) => {
    failChild(`C# combat host failed to start: ${err.message || err}`);
  });

  child.stdin.on("error", (err) => {
    failChild(`C# combat host stdin failed: ${err.message || err}`);
  });

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      const sharedBuffer = pending.shift();
      if (sharedBuffer) complete(sharedBuffer, line || JSON.stringify({ ok: false, error: "empty host response" }));
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString("utf8");
    if (stderrBuffer.length > 8192) stderrBuffer = stderrBuffer.slice(-8192);
  });

  child.on("exit", (code, signal) => {
    failChild(`C# combat host exited code=${code} signal=${signal || ""} ${stderrBuffer.trim()}`.trim());
  });
}

function childUnavailableError() {
  if (!child) return lastChildError || "C# combat host process is not running";
  if (child.exitCode !== null || child.signalCode) {
    return lastChildError || `C# combat host exited code=${child.exitCode} signal=${child.signalCode || ""}`.trim();
  }
  if (child.killed || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
    return lastChildError || "C# combat host process is not running";
  }
  return "";
}

function failChild(error) {
  lastChildError = error || "C# combat host process is not running";
  child = null;
  while (pending.length) complete(pending.shift(), JSON.stringify({ ok: false, error: lastChildError }));
}

function stopChild() {
  if (!child) return;
  const current = child;
  child = null;
  try {
    if (!current.killed) current.kill();
  } catch (_) {}
}

function completePending(sharedBuffer, error) {
  const index = pending.indexOf(sharedBuffer);
  if (index >= 0) pending.splice(index, 1);
  complete(sharedBuffer, JSON.stringify({ ok: false, error }));
}

function complete(sharedBuffer, text) {
  const header = new Int32Array(sharedBuffer, 0, 2);
  const bytes = Buffer.from(sharedBuffer, 8);
  const payload = Buffer.from(String(text), "utf8");
  if (payload.length > bytes.length) {
    const error = Buffer.from(JSON.stringify({ ok: false, error: "C# combat host response exceeded shared buffer" }), "utf8");
    error.copy(bytes, 0, 0, Math.min(error.length, bytes.length));
    Atomics.store(header, 1, Math.min(error.length, bytes.length));
  } else {
    payload.copy(bytes, 0);
    Atomics.store(header, 1, payload.length);
  }
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0, 1);
}
