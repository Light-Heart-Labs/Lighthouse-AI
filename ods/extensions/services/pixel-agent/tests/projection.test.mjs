// Pixel ODS projection reader contract tests.
//
// Imports projection.mjs only. Covers good status/apps projections, symlink
// rejection, wrong-owner/writable file rejection (via injectable lstat/open),
// oversized files, extra keys, invalid names/status, duplicates, stale/future
// timestamps, replacement-race mismatch, and generic errors.

import test from "node:test";
import assert from "node:assert/strict";
import { readProjection, statusFileFromEnv } from "../plugin/projection.mjs";

const GOOD_TS = new Date(Date.now() - 1000).toISOString();

function goodProjection(overrides = {}) {
  return {
    schema_version: 1,
    timestamp: GOOD_TS,
    service: "pixel-agent",
    ingress_ready: true,
    gateway_reachable: true,
    docker: "ok",
    apps: [
      { name: "pixel-agent", status: "healthy" },
      { name: "openclaw", status: "running" },
    ],
    ...overrides,
  };
}

// Build a dependency set backed by in-memory files.
function memoryFs(files) {
  const store = new Map();
  for (const [path, entry] of Object.entries(files)) {
    store.set(path, entry);
  }
  const lstat = async (p) => {
    const entry = store.get(p);
    if (!entry) {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    }
    return entry.stat;
  };
  const open = async (p) => {
    const entry = store.get(p);
    if (!entry) {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    }
    if (entry.followTo) return { ...store.get(entry.followTo) };
    return entry;
  };
  return {
    lstat,
    open,
    readFile: async (fd) => fd.raw,
    stat: async (fd) => fd.stat,
    ownerUid: 0,
  };
}

function regularStat({ uid = 0, mode = 0o644, size = 100, mtimeMs = 1000 } = {}) {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    isSocket: () => false,
    isDirectory: () => false,
    dev: 1,
    ino: 1,
    uid,
    mode,
    size,
    mtimeMs,
  };
}

function makeEntry(raw, stat = regularStat({ size: Buffer.byteLength(raw) })) {
  return { raw, stat, followTo: null };
}

const FIXED = "/run/ods-pixel/ods-status.json";

function asRejected(promise) {
  return promise.then(
    () => null,
    (err) => err
  );
}

test("reads a good projection and returns a freshly constructed object", async () => {
  const raw = JSON.stringify(goodProjection());
  const fsImpl = memoryFs({ [FIXED]: makeEntry(raw) });
  const out = await readProjection(FIXED, fsImpl, Date.now());
  assert.equal(out.schema_version, 1);
  assert.equal(out.service, "pixel-agent");
  assert.equal(out.ingress_ready, true);
  assert.equal(out.gateway_reachable, true);
  assert.equal(out.docker, "ok");
  assert.equal(out.stale, false);
  assert.equal(out.boundary, "status-only");
  assert.equal(out.apps.length, 2);
  assert.deepEqual(out.apps, [
    { name: "pixel-agent", status: "healthy" },
    { name: "openclaw", status: "running" },
  ]);
  // Must be a new object, not the parsed raw value.
  assert.notEqual(out, JSON.parse(raw));
  assert.notEqual(out.apps, JSON.parse(raw).apps);
});

test("docker unavailable enum and starting status are accepted", async () => {
  const raw = JSON.stringify(
    goodProjection({
      docker: "unavailable",
      ingress_ready: false,
      apps: [{ name: "searxng", status: "starting" }],
    })
  );
  const fsImpl = memoryFs({ [FIXED]: makeEntry(raw) });
  const out = await readProjection(FIXED, fsImpl, Date.now());
  assert.equal(out.docker, "unavailable");
  assert.equal(out.ingress_ready, false);
  assert.deepEqual(out.apps, [{ name: "searxng", status: "starting" }]);
});

