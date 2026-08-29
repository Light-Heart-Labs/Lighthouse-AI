// Pixel Agent host ingress.
//
// Dependency-free (Node 20+ built-ins only) Unix-domain-socket HTTP ingress
// that exposes a single Pixel gateway to a restricted group over
// POST /v1/chat/completions and GET /health. It never listens on TCP, never
// reads inbound headers, never forwards unknown request fields, and never
// exposes the operator gateway token to callers.
//
// This file is importable for tests and only starts the server when run
// directly as the main module.

import http from "node:http";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY = 2 * 1024 * 1024; // 2 MiB request body cap
const MAX_NONSTREAM_RESPONSE = 2 * 1024 * 1024; // 2 MiB non-stream response cap
const MAX_SSE_LINE = 1024 * 1024; // 1 MiB stream line cap
const CONNECT_TIMEOUT_MS = 5000;
// OpenClaw's ODS-owned provider is capped at 30 minutes. Keep the private
// ingress one bounded step outside that ceiling so CPU-only prefill can finish
// and the gateway, rather than an intermediate proxy, owns terminal timeout.
const TOTAL_TIMEOUT_MS = 1920000;
const GATEWAY_PROBE_TIMEOUT_MS = 2000;
const GATEWAY_ABORT_TIMEOUT_MS = 5000;
const DOCKER_TIMEOUT_MS = 10000;
const MAX_TOKEN_LEN = 4096;
const MAX_CANCEL_BODY = 256;
const MAX_STATUS_INTERVAL_MS = 86400000; // 1 day
const STATUS_MODE = 0o640; // group-readable, service-owner-writable projection
const ODS_VERSION_RE = /^(?:unknown|[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?)$/;
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+ -]{0,199}$/;

// The only request-body fields that may reach the gateway. Everything else is
// dropped on construction.
const ALLOWED_FIELDS = {
  messages: validMessages,
  stream: (v) => typeof v === "boolean",
  temperature: (v) => typeof v === "number" && Number.isFinite(v),
  top_p: (v) => typeof v === "number" && Number.isFinite(v),
  max_tokens: (v) => Number.isInteger(v) && v > 0,
  stop: (v) =>
    typeof v === "string" ||
    (Array.isArray(v) && v.every((s) => typeof s === "string")),
  tools: (v) =>
    Array.isArray(v) &&
    v.every((o) => o && typeof o === "object" && !Array.isArray(o)),
  tool_choice: (v) =>
    typeof v === "string" || (v && typeof v === "object" && !Array.isArray(v)),
  response_format: (v) => v && typeof v === "object" && !Array.isArray(v),
};

// A message is valid for OpenAI chat only when it carries a nonempty role and
// either a string content or an array of content parts. Anything nested and
// malformed is rejected instead of forwarded.
function validMessage(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return false;
  if (typeof m.role !== "string" || m.role.length === 0) return false;
  const c = m.content;
  if (typeof c === "string") return true;
  if (Array.isArray(c)) {
    return (
      c.length > 0 &&
      c.every(
        (part) =>
          part &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          typeof part.type === "string" &&
          part.type.length > 0
      )
    );
  }
  return false;
}

function validMessages(v) {
  return Array.isArray(v) && v.length > 0 && v.every(validMessage);
}

// Fixed allowlist of ODS service names/statuses the status projection may
// report. Container names outside this list are never surfaced.
const ALLOWED_SERVICES = new Set([
  "ods-pixel-edge",
  "pixel-edge",
  "ods-pixel-agent",
  "pixel-agent",
  "ods-openclaw",
  "openclaw",
  "ods-hermes",
  "hermes",
  "ods-hermes-proxy",
  "hermes-proxy",
  "ods-open-webui",
  "open-webui",
  "openwebui",
  "ods-dashboard",
  "dashboard",
  "ods-dashboard-api",
  "dashboard-api",
  "ods-llama-server",
  "llama-server",
  "ods-searxng",
  "searxng",
  "ods-langfuse",
  "langfuse",
  "ods-litellm",
  "litellm",
  "ods-qdrant",
  "qdrant",
  "ods-n8n",
  "n8n",
  "ods-model-router",
  "model-router",
  "ods-tts",
  "tts",
  "ods-whisper",
  "whisper",
  "ods-embeddings",
  "embeddings",
  "ods-opencode",
  "opencode",
  "ods-ape",
  "ods-perplexica",
  "ods-privacy-shield",
  "ods-remote-provider-egress",
  "ods-remote-provider-ssh-tunnel",
  "ods-token-spy",
  "ods-webui",
]);

