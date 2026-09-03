import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createWorkspaceScaffold,
  createWorkspacePreviewTool,
  normalizeWorkspacePreviewParams,
  testing,
} from "../plugin/workspace-preview.mjs";


test("normalizes one bounded workspace-relative directory", () => {
  assert.deepEqual(normalizeWorkspacePreviewParams({ relativeDirectory: "demo-site" }), {
    schemaVersion: 1,
    action: "publish",
    relativeDirectory: "demo-site",
  });
  for (const value of ["", "/tmp/site", "../site", "a\\b", "a//b", "a/./b"]) {
    assert.throws(
      () => normalizeWorkspacePreviewParams({ relativeDirectory: value }),
      /invalid Pixel workspace preview request/
    );
  }
});

test("creates one owner-private self-contained interactive scaffold without overwrite", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "pixel-preview-scaffold-"));
  try {
    const request = {
      workspaceRoot,
      relativeDirectory: "signal-garden",
      scaffold: {
        title: "Signal <Garden>",
        tagline: "A local & interactive field.",
        theme: "ocean",
      },
    };
    const firstDirectory = await createWorkspaceScaffold(request, {
      uniqueSuffix: () => "12345678",
    });
    const entry = path.join(workspaceRoot, firstDirectory, "index.html");
    const html = await readFile(entry, "utf8");
    assert.match(html, /Signal &lt;Garden&gt;/);
    assert.match(html, /A local &amp; interactive field/);
    assert.match(html, /data-theme="ocean"/);
    assert.match(html, /Launch sequence/);
    assert.match(html, /requestAnimationFrame/);
    assert.equal((await stat(entry)).mode & 0o777, 0o600);
    const secondDirectory = await createWorkspaceScaffold(request, {
      uniqueSuffix: () => "90abcdef",
    });
    assert.equal(firstDirectory, "signal-garden-12345678");
    assert.equal(secondDirectory, "signal-garden-90abcdef");
    assert.notEqual(firstDirectory, secondDirectory);
    assert.equal((await stat(entry)).size > 0, true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("normalizes only exact bounded demo scaffold fields", () => {
  assert.deepEqual(
    normalizeWorkspacePreviewParams({
      relativeDirectory: "signal-garden",
      scaffold: {
        title: "Signal Garden",
        tagline: "A local interactive field.",
        theme: "aurora",
      },
    }),
    {
      schemaVersion: 1,
      action: "publish",
      relativeDirectory: "signal-garden",
      scaffold: {
        title: "Signal Garden",
        tagline: "A local interactive field.",
        theme: "aurora",
      },
    }
  );
  for (const scaffold of [
    { title: "Demo", tagline: "Tagline", theme: "unknown" },
    { title: "Demo", tagline: "Tagline", theme: "aurora", extra: true },
    { title: "", tagline: "Tagline", theme: "aurora" },
  ]) {
    assert.throws(
      () => normalizeWorkspacePreviewParams({ relativeDirectory: "demo", scaffold }),
      /invalid Pixel workspace preview request/
    );
  }
  assert.throws(
    () =>
      normalizeWorkspacePreviewParams({
        relativeDirectory: "nested/demo",
        scaffold: { title: "Demo", tagline: "Tagline", theme: "aurora" },
      }),
    /invalid Pixel workspace preview request/
  );
  assert.deepEqual(
    normalizeWorkspacePreviewParams({
      relativeDirectory: "neon-breakout",
      scaffold: {
        title: "Neon Breakout",
        tagline: "A local arcade.",
        theme: "orchid",
        template: "breakout",
      },
    }).scaffold,
    {
      title: "Neon Breakout",
      tagline: "A local arcade.",
      theme: "orchid",
      template: "breakout",
    }
  );
  assert.throws(
    () => normalizeWorkspacePreviewParams({
      relativeDirectory: "demo",
      scaffold: {
        title: "Demo",
        tagline: "Tagline",
        theme: "aurora",
        template: "untrusted",
      },
    }),
    /invalid Pixel workspace preview request/
  );
});

test("creates a responsive self-contained Breakout game scaffold", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "pixel-preview-breakout-"));
  try {
    const relativeDirectory = await createWorkspaceScaffold({
      workspaceRoot,
      relativeDirectory: "neon-breakout",
      scaffold: {
        title: "Neon <Breakout>",
        tagline: "A safe & local arcade.",
        theme: "orchid",
        template: "breakout",
      },
    }, {
      uniqueSuffix: () => "12345678",
    });
    const entry = path.join(workspaceRoot, relativeDirectory, "index.html");
    const html = await readFile(entry, "utf8");
    assert.equal(relativeDirectory, "neon-breakout-12345678");
    assert.match(html, /Neon &lt;Breakout&gt;/);
    assert.match(html, /A safe &amp; local arcade/);
    assert.match(html, /<canvas id="game"/);
    assert.match(html, /requestAnimationFrame/);
    assert.match(html, /pointermove/);
    assert.match(html, /addEventListener\('keydown'/);
    assert.match(html, /Touch controls/);
    assert.match(html, /Content-Security-Policy/);
    assert.doesNotMatch(html, /https?:\/\//);
    assert.equal((await stat(entry)).mode & 0o777, 0o600);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});


test("returns only a structurally verified localhost preview", async () => {
  const response = {
    schemaVersion: 1,
    kind: "ods-pixel-workspace-preview",
    status: "succeeded",
    relativeDirectory: "demo-site",
    siteId: "site-0123456789abcdef01234567",
    port: 9437,
    url: "http://localhost:9437/site-0123456789abcdef01234567/",
    files: 3,
    bytes: 9000,
    sha256: "a".repeat(64),
    entryFile: "index.html",
    entrySha256: "b".repeat(64),
    httpStatus: 200,
    readbackVerified: true,
    executable: false,
    overwritten: false,
    boundary: testing.BOUNDARY,
  };
  const calls = [];
  const tool = createWorkspacePreviewTool({
    request: async (request) => {
      calls.push(request);
      return response;
    },
  });
  const result = await tool.execute("call-1", { relativeDirectory: "demo-site" });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.readbackVerified, true);
  assert.match(result.content[0].text, /Verified browser URL/);
  assert.deepEqual(calls, [{
    schemaVersion: 1,
    action: "publish",
    relativeDirectory: "demo-site",
  }]);
});

test("creates a requested scaffold before sending the narrow publish request", async () => {
  const calls = [];
  const scaffolds = [];
  const response = {
    schemaVersion: 1,
    kind: "ods-pixel-workspace-preview",
    status: "succeeded",
    relativeDirectory: "signal-garden-12345678",
    siteId: "site-0123456789abcdef01234567",
    port: 9437,
    url: "http://localhost:9437/site-0123456789abcdef01234567/",
    files: 1,
    bytes: 7000,
    sha256: "a".repeat(64),
    entryFile: "index.html",
    entrySha256: "b".repeat(64),
    httpStatus: 200,
    readbackVerified: true,
    executable: false,
    overwritten: false,
    boundary: testing.BOUNDARY,
  };
  const tool = createWorkspacePreviewTool({
    workspaceRoot: "/workspace",
    scaffold: async (request) => {
      scaffolds.push(request);
      return "signal-garden-12345678";
    },
    request: async (request) => {
      calls.push(request);
      return response;
    },
  });
  const scaffold = {
    title: "Signal Garden",
    tagline: "A local interactive field.",
    theme: "aurora",
  };
  const result = await tool.execute("call-scaffold", {
    relativeDirectory: "signal-garden",
    scaffold,
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /created, published/);
  assert.deepEqual(scaffolds, [{
    workspaceRoot: "/workspace",
    relativeDirectory: "signal-garden",
    scaffold,
  }]);
  assert.deepEqual(calls, [{
    schemaVersion: 1,
    action: "publish",
    relativeDirectory: "signal-garden-12345678",
  }]);
});


test("fails closed on a mismatched or unverified service response", async () => {
  const tool = createWorkspacePreviewTool({
    request: async () => ({
      schemaVersion: 1,
      kind: "ods-pixel-workspace-preview",
      status: "succeeded",
      relativeDirectory: "demo-site",
      siteId: "site-0123456789abcdef01234567",
      port: 3000,
      url: "http://localhost:3000/demo-site/",
      files: 1,
      bytes: 1,
      sha256: "a".repeat(64),
      entryFile: "index.html",
      entrySha256: "b".repeat(64),
      httpStatus: 200,
      readbackVerified: false,
      executable: false,
      overwritten: false,
      boundary: testing.BOUNDARY,
    }),
  });
  const result = await tool.execute("call-2", { relativeDirectory: "demo-site" });
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "failed");
  assert.match(result.content[0].text, /do not claim a localhost URL is live/);
});

test("fails closed when the host response contains an uncontracted field", async () => {
  const tool = createWorkspacePreviewTool({
    request: async () => ({
      schemaVersion: 1,
      kind: "ods-pixel-workspace-preview",
      status: "succeeded",
      relativeDirectory: "demo-site",
      siteId: "site-0123456789abcdef01234567",
      port: 9437,
      url: "http://localhost:9437/site-0123456789abcdef01234567/",
      files: 1,
      bytes: 1,
      sha256: "a".repeat(64),
      entryFile: "index.html",
      entrySha256: "b".repeat(64),
      httpStatus: 200,
      readbackVerified: true,
      executable: false,
      overwritten: false,
      boundary: testing.BOUNDARY,
      redirect: "https://attacker.example/",
    }),
  });
  const result = await tool.execute("call-3", { relativeDirectory: "demo-site" });
  assert.equal(result.isError, true);
});
