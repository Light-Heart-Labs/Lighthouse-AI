import test from "node:test";
import assert from "node:assert/strict";
import {
  appsToolText,
  statusToolText,
  unavailableToolText,
} from "../plugin/tool-content.mjs";

const projection = {
  timestamp: "2026-08-28T10:00:00.000Z",
  stale: false,
  ingress_ready: true,
  gateway_reachable: true,
  docker: "ok",
  ods_version: "2.6.0",
  runtime: { model: "Qwen3.5-9B-Q4_K_M.gguf", context_length: 32768 },
  app_count: 2,
  online_app_count: 2,
  apps: [
    { name: "ods-dashboard", status: "healthy" },
    { name: "ods-searxng", status: "healthy" },
  ],
};

test("apps result states the count and first application without JSON parsing", () => {
  const text = appsToolText(projection);
  assert.match(text, /reports 2 of 2 applications online/);
  assert.match(text, /first is ods-dashboard \(healthy\)/);
  assert.match(text, /ods-dashboard \(healthy\), ods-searxng \(healthy\)/);
  assert.match(text, /status-only untrusted evidence/);
  assert.ok(!text.startsWith("{"));
});

test("status result states each bounded host fact in natural language", () => {
  const text = statusToolText(projection);
  assert.match(text, /Pixel availability: available/);
  assert.match(text, /ingress ready/);
  assert.match(text, /gateway reachable/);
  assert.match(text, /Docker: ok/);
  assert.match(text, /ODS version: 2\.6\.0/);
  assert.match(text, /Loaded model: Qwen3\.5-9B-Q4_K_M\.gguf/);
  assert.match(text, /context length: 32768 tokens/);
  assert.match(text, /Applications online: 2 of 2/);
});

test("unknown version and runtime stay explicit instead of being guessed", () => {
  const text = statusToolText({ ...projection, ods_version: "unknown", runtime: null });
  assert.match(text, /ODS version: unknown/);
  assert.match(text, /Loaded model: unavailable; context length: unavailable/);
});

test("empty and unavailable projections stay explicit and non-authoritative", () => {
  const empty = appsToolText({ ...projection, app_count: 0, online_app_count: 0, apps: [], stale: true });
  assert.match(empty, /reports 0 of 0 applications online/);
  assert.match(empty, /stale projection/);
  assert.match(unavailableToolText(), /projection is unavailable/);
  assert.match(unavailableToolText(), /not authority for an action/);
});