// Status enum the projection may use. Never raw Docker status strings.
const STATUS_ENUM = new Set(["running", "healthy", "unhealthy", "starting", "stopped"]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Injectable dependencies (defaults to the real host primitives). Tests pass
// a `deps` object with fakes for deterministic behavior.
// ---------------------------------------------------------------------------

// Node's built-in fetch is backed by Undici, whose implicit response-body idle
// timeout is five minutes. A CPU-only OpenClaw turn can legitimately produce no
// bytes for longer than that while evaluating its first prompt. Use the core
// HTTP client for this fixed loopback hop so the explicit connect and total
// AbortController budgets below are the only transport deadlines.
export function gatewayFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    let connectTimer = null;
    const clearConnectTimer = () => {
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    };
    const request = http.request(
      url,
      {
        method: options.method,
        headers: options.headers,
        signal: options.signal,
        agent: false,
      },
      (response) => {
        clearConnectTimer();
        const headers = {
          get(name) {
            const value = response.headers[String(name).toLowerCase()];
            if (Array.isArray(value)) return value.join(", ");
            return typeof value === "string" ? value : null;
          },
        };
        resolve({
          status: response.statusCode || 0,
          headers,
          body: Readable.toWeb(response),
        });
      }
    );
    request.once("socket", (socket) => {
      if (!socket.connecting) {
        clearConnectTimer();
        return;
      }
      socket.once("connect", clearConnectTimer);
    });
    request.once("error", (error) => {
      clearConnectTimer();
      reject(error);
    });
    connectTimer = setTimeout(() => {
      request.destroy(new Error("gateway connect timeout"));
    }, CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();
    request.end(options.body);
  });
}

const defaultDeps = {
  execFile,
  fetch: gatewayFetch,
  setTimeout,
  clearTimeout,
};

// ---------------------------------------------------------------------------
// Configuration (read once at import; overridable via env)
// ---------------------------------------------------------------------------

export function validateConfig(cfg) {
  const port = Number(cfg.gatewayPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid gateway port");
  }
  const interval = Number(cfg.statusIntervalMs);
  if (!Number.isInteger(interval) || interval <= 0 || interval > MAX_STATUS_INTERVAL_MS) {
    throw new Error("invalid status interval");
  }
  if (cfg.ingressGid != null) {
    const gid = Number(cfg.ingressGid);
    if (!Number.isInteger(gid) || gid < 0) {
      throw new Error("invalid ingress gid");
    }
  }
  if (typeof cfg.odsVersion !== "string" || !ODS_VERSION_RE.test(cfg.odsVersion)) {
    throw new Error("invalid ODS version");
  }
  for (const [label, value] of [
    ["socket path", cfg.socketPath],
    ["gateway token file", cfg.gatewayTokenFile],
    ["status file", cfg.statusFile],
  ]) {
    if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
      throw new Error(`invalid ${label}`);
    }
  }
  return cfg;
}

export function configFromEnv(env = process.env) {
  const cfg = {
    socketPath: env.PIXEL_INGRESS_SOCKET || "/run/ods-pixel/pixel-ingress.sock",
    gatewayTokenFile:
      env.PIXEL_GATEWAY_TOKEN_FILE || "/etc/pixel/openclaw.json",
    gatewayPort: Number(env.PIXEL_GATEWAY_PORT || "18789"),
    statusFile: env.PIXEL_STATUS_FILE || "/run/ods-pixel/ods-status.json",
    statusIntervalMs: Number(env.PIXEL_STATUS_INTERVAL_MS || "30000"),
    ingressGid: env.PIXEL_INGRESS_GID ? Number(env.PIXEL_INGRESS_GID) : null,
    odsVersion: env.PIXEL_ODS_VERSION || "unknown",
  };
  return validateConfig(cfg);
}

