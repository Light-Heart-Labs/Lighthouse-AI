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
  app_count: 2,
  apps: [
    { name: "ods-dashboard", status: "healthy" },
    { name: "ods-searxng", status: "healthy" },
  ],
};

test("apps result states the count and first application without JSON parsing", () => {
  const text = appsToolText(projection);
  assert.match(text, /reports 2 applications/);
  assert.match(text, /first is ods-dashboard \(healthy\)/);
  assert.match(text, /ods-dashboard \(healthy\), ods-searxng \(healthy\)/);
  assert.match(text, /status-only untrusted evidence/);
  assert.ok(!text.startsWith("{"));
});

test("status result states each bounded host fact in natural language", () => {
  const text = statusToolText(projection);
  assert.match(text, /ingress is ready/);
  assert.match(text, /gateway is reachable/);
  assert.match(text, /Docker is ok/);
  assert.match(text, /current projection reports 2 applications/);
});

test("empty and unavailable projections stay explicit and non-authoritative", () => {
  const empty = appsToolText({ ...projection, app_count: 0, apps: [], stale: true });
  assert.match(empty, /reports 0 applications/);
  assert.match(empty, /stale projection/);
  assert.match(unavailableToolText(), /projection is unavailable/);
  assert.match(unavailableToolText(), /not authority for an action/);
});
