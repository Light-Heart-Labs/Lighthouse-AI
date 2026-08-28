// Pixel Agent host ingress contract tests.
//
// Runs against the importable implementation (no server auto-start). Covers:
//   - unsafe token file/symlink/mode rejection
//   - exact route/methods
//   - request limit
//   - header stripping
//   - forced model
//   - stable hashed user
//   - sanitized errors
//   - fixed docker execFile (mocked)
//   - safe status projection
//   - UDS permissions/path refusal
//   - streaming/nonstream bounds

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";

import {
  readGatewayToken,
  prepareSocketPath,
  createIngressServer,
  computeSessionUser,
  buildOutgoing,
  configFromEnv,
  validateConfig,
  dockerApps,
  writeStatus,
  start,
} from "../host/pixel_ingress.mjs";

const DIR = path.join(os.tmpdir(), `pixel-ingress-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(DIR, { recursive: true });
const SOCKET = path.join(DIR, "pixel-ingress.sock");
const TOKEN = "test-gateway-token-0123456789abcdef";
const EUID = typeof process.geteuid === "function"
  ? process.geteuid()
  : (typeof process.getuid === "function" ? process.getuid() : 0);
let socketCounter = 0;

// A fake upstream gateway that records exactly what it receives and returns a
// canned completion. Used to assert forced model, header stripping, hashed
// user, and streaming/nonstream bounds.
function fakeGateway({ onRequest } = {}) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const captured = { headers: req.headers, body: body ? JSON.parse(body) : null };
      if (onRequest) onRequest(captured);
      if (req.headers.accept === "text/event-stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n");
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "x", choices: [{ message: { content: "ok" } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function startIngress({ token = TOKEN, gatewayPort, socket, deps } = {}) {
  socket ||= path.join(DIR, `ingress-${++socketCounter}.sock`);
  prepareSocketPath(socket);
  const server = createIngressServer({
    token,
    gatewayPort,
    deps,
  });
  return new Promise((resolve, reject) => {
    server.once("listening", () => resolve(server));
    server.once("error", reject);
    server.listen(socket);
  });
}

function request(server, method, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: server.address(),
        method,
        path: pathname,
        headers: opts.headers || {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test("configFromEnv applies defaults and overrides", () => {
  const d = configFromEnv({});
  assert.equal(d.socketPath, "/run/ods-pixel/pixel-ingress.sock");
  assert.equal(d.gatewayPort, 18789);
  assert.equal(d.gatewayTokenFile, "/etc/pixel/openclaw.json");
  assert.equal(d.statusIntervalMs, 30000);
  assert.equal(d.ingressGid, null);
  const o = configFromEnv({
    PIXEL_INGRESS_SOCKET: "/x.sock",
    PIXEL_GATEWAY_PORT: "19000",
    PIXEL_INGRESS_GID: "1234",
    PIXEL_STATUS_INTERVAL_MS: "5000",
    PIXEL_GATEWAY_TOKEN_FILE: "/custom.json",
  });
  assert.equal(o.socketPath, "/x.sock");
  assert.equal(o.gatewayPort, 19000);
  assert.equal(o.ingressGid, 1234);
  assert.equal(o.statusIntervalMs, 5000);
});

test("config rejects invalid ports, intervals, gids, and relative paths", () => {
  const base = configFromEnv({});
  for (const gatewayPort of [0, 65536, 1.5, NaN]) {
    assert.throws(() => validateConfig({ ...base, gatewayPort }), /gateway port/);
  }
  for (const statusIntervalMs of [0, -1, 86400001, 1.5]) {
    assert.throws(() => validateConfig({ ...base, statusIntervalMs }), /status interval/);
  }
  assert.throws(() => validateConfig({ ...base, ingressGid: -1 }), /ingress gid/);
  assert.throws(() => validateConfig({ ...base, socketPath: "relative.sock" }), /socket path/);
});

// ---------------------------------------------------------------------------
// Token file rejection
// ---------------------------------------------------------------------------

test("readGatewayToken refuses symlink token file", () => {
  const target = path.join(DIR, "real.env");
  fs.writeFileSync(target, `PIXEL_GATEWAY_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  const link = path.join(DIR, "link.env");
  try {
    fs.unlinkSync(link);
  } catch {}
  fs.symlinkSync(target, link);
  assert.throws(() => readGatewayToken(link, EUID), /symlink/);
});

test("readGatewayToken refuses non-regular file", () => {
  const dir = path.join(DIR, "tokendir");
  fs.mkdirSync(dir, { recursive: true });
  assert.throws(() => readGatewayToken(dir, EUID), /not a regular file/);
});