// ---------------------------------------------------------------------------
// Gateway token: read only from the explicit PIXEL_GATEWAY_TOKEN_FILE. ODS
// points this at Pixel's owner-private OpenClaw JSON; the env-file form remains
// accepted for isolated tests and controlled migrations. Refuse symlinks,
// non-regular files, group/world-readable modes, or an owner other than the
// process euid. The token itself must be whitespace-free, control-free, and
// bounded in length.
// ---------------------------------------------------------------------------

export function readGatewayToken(
  file,
  euid = typeof process.geteuid === "function"
    ? process.geteuid()
    : (typeof process.getuid === "function" ? process.getuid() : 0)
) {
  const noFollow = fs.constants.O_NOFOLLOW;
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink()) {
    throw new Error("refusing symlink token file");
  }
  if (!before.isFile()) {
    throw new Error("token path is not a regular file");
  }
  let fd;
  let raw;
  try {
    try {
      const flags = fs.constants.O_RDONLY | (typeof noFollow === "number" ? noFollow : 0);
      fd = fs.openSync(file, flags);
    } catch (error) {
      if (error?.code === "ELOOP") {
        throw new Error("refusing symlink token file");
      }
      throw error;
    }
    const st = fs.fstatSync(fd);
    const after = fs.lstatSync(file);
    if (after.isSymbolicLink()) {
      throw new Error("refusing symlink token file");
    }
    if (!st.isFile()) {
      throw new Error("token path is not a regular file");
    }
    if (st.dev !== after.dev || st.ino !== after.ino) {
      throw new Error("token file changed during secure open");
    }
    if (st.uid !== euid) {
      throw new Error("token file owner mismatch");
    }
    // Group-read (0o040) or world-read (0o004) => refuse. Only owner rw remains.
    if (st.mode & 0o077) {
      throw new Error("token file is group/world readable");
    }
    raw = fs.readFileSync(fd, "utf8");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let value = "";
  if (raw.trimStart().startsWith("{")) {
    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      throw new Error("gateway token file contains invalid JSON");
    }
    value = config?.gateway?.auth?.token ?? config?.gateway?.token ?? "";
  } else {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim().startsWith("PIXEL_GATEWAY_TOKEN=")) continue;
      value = line.slice(line.indexOf("=") + 1);
      break;
    }
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("gateway token missing or empty");
  }
  if (value.trim() !== value) {
    throw new Error("token has surrounding whitespace");
  }
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("token contains control characters");
  }
  if (value.length > MAX_TOKEN_LEN) {
    throw new Error("token too long");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Socket setup: remove only an existing socket owned by this service path;
// reject any other existing non-socket path. Never listen on TCP.
// ---------------------------------------------------------------------------

export function prepareSocketPath(socketPath) {
  let lst;
  try {
    lst = fs.lstatSync(socketPath);
  } catch (err) {
    if (err.code === "ENOENT") return; // clean
    throw err;
  }
  if (!lst.isSocket()) {
    throw new Error("refusing non-socket path at ingress socket");
  }
  fs.unlinkSync(socketPath); // safe: it is a socket at our service path
}

// ---------------------------------------------------------------------------
// Body reading with a hard cap.
// ---------------------------------------------------------------------------

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const cl = req.headers["content-length"];
    if (cl !== undefined) {
      const length = Number(cl);
      if (!Number.isSafeInteger(length) || length < 0) {
        reject(new HttpError(400, "invalid content length"));
        return;
      }
      if (length > limit) {
        reject(new HttpError(413, "request too large"));
        return;
      }
    }
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
      req.removeAllListeners("data");
      req.resume();
    };
    req.on("data", (c) => {
      if (settled) return;
      total += c.length;
      if (total > limit) {
        fail(new HttpError(413, "request too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => fail(error));
  });
}

// ---------------------------------------------------------------------------
// Allowlisted request construction.
// ---------------------------------------------------------------------------

export function buildOutgoing(parsed, sessionUser) {
  const out = { model: "openclaw/default" };
  for (const key of Object.keys(ALLOWED_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
    const v = parsed[key];
    if (v === undefined || !ALLOWED_FIELDS[key](v)) {
      throw new HttpError(400, "invalid request body");
    }
    out[key] = v;
  }
  if (sessionUser) out.user = sessionUser;
  return out;
}

export function computeSessionUser(parsed) {
  const md =
    parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)
      ? parsed.metadata
      : {};
  let chosen;
  if (typeof parsed.user === "string" && parsed.user.length > 0) {
    chosen = parsed.user;
  } else if (typeof md.chat_id === "string" && md.chat_id.length > 0) {
    chosen = md.chat_id;
  } else if (typeof md.conversation_id === "string" && md.conversation_id.length > 0) {
    chosen = md.conversation_id;
  }
  if (chosen === undefined) return null;
  return "ods-" + createHash("sha256").update(chosen, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Upstream forwarding. Fixed loopback only; fresh allowlisted headers; bounded
// connect/body/stream behavior; generic sanitized errors.
// ---------------------------------------------------------------------------

function upstreamHeaders(stream, token) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
  };
}

// Consume/discard an upstream body without reflecting it (used for errors).
async function drain(body) {
  if (!body || typeof body.cancel !== "function") return;
  try {
    await body.cancel();
  } catch {
    /* ignore */
  }
}

async function abortGatewayRun(user, token, gatewayPort, deps) {
  if (typeof user !== "string" || !/^ods-[0-9a-f]{64}$/.test(user)) return false;
  const controller = new AbortController();
  const timer = deps.setTimeout(() => controller.abort(), GATEWAY_ABORT_TIMEOUT_MS);
  try {
    const response = await deps.fetch(
      `http://127.0.0.1:${gatewayPort}/pixel-ods/abort`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ user }),
        redirect: "error",
        signal: controller.signal,
      }
    );
    if (response.status < 200 || response.status >= 300) {
      await drain(response.body);
      return false;
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      await drain(response.body);
      return false;
    }
    const body = await readBounded(response.body, 1024);
    const result = JSON.parse(body.toString("utf8"));
    return Boolean(
      result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      Object.keys(result).length === 1 &&
      result.aborted === true
    );
  } catch {
    return false;
  } finally {
    deps.clearTimeout(timer);
  }
}