test("rejects a symlink at the fixed path", async () => {
  const stat = {
    isFile: () => false,
    isSymbolicLink: () => true,
    isSocket: () => false,
    isDirectory: () => false,
    dev: 1,
    ino: 9,
    mode: 0o777,
    size: 10,
    mtimeMs: 1,
  };
  const fsImpl = memoryFs({ [FIXED]: { raw: "", stat, followTo: null } });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects a non-regular path (directory)", async () => {
  const stat = {
    isFile: () => false,
    isSymbolicLink: () => false,
    isSocket: () => false,
    isDirectory: () => true,
    dev: 1,
    ino: 3,
    mode: 0o755,
    size: 0,
    mtimeMs: 1,
  };
  const fsImpl = memoryFs({ [FIXED]: { raw: "", stat, followTo: null } });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects a missing file", async () => {
  const fsImpl = memoryFs({});
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects a file not owned by the gateway service identity", async () => {
  const raw = JSON.stringify(goodProjection());
  const fsImpl = memoryFs({
    [FIXED]: makeEntry(raw, regularStat({ uid: 1000, size: Buffer.byteLength(raw) })),
  });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects a group/world-writable file", async () => {
  const raw = JSON.stringify(goodProjection());
  const fsImpl = memoryFs({
    [FIXED]: makeEntry(raw, regularStat({ mode: 0o666, size: Buffer.byteLength(raw) })),
  });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects an oversized file", async () => {
  const raw = JSON.stringify(goodProjection());
  const oversized = raw + " ".repeat(70 * 1024); // > 64 KiB
  const fsImpl = memoryFs({
    [FIXED]: makeEntry(oversized, regularStat({ size: Buffer.byteLength(oversized) })),
  });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects extra top-level keys", async () => {
  const raw = JSON.stringify(goodProjection({ extra: "nope" }));
  const fsImpl = memoryFs({ [FIXED]: makeEntry(raw) });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects extra app keys", async () => {
  const raw = JSON.stringify(
    goodProjection({ apps: [{ name: "openclaw", status: "running", note: "x" }] })
  );
  const fsImpl = memoryFs({ [FIXED]: makeEntry(raw) });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects an invalid app name (outside the ODS allowlist)", async () => {
  const raw = JSON.stringify(
    goodProjection({ apps: [{ name: "evil-container", status: "running" }] })
  );
  const fsImpl = memoryFs({ [FIXED]: makeEntry(raw) });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects an invalid app status", async () => {
  const raw = JSON.stringify(
    goodProjection({ apps: [{ name: "openclaw", status: "crashed" }] })
  );
  const fsImpl = memoryFs({ [FIXED]: makeEntry(raw) });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects duplicate app names", async () => {
  const raw = JSON.stringify(
    goodProjection({
      apps: [
        { name: "openclaw", status: "running" },
        { name: "openclaw", status: "healthy" },
      ],
    })
  );
  const fsImpl = memoryFs({ [FIXED]: makeEntry(raw) });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects an app count over the 64 maximum", async () => {
  const apps = [];
  let i = 0;
  while (i < 65) {
    apps.push({ name: "openclaw", status: "running" });
    i++;
  }
  const raw = JSON.stringify(goodProjection({ apps }));
  const fsImpl = memoryFs({ [FIXED]: makeEntry(raw) });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects a stale projection (older than 2 minutes)", async () => {
  const staleTs = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const raw = JSON.stringify(goodProjection({ timestamp: staleTs }));
  const fsImpl = memoryFs({ [FIXED]: makeEntry(raw) });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects a future timestamp", async () => {
  const futureTs = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const raw = JSON.stringify(goodProjection({ timestamp: futureTs }));
  const fsImpl = memoryFs({ [FIXED]: makeEntry(raw) });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects an unparseable timestamp", async () => {
  const raw = JSON.stringify(goodProjection({ timestamp: "not-a-date" }));
  const fsImpl = memoryFs({ [FIXED]: makeEntry(raw) });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects a replacement race (dev/ino mismatch between lstat and open)", async () => {
  const raw = JSON.stringify(goodProjection());
  const stat = regularStat({ size: Buffer.byteLength(raw) });
  // The path lstat returns a different inode than the handle that is opened.
  const lstatStat = { ...stat, ino: 99 };
  const fsImpl = {
    lstat: async () => lstatStat,
    open: async () => makeEntry(raw, stat),
    readFile: async (fd) => fd.raw,
    stat: async (fd) => fd.stat,
    ownerUid: 0,
  };
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects malformed JSON", async () => {
  const fsImpl = memoryFs({ [FIXED]: makeEntry("{not json") });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects invalid UTF-8 instead of accepting replacement characters", async () => {
  const fsImpl = memoryFs({ [FIXED]: makeEntry(Buffer.from([0xc3, 0x28])) });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects a non-object root (array)", async () => {
  const fsImpl = memoryFs({ [FIXED]: makeEntry("[]") });
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.match(err.message, /unavailable/);
});

test("rejects wrong schema_version and wrong service", async () => {
  for (const bad of [
    goodProjection({ schema_version: 2 }),
    goodProjection({ service: "other" }),
  ]) {
    const fsImpl = memoryFs({ [FIXED]: makeEntry(JSON.stringify(bad)) });
    const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
    assert.ok(err);
    assert.match(err.message, /unavailable/);
  }
});

test("generic errors contain no path or raw content", async () => {
  // Missing file => generic rejection, never the path or raw content.
  const fsImpl = memoryFs({});
  const err = await asRejected(readProjection(FIXED, fsImpl, Date.now()));
  assert.ok(err);
  assert.ok(!err.message.includes(FIXED));
  assert.ok(!err.message.includes("/run"));
  assert.ok(!err.message.includes("schema_version"));
});

test("statusFileFromEnv uses the env override or the fixed default", () => {
  assert.equal(statusFileFromEnv({}), "/run/ods-pixel/ods-status.json");
  assert.equal(
    statusFileFromEnv({ PIXEL_ODS_STATUS_FILE: "/tmp/x.json" }),
    "/tmp/x.json"
  );
  assert.throws(
    () => statusFileFromEnv({ PIXEL_ODS_STATUS_FILE: "relative.json" }),
    /unavailable/
  );
});
