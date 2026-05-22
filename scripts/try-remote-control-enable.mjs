import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
let port = Number(args.port ?? process.env.CODEX_REMOTE_CONTROL_PORT ?? 0);
const keepAliveSeconds = Number(args["keep-alive"] ?? 600);
const connectTimeoutMs = Number(args["connect-timeout-ms"] ?? 45000);
const redactLogs = args["no-redact"] !== true;
let url = "";
const logDir = path.resolve(String(args["log-dir"] ?? defaultLogDir()));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logPath = path.join(logDir, `remote-control-enable-${stamp}.log`);
const codexCmd = findCodexCommand();
const useShell = process.platform === "win32" && codexCmd.toLowerCase().endsWith(".cmd");

function parseArgs(rawArgs) {
  const parsed = {};
  for (const arg of rawArgs) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const [key, ...rest] = arg.slice(2).split("=");
      parsed[key] = rest.join("=");
    } else if (arg.startsWith("--")) {
      parsed[arg.slice(2)] = true;
    }
  }
  return parsed;
}

function defaultLogDir() {
  return path.join(os.tmpdir(), "codex-remote-control");
}

function findCodexCommand() {
  if (process.env.CODEX_CLI_PATH && fs.existsSync(process.env.CODEX_CLI_PATH)) {
    return process.env.CODEX_CLI_PATH;
  }

  if (process.platform !== "win32") {
    return "codex";
  }

  const appData = process.env.APPDATA ?? "";
  const directCodexExe = path.join(
    appData,
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "codex",
    "codex.exe",
  );

  if (fs.existsSync(directCodexExe)) {
    return directCodexExe;
  }

  return path.join(appData, "npm", "codex.cmd");
}

function redactString(text) {
  if (!redactLogs || typeof text !== "string") {
    return text;
  }

  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>")
    .replace(/\\\\\?\\C:\\Users\\[^\\\s"'<>]+/gi, "\\\\?\\C:\\Users\\<redacted-user>")
    .replace(/C:\\Users\\[^\\\s"'<>]+/gi, "C:\\Users\\<redacted-user>")
    .replace(/\bDESKTOP-[A-Z0-9-]+\b/g, "<redacted-machine>")
    .replace(/\benv_[A-Za-z0-9_-]+\b/g, "<redacted-environment-id>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<redacted-uuid>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<redacted-ip>");
}

function shouldRedactField(key) {
  const lower = key.toLowerCase();
  return lower.includes("email") ||
    lower.includes("account") ||
    lower.includes("userid") ||
    lower.includes("user_id") ||
    lower.includes("tenant") ||
    lower.includes("workspace") ||
    lower.includes("profile") ||
    lower.includes("codexhome") ||
    lower.includes("home") ||
    lower.includes("path") ||
    lower.includes("dir") ||
    lower.includes("hostname") ||
    lower.includes("hostid") ||
    lower === "servername" ||
    lower === "installationid" ||
    lower === "environmentid";
}

function redact(value) {
  if (!redactLogs) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (shouldRedactField(key)) {
      result[key] = childValue ? `<redacted-${key}>` : childValue;
    } else {
      result[key] = redact(childValue);
    }
  }
  return result;
}

function log(message, data) {
  const safeData = data === undefined ? undefined : redact(data);
  const line = safeData === undefined ? message : `${message} ${JSON.stringify(safeData, null, 2)}`;
  console.log(line);
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(logPath, `${line}${os.EOL}`, "utf8");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const selectedPort = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (selectedPort) {
          resolve(selectedPort);
        } else {
          reject(new Error("Could not allocate a free local port"));
        }
      });
    });
  });
}

async function waitForWsReady(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const ws = new WebSocket(url);
      const opened = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 1000);
        ws.addEventListener("open", () => {
          clearTimeout(timer);
          resolve(true);
        }, { once: true });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          resolve(false);
        }, { once: true });
      });
      if (opened) {
        return ws;
      }
    } catch {
      // Retry below.
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function makeRpc(ws) {
  let nextId = 1;
  const pending = new Map();
  const notifications = [];

  ws.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
    const message = parseJson(raw);
    log("<--", message ?? raw);

    if (!message) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id") && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }

    if (message.method) {
      notifications.push(message);
    }
  });

  async function request(method, params, timeoutMs = 20000) {
    const id = nextId++;
    const payload = { id, method };
    if (params !== undefined) {
      payload.params = params;
    }

    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });

    log("-->", payload);
    ws.send(JSON.stringify(payload));
    const response = await responsePromise;
    if (response.error) {
      log(`ERROR ${method}`, response.error);
    }
    return response;
  }

  function notify(method, params) {
    const payload = { method };
    if (params !== undefined) {
      payload.params = params;
    }
    log("-->", payload);
    ws.send(JSON.stringify(payload));
  }

  return { request, notify, notifications };
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isConnectedStatus(message) {
  return message?.result?.status === "connected" ||
    (
      message?.method === "remoteControl/status/changed" &&
      message?.params?.status === "connected"
    );
}

async function waitForConnected(rpc, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (rpc.notifications.some(isConnectedStatus)) {
      return true;
    }

    const status = await rpc.request("remoteControl/status/read", {}, 10000);
    if (isConnectedStatus(status)) {
      return true;
    }

    await delay(2000);
  }
  return false;
}

function stopProcessTree(child) {
  if (!child || child.killed) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }

  child.kill();
}

async function main() {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port value: ${port}`);
  }

  if (port === 0) {
    port = await getFreePort();
  }
  url = `ws://127.0.0.1:${port}`;

  log(`Log file: ${logPath}`);
  log(`Starting temporary app-server on ${url}`);
  log(`Codex command: ${codexCmd}`);
  log(`Redacted logs: ${redactLogs}`);

  const child = spawn(codexCmd, [
    "app-server",
    "--listen",
    url,
    "--analytics-default-enabled",
    "--enable",
    "remote_control",
  ], {
    cwd: process.cwd(),
    env: process.env,
    shell: useShell,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => log("[app-server stdout]", chunk.toString("utf8").trimEnd()));
  child.stderr.on("data", (chunk) => log("[app-server stderr]", chunk.toString("utf8").trimEnd()));
  child.on("exit", (code, signal) => log(`[app-server exit] code=${code} signal=${signal}`));

  let ws;
  try {
    ws = await waitForWsReady();
    const rpc = makeRpc(ws);

    await rpc.request("initialize", {
      clientInfo: {
        name: "codex-mobile-remote-control-debug",
        title: "Codex mobile remote-control debug",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [],
      },
    });
    rpc.notify("initialized");

    await rpc.request("experimentalFeature/enablement/set", {
      enablement: {
        remote_control: true,
      },
    });

    const before = await rpc.request("remoteControl/status/read", {});
    log("status before enable", before);

    const enable = await rpc.request("remoteControl/enable", {});
    log("remoteControl/enable result", enable);

    const connected = isConnectedStatus(enable) || await waitForConnected(rpc, connectTimeoutMs);
    log(`remote-control connected? ${connected}`);

    if (!connected) {
      process.exitCode = 2;
      return;
    }

    if (keepAliveSeconds > 0) {
      log(`Keeping temporary app-server alive for ${keepAliveSeconds}s. Check ChatGPT/Codex mobile now.`);
      await delay(keepAliveSeconds * 1000);
    }
  } finally {
    try {
      ws?.close();
    } catch {
      // Ignore.
    }
    stopProcessTree(child);
    log("Temporary app-server stopped.");
  }
}

main().catch((error) => {
  log("FATAL", { message: error.message, stack: error.stack });
  process.exitCode = 1;
});