async function readBounded(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new HttpError(502, "upstream response too large");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

async function streamSse(stream, res) {
  const reader = stream.getReader();
  let buffered = Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered = Buffer.concat([buffered, Buffer.from(value)]);
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline === -1) break;
        const line = buffered.subarray(0, newline + 1);
        if (line.length - 1 > MAX_SSE_LINE) {
          throw new HttpError(502, "upstream stream failed");
        }
        if (!res.write(line)) {
          await new Promise((resolve, reject) => {
            res.once("drain", resolve);
            res.once("error", reject);
          });
        }
        buffered = buffered.subarray(newline + 1);
      }
      if (buffered.length > MAX_SSE_LINE) {
        throw new HttpError(502, "upstream stream failed");
      }
    }
    if (buffered.length) res.write(buffered);
    res.end();
  } catch {
    if (!res.destroyed && !res.writableEnded) {
      res.write('data: {"error":{"message":"upstream stream failed","type":"pixel_ingress_error"}}\n\n');
      res.end("data: [DONE]\n\n");
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

async function forwardChat(res, outgoing, token, gatewayPort, deps = defaultDeps) {
  const controller = new AbortController();
  const totalTimer = deps.setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  const abortOnDownstreamClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  // Socket close remains transport cleanup only. The explicit /v1/chat/cancel
  // control path owns run cancellation and draining, because an intermediate
  // proxy can consume a close before it reaches this response object.
  res.once("close", abortOnDownstreamClose);
  const wantsStream = outgoing.stream === true;
  try {
    const upstream = await deps.fetch(
      `http://127.0.0.1:${gatewayPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: upstreamHeaders(wantsStream, token),
        body: JSON.stringify(outgoing),
        redirect: "error",
        signal: controller.signal,
      }
    );
    if (upstream.status < 200 || upstream.status >= 300) {
      await drain(upstream.body);
      sendError(res, upstream.status >= 400 && upstream.status < 500 ? 400 : 502, "pixel request rejected");
      return;
    }

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
    if (wantsStream) {
      if (!contentType.startsWith("text/event-stream")) {
        await drain(upstream.body);
        sendError(res, 502, "invalid upstream response");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      await streamSse(upstream.body, res);
      return;
    }

    if (!contentType.startsWith("application/json")) {
      await drain(upstream.body);
      sendError(res, 502, "invalid upstream response");
      return;
    }
    const body = await readBounded(upstream.body, MAX_NONSTREAM_RESPONSE);
    try {
      JSON.parse(body.toString("utf8"));
    } catch {
      sendError(res, 502, "invalid upstream response");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (error) {
    if (!res.headersSent) {
      const message = error instanceof HttpError ? error.message : "upstream unavailable";
      sendError(res, error instanceof HttpError ? error.status : 502, message);
    } else if (!res.writableEnded) {
      res.destroy();
    }
  } finally {
    res.off("close", abortOnDownstreamClose);
    deps.clearTimeout(totalTimer);
  }
}

function sendError(res, status, message) {
  if (res.headersSent) {
    if (!res.writableEnded) res.destroy();
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ error: { message, type: "pixel_ingress_error" } }));
}

function sendJson(res, status, payload) {
  if (res.headersSent) {
    if (!res.writableEnded) res.destroy();
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

export async function checkGatewayReachable(gatewayPort, deps = defaultDeps) {
  const controller = new AbortController();
  const timer = deps.setTimeout(() => controller.abort(), GATEWAY_PROBE_TIMEOUT_MS);
  try {
    const response = await deps.fetch(`http://127.0.0.1:${gatewayPort}/health`, {
      redirect: "error",
      signal: controller.signal,
    });
    await drain(response.body);
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  } finally {
    deps.clearTimeout(timer);
  }
}

function execFilePromise(execImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    let completed = false;
    const callback = (error, stdout = "") => {
      if (completed) return;
      completed = true;
      if (error) reject(error);
      else resolve({ stdout });
    };
    try {
      const result = execImpl(command, args, options, callback);
      if (result && typeof result.then === "function") {
        result.then((value) => {
          if (completed) return;
          completed = true;
          resolve(value || { stdout: "" });
        }, callback);
      }
    } catch (error) {
      callback(error);
    }
  });
}

