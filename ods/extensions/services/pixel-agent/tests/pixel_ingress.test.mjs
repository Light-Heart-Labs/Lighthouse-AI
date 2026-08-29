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
  dockerRuntime,
  writeStatus,
  start,
  gatewayFetch,
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
      const captured = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body ? JSON.parse(body) : null,
      };
      if (onRequest) onRequest(captured);
      if (req.url === "/pixel-ods/abort") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"aborted":true}');
        return;
      }
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
  assert.equal(d.odsVersion, "unknown");
  const o = configFromEnv({
    PIXEL_INGRESS_SOCKET: "/x.sock",
    PIXEL_GATEWAY_PORT: "19000",
    PIXEL_INGRESS_GID: "1234",
    PIXEL_STATUS_INTERVAL_MS: "5000",
    PIXEL_GATEWAY_TOKEN_FILE: "/custom.json",
    PIXEL_ODS_VERSION: "2.6.0-beta.1",
  });
  assert.equal(o.socketPath, "/x.sock");
  assert.equal(o.gatewayPort, 19000);
  assert.equal(o.ingressGid, 1234);
  assert.equal(o.statusIntervalMs, 5000);
  assert.equal(o.odsVersion, "2.6.0-beta.1");
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
  assert.throws(() => validateConfig({ ...base, odsVersion: "2.6.0\nSECRET=x" }), /ODS version/);
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

