import assert from "node:assert/strict";
import test from "node:test";

import {
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