function normalizedContainerStatus(record) {
  const raw = String(record.Status || "").toLowerCase();
  const state = String(record.State || "").toLowerCase();
  if (raw.includes("unhealthy")) return "unhealthy";
  if (raw.includes("health: starting") || raw.includes("starting")) return "starting";
  if (raw.includes("healthy")) return "healthy";
  if (state === "running" || raw.startsWith("up ") || raw === "up") return "running";
  if (state === "restarting" || state === "created" || raw.startsWith("restarting")) {
    return "starting";
  }
  if (
    ["exited", "dead", "paused"].includes(state) ||
    /^(?:exited|dead|created|paused)\b/.test(raw)
  ) {
    return "stopped";
  }
  return null;
}

export async function dockerApps(deps = defaultDeps) {
  const { stdout } = await execFilePromise(
    deps.execFile,
    "docker",
    ["ps", "--all", "--format", "{{json .}}"],
    { timeout: DOCKER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }
  );
  const apps = [];
  const seen = new Set();
  for (const line of String(stdout || "").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const status = normalizedContainerStatus(record);
    if (!STATUS_ENUM.has(status)) continue;
    for (let name of String(record.Names || "").split(",")) {
      name = name.trim().replace(/^\/+/, "");
      if (!ALLOWED_SERVICES.has(name) || seen.has(name)) continue;
      seen.add(name);
      apps.push({ name, status });
    }
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  return apps;
}

export async function dockerRuntime(deps = defaultDeps) {
  const { stdout } = await execFilePromise(
    deps.execFile,
    "docker",
    ["inspect", "ods-llama-server", "--format", "{{json .Config.Cmd}}"],
    { timeout: DOCKER_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true }
  );
  let command;
  try {
    command = JSON.parse(String(stdout || ""));
  } catch {
    return null;
  }
  if (!Array.isArray(command) || !command.every((item) => typeof item === "string")) {
    return null;
  }
  const modelIndex = command.indexOf("--model");
  const contextIndex = command.indexOf("--ctx-size");
  if (modelIndex < 0 || contextIndex < 0) return null;
  const modelPath = command[modelIndex + 1];
  const contextLength = Number(command[contextIndex + 1]);
  if (typeof modelPath !== "string" || !modelPath.startsWith("/models/")) return null;
  const model = path.posix.basename(modelPath);
  if (
    model !== modelPath.slice("/models/".length) ||
    !MODEL_NAME_RE.test(model) ||
    !Number.isInteger(contextLength) ||
    contextLength < 4096 ||
    contextLength > 1048576
  ) {
    return null;
  }
  return { model, context_length: contextLength };
}

export function atomicWriteJson(file, value, fsImpl = fs) {
  const directory = path.dirname(file);
  const directoryStat = fsImpl.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("unsafe status directory");
  }
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
      flag: "wx",
      mode: STATUS_MODE,
    });
    fsImpl.chmodSync(temporary, STATUS_MODE);
    fsImpl.renameSync(temporary, file);
  } catch (error) {
    try {
      fsImpl.unlinkSync(temporary);
    } catch {
      /* no temporary file to remove */
    }
    throw error;
  }
}