test("readGatewayToken refuses group/world-readable modes", () => {
  const f = path.join(DIR, "groupread.env");
  fs.writeFileSync(f, `PIXEL_GATEWAY_TOKEN=${TOKEN}\n`, { mode: 0o640 });
  fs.chmodSync(f, 0o640);
  assert.throws(() => readGatewayToken(f, EUID), /group\/world readable/);
  const w = path.join(DIR, "worldread.env");
  fs.writeFileSync(w, `PIXEL_GATEWAY_TOKEN=${TOKEN}\n`, { mode: 0o604 });
  fs.chmodSync(w, 0o604);
  assert.throws(() => readGatewayToken(w, EUID), /group\/world readable/);
});

test("readGatewayToken refuses owner mismatch", () => {
  const f = path.join(DIR, "otherowner.env");
  fs.writeFileSync(f, `PIXEL_GATEWAY_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  const other = EUID === 0 ? 12345 : 0;
  assert.throws(() => readGatewayToken(f, other), /owner mismatch/);
});

test("readGatewayToken parses only PIXEL_GATEWAY_TOKEN, rejects empty", () => {
  const good = path.join(DIR, "good.env");
  fs.writeFileSync(
    good,
    `OTHER=ignored\nPIXEL_GATEWAY_TOKEN=${TOKEN}\nPIXEL_GATEWAY_TOKEN_SECOND=zz\n`,
    { mode: 0o600 }
  );
  assert.equal(readGatewayToken(good, EUID), TOKEN);
  const empty = path.join(DIR, "empty.env");
  fs.writeFileSync(empty, "PIXEL_GATEWAY_TOKEN=\n", { mode: 0o600 });
  assert.throws(() => readGatewayToken(empty, EUID), /missing or empty/);
});

test("readGatewayToken reads the owner-private OpenClaw gateway token", () => {
  const config = path.join(DIR, "openclaw.json");
  fs.writeFileSync(config, `${JSON.stringify({ gateway: { auth: { token: TOKEN } } })}\n`, { mode: 0o600 });
  assert.equal(readGatewayToken(config, EUID), TOKEN);
  fs.writeFileSync(config, `${JSON.stringify({ gateway: { auth: {} } })}\n`, { mode: 0o600 });
  assert.throws(() => readGatewayToken(config, EUID), /missing or empty/);
});

// ---------------------------------------------------------------------------
// Socket path refusal
// ---------------------------------------------------------------------------

test("prepareSocketPath refuses non-socket path", () => {
  const f = path.join(DIR, "notasocket");
  fs.writeFileSync(f, "x");
  assert.throws(() => prepareSocketPath(f), /non-socket path/);
});

test("prepareSocketPath removes only a socket at its own path", () => {
  const s = path.join(DIR, "existing.sock");
  const srv = net.createServer();
  return new Promise((resolve, reject) => {
    srv.listen(s, () => {
      try {
        prepareSocketPath(s);
        assert.equal(fs.existsSync(s), false);
        srv.close();
        resolve();
      } catch (e) {
        srv.close();
        reject(e);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Route/method behavior
// ---------------------------------------------------------------------------

test("exact routes and methods: health ok, chat ok, others 404/405", async () => {
  const gw = await fakeGateway();
  try {
    const srv = await startIngress({ gatewayPort: gw.port });
    try {
      const health = await request(srv, "GET", "/health");
      assert.equal(health.status, 200);
      assert.equal(JSON.parse(health.body).status, "ok");

      const chat = await request(srv, "POST", "/v1/chat/completions", {
        body: JSON.stringify({ model: "anything", messages: [{ role: "user", content: "hi" }] }),
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(chat.status, 200);

      const badMethod = await request(srv, "DELETE", "/health");
      assert.equal(badMethod.status, 405);

      const unknown = await request(srv, "GET", "/v1/models");
      assert.equal(unknown.status, 404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  } finally {
    await new Promise((r) => gw.server.close(r));
  }
});

test("health fails closed when the Pixel gateway is unreachable", async () => {
  const deps = {
    fetch: async () => { throw new Error("offline"); },
    setTimeout,
    clearTimeout,
  };
  const srv = await startIngress({ gatewayPort: 18789, deps });
  try {
    const health = await request(srv, "GET", "/health");
    assert.equal(health.status, 503);
    assert.deepEqual(JSON.parse(health.body), { status: "unavailable" });
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// Request limit
// ---------------------------------------------------------------------------

test("rejects oversized request body with 413", async () => {
  const gw = await fakeGateway();
  try {
    const srv = await startIngress({ gatewayPort: gw.port });
    try {
      const big = "x".repeat(2 * 1024 * 1024 + 10);
      const res = await request(srv, "POST", "/v1/chat/completions", {
        body: JSON.stringify({ messages: [{ content: big }] }),
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 413);
      // sanitized: does not echo body
      assert.ok(!res.body.includes("x".repeat(100)));
    } finally {
      await new Promise((r) => srv.close(r));
    }
  } finally {
    await new Promise((r) => gw.server.close(r));
  }
});

// ---------------------------------------------------------------------------
// Header stripping + forced model + hashed user + unknown field dropping
// ---------------------------------------------------------------------------

test("strips forbidden headers, forces model, hashes user, drops unknown fields", async () => {
  let captured = null;
  const gw = await fakeGateway({ onRequest: (c) => (captured = c) });
  try {
    const srv = await startIngress({ gatewayPort: gw.port });
    try {
      const chatId = "conversation-42";
      const res = await request(srv, "POST", "/v1/chat/completions", {
        body: JSON.stringify({
          model: "evil-model",
          messages: [{ role: "user", content: "hi" }],
          temperature: 0.7,
          top_p: 1,
          max_tokens: 100,
          stream: false,
          stop: ["\n"],
          tools: [{ type: "function", function: { name: "f" } }],
          tool_choice: "auto",
          response_format: { type: "json_object" },
          unknown_field: "SHOULD_NOT_APPEAR",
          metadata: { chat_id: chatId },
        }),
        headers: {
          Authorization: "Bearer inbound-token",
          Cookie: "session=secret",
          "X-Forwarded-For": "1.2.3.4",
          "x-openclaw-user": "evil",
          "Content-Type": "application/json",
        },
      });
      assert.equal(res.status, 200);
      assert.ok(captured, "gateway should have received a request");

      // Header stripping
      assert.equal(captured.headers.authorization, `Bearer ${TOKEN}`);
      assert.ok(!("cookie" in captured.headers), "cookie must be stripped");
      assert.ok(!("x-forwarded-for" in captured.headers), "x-forwarded-for stripped");
      assert.ok(!("x-openclaw-user" in captured.headers), "x-openclaw-user stripped");
      assert.ok(!("x-forwarded-proto" in captured.headers));

      // Forced model + dropped unknown field
      assert.equal(captured.body.model, "openclaw/default");
      assert.ok(!("unknown_field" in captured.body), "unknown field must be dropped");

      // Hashed user
      const digest = createHash("sha256").update(chatId).digest("hex");
      assert.equal(captured.body.user, `ods-${digest}`);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  } finally {
    await new Promise((r) => gw.server.close(r));
  }
});

test("omits user when no session identifier supplied", () => {
  const out = buildOutgoing(
    { messages: [{ role: "user", content: "x" }], metadata: { unrelated: 1 } },
    computeSessionUser({ messages: [{ role: "user", content: "x" }] })
  );
  assert.ok(!("user" in out), "no user field when no session identifier");
});

test("rejects invalid body (bad types)", () => {
  assert.throws(() => buildOutgoing({ messages: "nope" }, null), /invalid/);
  assert.throws(() => buildOutgoing({ max_tokens: -1 }, null), /invalid/);
  assert.throws(() => buildOutgoing({ stream: "yes" }, null), /invalid/);
});

// ---------------------------------------------------------------------------
// Sanitized errors
// ---------------------------------------------------------------------------

test("returns sanitized JSON error for invalid JSON, never reflects upstream body", async () => {
  const gw = await fakeGateway();
  try {
    const srv = await startIngress({ gatewayPort: gw.port });
    try {
      const res = await request(srv, "POST", "/v1/chat/completions", {
        body: "{not json",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 400);
      const parsed = JSON.parse(res.body);
      assert.ok(parsed.error && parsed.error.message);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  } finally {
    await new Promise((r) => gw.server.close(r));
  }
});

// ---------------------------------------------------------------------------
// Streaming bounds
// ---------------------------------------------------------------------------

test("streaming request forwards accept and returns SSE", async () => {
  let captured = null;
  const gw = await fakeGateway({ onRequest: (c) => (captured = c) });
  try {
    const srv = await startIngress({ gatewayPort: gw.port });
    try {
      const res = await request(srv, "POST", "/v1/chat/completions", {
        body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 200);
      assert.equal(captured.headers.accept, "text/event-stream");
      assert.ok(res.body.includes("[DONE]"), "should pass through SSE bytes");
    } finally {
      await new Promise((r) => srv.close(r));
    }
  } finally {
    await new Promise((r) => gw.server.close(r));
  }
});

test("non-stream response is bounded and sanitized on failure", async () => {
  // Gateway that returns a huge body => ingress caps at 2 MiB and returns
  // a generic 502 rather than reflecting it.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("x".repeat(3 * 1024 * 1024));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const gwPort = server.address().port;
  try {
    const srv = await startIngress({ gatewayPort: gwPort });
    try {
      const res = await request(srv, "POST", "/v1/chat/completions", {
        body: JSON.stringify({ stream: false, messages: [{ role: "user", content: "hi" }] }),
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 502);
      const parsed = JSON.parse(res.body);
      assert.ok(parsed.error && parsed.error.message, "sanitized generic error");
      assert.ok(!parsed.error.message.includes("xxxx"), "must not reflect upstream body");
    } finally {
      await new Promise((r) => srv.close(r));
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// UDS permissions
// ---------------------------------------------------------------------------

test("start creates a 0660 socket with the requested gid and closes without exiting", async () => {
  const gid = process.getgid();
  const tokenFile = path.join(DIR, "start-token.env");
  const socketPath = path.join(DIR, "permission.sock");
  const statusFile = path.join(DIR, "permission-status.json");
  fs.writeFileSync(tokenFile, `PIXEL_GATEWAY_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  const deps = {
    fetch: async () => ({ status: 503, body: { cancel: async () => {} } }),
    execFile: (_command, _args, _options, callback) => callback(new Error("unavailable")),
  };
  const handle = await start({
    socketPath,
    gatewayTokenFile: tokenFile,
    gatewayPort: 18999,
    statusFile,
    statusIntervalMs: 60000,
    ingressGid: gid,
  }, { deps, euid: EUID });
  const socketStat = fs.statSync(socketPath);
  assert.equal(socketStat.mode & 0o777, 0o660);
  assert.equal(socketStat.gid, gid);
  await handle.close();
  assert.equal(fs.existsSync(socketPath), false);
});

// ---------------------------------------------------------------------------
// Status projection: fixed docker execFile (mocked) + safe projection
// ---------------------------------------------------------------------------

test("status projection uses fixed docker execFile and allows only allowlisted names", async () => {
  const fakeDocker = (cmd, args, opts, callback) => {
    assert.equal(cmd, "docker");
    assert.deepEqual(args, ["ps", "--format", "{{json .}}"]);
    assert.ok(opts.timeout > 0, "must have explicit timeout");
    const lines = [
      { Names: "ods-pixel-edge", Status: "Up 5 minutes" },
      { Names: "/evil-container", Status: "Up 1 day (healthy)" },
      { Names: "ods-open-webui", Status: "Up (healthy)" },
      { Names: "ods-dashboard", Status: "Up (unhealthy)" },
      { Names: "ods-qdrant", Status: "Up (health: starting)" },
      { Names: "ods-n8n", Status: "Exited (0)" },
    ].map((x) => JSON.stringify(x));
    callback(null, lines.join("\n") + "\n", "");
  };
  const apps = await dockerApps({ execFile: fakeDocker });
  assert.deepEqual(apps, [
    { name: "ods-dashboard", status: "unhealthy" },
    { name: "ods-open-webui", status: "healthy" },
    { name: "ods-pixel-edge", status: "running" },
    { name: "ods-qdrant", status: "starting" },
  ]);
  assert.equal(JSON.stringify(apps).includes("evil"), false);
  assert.equal(JSON.stringify(apps).includes("5 minutes"), false);
});

test("start writes a safe status projection when docker is unavailable", async () => {
  const fakeEnvFile = path.join(DIR, "env.env");
  fs.writeFileSync(fakeEnvFile, `PIXEL_GATEWAY_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  const sock = path.join(DIR, "start.sock");
  const statusFile = path.join(DIR, "start-status.json");
  const deps = {
    fetch: async () => ({ status: 503, body: { cancel: async () => {} } }),
    execFile: (_command, _args, _options, callback) => callback(new Error("docker unavailable")),
  };
  const h = await start({
    socketPath: sock,
    gatewayTokenFile: fakeEnvFile,
    gatewayPort: 18999,
    statusFile,
    statusIntervalMs: 60000,
    ingressGid: null,
  }, { deps, euid: EUID });
  const proj = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.ok(proj.timestamp);
  assert.equal(proj.ingress_ready, true);
  assert.equal(proj.gateway_reachable, false);
  assert.equal(proj.docker, "unavailable");
  assert.deepEqual(proj.apps, []);
  assert.equal(fs.statSync(statusFile).mode & 0o777, 0o640);
  await h.close();
});

test("upstream error and wrong content type never reflect an upstream secret", async () => {
  for (const variant of ["error", "wrong-type"]) {
    const upstream = http.createServer((_req, res) => {
      if (variant === "error") res.writeHead(500, { "Content-Type": "application/json" });
      else res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("secret-upstream-body-/private/token");
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const ingress = await startIngress({ gatewayPort: upstream.address().port });
    try {
      const response = await request(ingress, "POST", "/v1/chat/completions", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(response.status, 502);
      assert.equal(response.body.includes("secret-upstream"), false);
      assert.equal(response.body.includes("private/token"), false);
    } finally {
      await new Promise((resolve) => ingress.close(resolve));
      await new Promise((resolve) => upstream.close(resolve));
    }
  }
});