test("exact routes and methods: health, chat, and cancel work; others 404/405", async () => {
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

      const cancel = await request(srv, "POST", "/v1/chat/cancel", {
        body: JSON.stringify({ user: "conversation-42" }),
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(cancel.status, 200);
      assert.deepEqual(JSON.parse(cancel.body), { aborted: true });

      const badMethod = await request(srv, "DELETE", "/health");
      assert.equal(badMethod.status, 405);

      const badCancelMethod = await request(srv, "GET", "/v1/chat/cancel");
      assert.equal(badCancelMethod.status, 405);

      const unknown = await request(srv, "GET", "/v1/models");
      assert.equal(unknown.status, 404);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  } finally {
    await new Promise((r) => gw.server.close(r));
  }
});

test("cancel validates the raw chat id and forwards only its opaque digest", async () => {
  const captured = [];
  const gw = await fakeGateway({ onRequest: (value) => captured.push(value) });
  try {
    const srv = await startIngress({ gatewayPort: gw.port });
    try {
      const chatId = "conversation-99";
      const response = await request(srv, "POST", "/v1/chat/cancel", {
        body: JSON.stringify({ user: chatId }),
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.body), { aborted: true });
      const digest = createHash("sha256").update(chatId).digest("hex");
      assert.equal(captured.length, 1);
      assert.equal(captured[0].url, "/pixel-ods/abort");
      assert.equal(captured[0].headers.authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(captured[0].body, { user: `ods-${digest}` });

      for (const body of [
        {},
        { user: "../../escape" },
        { user: "safe", extra: true },
        { user: 7 },
      ]) {
        const invalid = await request(srv, "POST", "/v1/chat/cancel", {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        });
        assert.equal(invalid.status, 400);
      }
      assert.equal(captured.length, 1);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  } finally {
    await new Promise((resolve) => gw.server.close(resolve));
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

test("closing a silent downstream stream closes the active gateway transport", async () => {
  let markUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => {
    markUpstreamClosed = resolve;
  });
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      res.on("close", () => markUpstreamClosed(!res.writableEnded));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const ingress = await startIngress({ gatewayPort: upstream.address().port });
  try {
    await new Promise((resolve, reject) => {
      const client = http.request(
        {
          socketPath: ingress.address(),
          method: "POST",
          path: "/v1/chat/completions",
          headers: { "Content-Type": "application/json" },
        },
        (response) => {
          response.once("error", () => {});
          response.destroy();
          resolve();
        }
      );
      client.once("error", (error) => {
        if (error.code === "ECONNRESET") resolve();
        else reject(error);
      });
      client.end(JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "cancel me" }],
      }));
    });
    assert.equal(
      await Promise.race([
        upstreamClosed,
        new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
      ]),
      true
    );
  } finally {
    await new Promise((resolve) => ingress.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("core gateway transport preserves a delayed response body", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    setTimeout(() => res.end("data: [DONE]\n\n"), 250);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await gatewayFetch(
        `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: controller.signal,
        }
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      const body = await new Response(response.body).text();
      assert.ok(body.includes("[DONE]"));
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("chat waits for delayed gateway headers after the loopback connection succeeds", async () => {
  const armedTimeouts = [];
  const deps = {
    fetch: (_url, options) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(
            new Response(
              JSON.stringify({ id: "slow", choices: [{ message: { content: "ok" } }] }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        }, 40);
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted before delayed headers"));
        }, { once: true });
      }),
    setTimeout: (callback, milliseconds) => {
      armedTimeouts.push(milliseconds);
      if (milliseconds < 100000) return setTimeout(callback, 5);
      return { longBudget: true };
    },
    clearTimeout: (timer) => {
      if (timer && !timer.longBudget) clearTimeout(timer);
    },
  };
  const srv = await startIngress({ gatewayPort: 18789, deps });
  try {
    const response = await request(srv, "POST", "/v1/chat/completions", {
      body: JSON.stringify({ messages: [{ role: "user", content: "slow reply" }] }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(armedTimeouts, [1920000]);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
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
    odsVersion: "2.6.0",
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
    assert.deepEqual(args, ["ps", "--all", "--format", "{{json .}}"]);
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
    { name: "ods-n8n", status: "stopped" },
    { name: "ods-open-webui", status: "healthy" },
    { name: "ods-pixel-edge", status: "running" },
    { name: "ods-qdrant", status: "starting" },
  ]);
  assert.equal(JSON.stringify(apps).includes("evil"), false);
  assert.equal(JSON.stringify(apps).includes("5 minutes"), false);
});

test("runtime projection uses a fixed inspect command and returns only model basename and context", async () => {
  const fakeDocker = (cmd, args, opts, callback) => {
    assert.equal(cmd, "docker");
    assert.deepEqual(args, [
      "inspect", "ods-llama-server", "--format", "{{json .Config.Cmd}}",
    ]);
    assert.ok(opts.timeout > 0, "must have explicit timeout");
    callback(
      null,
      JSON.stringify(["--model", "/models/Qwen3.5-9B-Q4_K_M.gguf", "--ctx-size", "32768"]),
      ""
    );
  };
  assert.deepEqual(await dockerRuntime({ execFile: fakeDocker }), {
    model: "Qwen3.5-9B-Q4_K_M.gguf",
    context_length: 32768,
  });
});

test("runtime projection rejects paths, malformed contexts, and non-JSON output", async () => {
  for (const command of [
    ["--model", "/private/model.gguf", "--ctx-size", "32768"],
    ["--model", "/models/../secret", "--ctx-size", "32768"],
    ["--model", "/models/model.gguf", "--ctx-size", "0"],
    "not-json",
  ]) {
    const fakeDocker = (_cmd, _args, _opts, callback) => {
      const output = command === "not-json" ? command : JSON.stringify(command);
      callback(null, output, "");
    };
    assert.equal(await dockerRuntime({ execFile: fakeDocker }), null);
  }
});

test("status keeps app health when optional runtime inspection is unavailable", async () => {
  const statusFile = path.join(DIR, "runtime-unavailable-status.json");
  const fakeDocker = (_cmd, args, _opts, callback) => {
    if (args[0] === "ps") {
      callback(null, `${JSON.stringify({ Names: "ods-dashboard", Status: "Up (healthy)" })}\n`, "");
      return;
    }
    callback(new Error("runtime unavailable"));
  };
  const projection = await writeStatus(
    true,
    18999,
    statusFile,
    "2.6.0",
    {
      fetch: async () => ({ status: 503, body: { cancel: async () => {} } }),
      execFile: fakeDocker,
      setTimeout,
      clearTimeout,
    }
  );
  assert.equal(projection.schema_version, 2);
  assert.equal(projection.ods_version, "2.6.0");
  assert.equal(projection.docker, "ok");
  assert.equal(projection.online_apps, 1);
  assert.equal(projection.runtime, null);
  assert.deepEqual(projection.apps, [{ name: "ods-dashboard", status: "healthy" }]);
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
    odsVersion: "2.6.0",
  }, { deps, euid: EUID });
  const proj = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.ok(proj.timestamp);
  assert.equal(proj.ingress_ready, true);
  assert.equal(proj.gateway_reachable, false);
  assert.equal(proj.docker, "unavailable");
  assert.equal(proj.schema_version, 2);
  assert.equal(proj.ods_version, "2.6.0");
  assert.equal(proj.online_apps, 0);
  assert.equal(proj.runtime, null);
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