export async function writeStatus(
  ingressReady,
  gatewayPort,
  statusFile,
  odsVersion = "unknown",
  deps = defaultDeps
) {
  const gatewayReachable = await checkGatewayReachable(gatewayPort, deps);
  let apps = [];
  let runtime = null;
  let docker = "unavailable";
  try {
    apps = await dockerApps(deps);
    docker = "ok";
  } catch {
    apps = [];
  }
  if (docker === "ok") {
    try {
      runtime = await dockerRuntime(deps);
    } catch {
      runtime = null;
    }
  }
  const onlineApps = apps.filter(({ status }) => status === "healthy" || status === "running").length;
  const projection = {
    schema_version: 2,
    timestamp: new Date().toISOString(),
    service: "pixel-agent",
    ods_version: odsVersion,
    ingress_ready: Boolean(ingressReady),
    gateway_reachable: gatewayReachable,
    docker,
    online_apps: onlineApps,
    runtime,
    apps,
  };
  atomicWriteJson(statusFile, projection);
  return projection;
}

export function createIngressServer({ token, gatewayPort, deps = defaultDeps }) {
  return http.createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://pixel-ingress.invalid").pathname;
    } catch {
      sendError(res, 400, "bad request");
      return;
    }

    if (pathname === "/health") {
      if (req.method !== "GET") {
        sendError(res, 405, "method not allowed");
        return;
      }
      void checkGatewayReachable(gatewayPort, deps).then((ready) => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(ready ? 200 : 503, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ status: ready ? "ok" : "unavailable" }));
      });
      return;
    }

    if (pathname === "/v1/chat/completions") {
      if (req.method !== "POST") {
        sendError(res, 405, "method not allowed");
        return;
      }
      const contentType = String(req.headers["content-type"] || "").toLowerCase();
      if (contentType.split(";", 1)[0].trim() !== "application/json") {
        sendError(res, 415, "content type must be application/json");
        return;
      }
      void handleChat(req, res, token, gatewayPort, deps);
      return;
    }

    if (pathname === "/v1/chat/cancel") {
      if (req.method !== "POST") {
        sendError(res, 405, "method not allowed");
        return;
      }
      const contentType = String(req.headers["content-type"] || "").toLowerCase();
      if (contentType.split(";", 1)[0].trim() !== "application/json") {
        sendError(res, 415, "content type must be application/json");
        return;
      }
      void handleCancel(req, res, token, gatewayPort, deps);
      return;
    }

    sendError(res, 404, "not found");
  });
}

async function handleCancel(req, res, token, gatewayPort, deps) {
  let raw;
  try {
    raw = await readBody(req, MAX_CANCEL_BODY);
  } catch (error) {
    sendError(
      res,
      error instanceof HttpError ? error.status : 400,
      error instanceof HttpError ? error.message : "bad request"
    );
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    sendError(res, 400, "invalid json");
    return;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    typeof parsed.user !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.user)
  ) {
    sendError(res, 400, "invalid cancellation request");
    return;
  }
  const user = computeSessionUser({ user: parsed.user });
  sendJson(res, 200, { aborted: await abortGatewayRun(user, token, gatewayPort, deps) });
}

async function handleChat(req, res, token, gatewayPort, deps) {
  let raw;
  try {
    raw = await readBody(req, MAX_BODY);
  } catch (error) {
    sendError(
      res,
      error instanceof HttpError ? error.status : 400,
      error instanceof HttpError ? error.message : "bad request"
    );
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    sendError(res, 400, "invalid json");
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendError(res, 400, "invalid request body");
    return;
  }

  try {
    const outgoing = buildOutgoing(parsed, computeSessionUser(parsed));
    await forwardChat(res, outgoing, token, gatewayPort, deps);
  } catch (error) {
    sendError(
      res,
      error instanceof HttpError ? error.status : 400,
      error instanceof HttpError ? error.message : "invalid request body"
    );
  }
}

function listenUnix(server, socketPath) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

export async function start(cfg = configFromEnv(), opts = {}) {
  const deps = { ...defaultDeps, ...(opts.deps || {}) };
  let startupStage = "configuration";
  let server;
  try {
    validateConfig(cfg);
    startupStage = "token-read";
    const token = readGatewayToken(cfg.gatewayTokenFile, opts.euid);
    startupStage = "socket-prepare";
    prepareSocketPath(cfg.socketPath);
    server = createIngressServer({ token, gatewayPort: cfg.gatewayPort, deps });
    startupStage = "socket-listen";
    await listenUnix(server, cfg.socketPath);
    startupStage = "runtime-state";
    fs.chmodSync(cfg.socketPath, 0o660);
    if (cfg.ingressGid !== null) fs.chownSync(cfg.socketPath, -1, cfg.ingressGid);
    await writeStatus(true, cfg.gatewayPort, cfg.statusFile, cfg.odsVersion, deps);
  } catch (error) {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
      try {
        fs.unlinkSync(cfg.socketPath);
      } catch {
        /* socket already absent */
      }
    }
    if (error && typeof error === "object") error.pixelStartupStage = startupStage;
    throw error;
  }

  const interval = setInterval(() => {
    void writeStatus(true, cfg.gatewayPort, cfg.statusFile, cfg.odsVersion, deps).catch(() => {});
  }, cfg.statusIntervalMs);
  interval.unref();
  let closed = false;
  return {
    server,
    interval,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      await new Promise((resolve) => server.close(resolve));
      try {
        const current = fs.lstatSync(cfg.socketPath);
        if (current.isSocket()) fs.unlinkSync(cfg.socketPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  start()
    .then((handle) => {
      console.log("pixel-ingress ready");
      const shutdown = async () => {
        try {
          await handle.close();
          process.exit(0);
        } catch {
          process.exit(1);
        }
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    })
    .catch((error) => {
      const allowedStages = new Set([
        "configuration", "token-read", "socket-prepare", "socket-listen", "runtime-state",
      ]);
      const stage = allowedStages.has(error?.pixelStartupStage) ? error.pixelStartupStage : "internal";
      console.error(`pixel-ingress failed to start (${stage})`);
      process.exit(1);
    });
}
