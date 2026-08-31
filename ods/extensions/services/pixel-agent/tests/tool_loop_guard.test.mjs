import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CODING_LOOP_ABORT_REASON,
  CODING_RETRY_EXHAUSTED_REASON,
  CANCELLABLE_EXEC_UNAVAILABLE_REASON,
  CLIENT_CANCELLED_REASON,
  DEFAULT_WEB_TOOL_LIMITS,
  EXEC_PRIVATE_NETWORK_REASON,
  EXACT_DOWNLOAD_LOOP_ABORT_REASON,
  EXACT_DOWNLOAD_REQUIRES_BROKER_REASON,
  EXACT_DOWNLOAD_REQUEST_UNBOUND_REASON,
  EXACT_DOWNLOAD_APPROVAL_DELIVERY_PREFIX,
  EXACT_DOWNLOAD_FAILED_DELIVERY_PREFIX,
  EXACT_DOWNLOAD_PUBLISHED_DELIVERY_PREFIX,
  EXACT_DOWNLOAD_REQUIRES_PROMOTION_REASON,
  EXACT_DOWNLOAD_UNPUBLISHED_DELIVERY_PREFIX,
  EXACT_DOWNLOAD_UNAVAILABLE_DELIVERY_PREFIX,
  EXACT_DOWNLOAD_UNVERIFIED_DELIVERY_PREFIX,
  GITHUB_CANONICAL_FETCH_FAILED_REASON,
  GITHUB_CANONICAL_SOURCE_PREFIX,
  GITHUB_SOURCE_UNVERIFIED_DELIVERY_PREFIX,
  ODS_TOOL_ROUTING_ABORT_REASON,
  ODS_TOOL_ROUTING_LOOP_ABORT_REASON,
  OPERATIONS_HOST_EVIDENCE_PREFIX,
  OPERATIONS_EXTENSION_CATALOG_EVIDENCE_PREFIX,
  OPERATIONS_EXTENSION_LIFECYCLE_EVIDENCE_PREFIX,
  OPERATIONS_EXTENSION_LIFECYCLE_SEQUENCE_REASON,
  OPERATIONS_CONTINUATION_REQUIRES_STATUS_REASON,
  OPERATIONS_CONTINUATION_UNVERIFIED_DELIVERY_PREFIX,
  OPERATIONS_LOOP_ABORT_REASON,
  OPERATIONS_REQUIRES_BROKER_REASON,
  OPERATIONS_UNAVAILABLE_DELIVERY_PREFIX,
  OPERATIONS_UNAVAILABLE_ZERO_SUBMISSIONS_CODE,
  OPERATIONS_UNVERIFIED_DELIVERY_PREFIX,
  OPERATIONS_WRONG_ACTION_REASON,
  PRIVATE_URL_REQUEST_REASON,
  PRIVATE_NETWORK_LOOP_ABORT_REASON,
  RECURSIVE_DELETE_REQUIRES_OWNER_REASON,
  VERIFICATION_FAILED_DELIVERY_PREFIX,
  VERIFICATION_COMMAND_NOT_AUDITABLE_REASON,
  VERIFICATION_PENDING_DELIVERY_PREFIX,
  WEB_BUDGET_EXHAUSTED_REASON,
  WEB_FETCH_REPEAT_PIVOT_REASON,
  WEB_FETCH_TRUNCATED_PIVOT_REASON,
  WEB_FETCH_PUBLIC_ONLY_REASON,
  WEB_LOOP_ABORT_REASON,
  createExecCancellationControl,
  createToolLoopGuard,
  createToolLoopGuardRegistry,
  githubReadmeUrl,
  textRequestsPrivateUrlAccess,
  userMessageAuthorizesRecursiveDelete,
  userMessageGitHubFileUrl,
  userMessageGitHubRepositoryUrl,
  userMessageOdsToolRequirements,
  userMessageOperationsRequirements,
  userMessageExtensionCatalogExactQuery,
  userMessageExtensionLifecycleIntent,
  userMessageOperationsContinuation,
  userMessageRequiresOperations,
  userMessageRequestsExtensionCatalog,
  userMessageRequestsPrivateUrl,
  userMessageRequestsExactByteDownload,
  userMessageExactDownloadRequest,
} from "../plugin/tool-loop-guard.mjs";

test("exec cancellation control creates exact owner-private markers and fails closed", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "pixel-exec-control-"));
  const root = path.join(temporary, "control");
  try {
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(path.join(root, "cancellable-exec.sh"), "#!/bin/sh\n", { mode: 0o500 });
    const control = createExecCancellationControl({ root });
    const runId = "run-exact";
    const marker = path.join(
      root,
      `${createHash("sha256").update(runId, "utf8").digest("hex")}.cancel`
    );
    assert.match(control.prepare(runId, "printf 'hello world'"), /^\/run\/pixel-ods-control\/cancellable-exec\.sh [0-9a-f]{64} /);
    assert.equal(control.signal(runId), true);
    assert.equal(statSync(marker).mode & 0o777, 0o600);
    assert.equal(control.clear(runId), true);
    assert.equal(control.clear(runId), false);
    control.signal(runId);
    control.prepare(runId, "true");
    assert.throws(() => statSync(marker), /ENOENT/);
    chmodSync(root, 0o755);
    assert.throws(() => control.prepare(runId, "true"), /unsafe Pixel execution control root/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

function call(guard, toolName, overrides = {}) {
  const event = { toolName, runId: "run-1", ...(overrides.event ?? {}) };
  const context = {
    agentId: "pixel",
    toolName,
    runId: "run-1",
    sessionId: "session-1",
    ...(overrides.context ?? {}),
  };
  return guard.beforeToolCall(event, context, "pixel");
}

function afterCall(guard, toolName, overrides = {}) {
  const event = {
    toolName,
    runId: "run-1",
    params: {},
    ...(overrides.event ?? {}),
  };
  const context = {
    agentId: "pixel",
    toolName,
    runId: "run-1",
    sessionId: "session-1",
    ...(overrides.context ?? {}),
  };
  guard.afterToolCall(event, context, "pixel");
}

function reply(guard, overrides = {}) {
  const event = {
    runId: "run-1",
    kind: "final",
    payload: { text: "Model claimed success.", metadata: { preserved: true } },
    ...(overrides.event ?? {}),
  };
  return guard.replyPayloadSending(event);
}

function lifecycleResult(action, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "ods-pixel-extension-lifecycle",
    action,
    extensionId: "crewai",
    outcome: action === "inspect" ? "ready" : "succeeded",
    previousStatus: "not_installed",
    currentStatus: action === "inspect" ? "not_installed" : "enabled",
    changed: action !== "inspect",
    externalEffectOccurred: action !== "inspect",
    requiredConfiguration: [],
    optionalConfiguration: [],
    missingConfiguration: [],
    rollback: { attempted: false, succeeded: null },
    boundary:
      "Scoped ODS extension lifecycle proxy; it grants no Docker, shell, credential, arbitrary HTTP, or data-purge authority.",
    ...overrides,
  };
}

function lifecycleStep(action, result = lifecycleResult(action)) {
  return {
    stepId: `step-${action}`,
    target: "ods-host",
    action: `ods.extensions.${action}`,
    exitCode: 0,
    stdout: `${JSON.stringify(result)}\n`,
    stderr: "",
    outputTruncated: { stdout: false, stderr: false },
    riskSignals: [],
  };
}

test("allows bounded web research then returns a terminal final-answer instruction", () => {
  const aborts = [];
  const guard = createToolLoopGuard({
    abortRun: (sessionId) => aborts.push(sessionId),
    limits: { search: 2, fetch: 2, total: 3 },
  });

  assert.equal(call(guard, "web_search"), undefined);
  assert.equal(call(guard, "web_fetch"), undefined);
  assert.equal(call(guard, "web_search"), undefined);
  assert.deepEqual(call(guard, "web_fetch"), {
    block: true,
    blockReason: WEB_BUDGET_EXHAUSTED_REASON,
  });
  assert.deepEqual(aborts, []);
});

test("classifies exact-byte downloads without capturing ordinary page research", () => {
  assert.equal(
    userMessageRequestsExactByteDownload(
      [],
      "Download https://example.com into a file and report the SHA-256 of the exact bytes saved."
    ),
    true
  );
  assert.equal(
    userMessageRequestsExactByteDownload([], "Fetch https://example.com and summarize it."),
    false
  );
  assert.equal(
    userMessageRequestsExactByteDownload([], "Save this exact sentence to notes.txt."),
    false
  );
  assert.deepEqual(
    userMessageExactDownloadRequest(
      [],
      `Download https://example.com/file.bin into a workspace file named web/file.bin, preserve the exact bytes, and verify SHA-256 ${"c".repeat(64)}.`
    ),
    {
      exact: true,
      url: "https://example.com/file.bin",
      relativePath: "web/file.bin",
      filename: "file.bin",
      expectedSha256: "c".repeat(64),
    }
  );
  assert.deepEqual(
    userMessageExactDownloadRequest(
      [],
      "Download https://example.com/file.bin byte-for-byte as exact.bin."
    ),
    {
      exact: true,
      url: "https://example.com/file.bin",
      relativePath: "exact.bin",
      filename: "exact.bin",
      expectedSha256: undefined,
    }
  );
  assert.deepEqual(
    userMessageExactDownloadRequest(
      [],
      "Download https://example.com/file.bin into web/from-origin.bin and preserve its exact bytes."
    ),
    {
      exact: true,
      url: "https://example.com/file.bin",
      relativePath: "web/from-origin.bin",
      filename: "from-origin.bin",
      expectedSha256: undefined,
    }
  );
  assert.deepEqual(
    userMessageExactDownloadRequest(
      [],
      "Download https://example.com/a and https://example.com/b as exact bytes."
    ),
    { exact: true }
  );
  assert.deepEqual(
    userMessageExactDownloadRequest(
      [],
      "Download https://example.com/file.bin byte-for-byte to ../escape.bin."
    ),
    { exact: true, url: "https://example.com/file.bin" }
  );
});

test("blocks exact-download tools when source or destination is ambiguous", () => {
  const guard = createToolLoopGuard();
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    {
      prompt:
        "Download https://example.com/a and https://example.com/b as exact bytes.",
    }
  );
  assert.deepEqual(call(guard, "pixel_ops_download_stage"), {
    block: true,
    blockReason: EXACT_DOWNLOAD_REQUEST_UNBOUND_REASON,
  });
});

test("fails closed when transformed web evidence is requested as an exact download", () => {
  const aborts = [];
  const guard = createToolLoopGuard({
    abortRun: (sessionId) => {
      aborts.push(sessionId);
      return true;
    },
  });
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    {
      prompt:
        "Download https://example.com into exact.html and report the exact bytes and digest.",
    }
  );

  assert.deepEqual(
    call(guard, "web_fetch", {
      event: { params: { url: "https://example.com/" } },
    }),
    { block: true, blockReason: EXACT_DOWNLOAD_REQUIRES_BROKER_REASON }
  );
  assert.deepEqual(call(guard, "write", { event: { params: { path: "exact.html" } } }), {
    block: true,
    blockReason: EXACT_DOWNLOAD_LOOP_ABORT_REASON,
  });
  assert.deepEqual(aborts, ["session-1"]);
  assert.deepEqual(reply(guard), {
    payload: {
      text: EXACT_DOWNLOAD_UNAVAILABLE_DELIVERY_PREFIX,
      metadata: { preserved: true },
    },
    reason:
      "Pixel replaced an unverified terminal reply with host-authoritative evidence truth.",
  });
});

test("allows one exact correction from transformed web fetch to the staged-download broker", () => {
  const guard = createToolLoopGuard();
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Download https://example.com byte-for-byte as exact.html." }
  );
  assert.deepEqual(
    call(guard, "web_fetch", {
      event: { params: { url: "https://example.com/" } },
    }),
    { block: true, blockReason: EXACT_DOWNLOAD_REQUIRES_BROKER_REASON }
  );
  assert.deepEqual(call(guard, "pixel_ops_download_stage"), {
    params: { url: "https://example.com/", filename: "exact.html" },
  });
});

test("requires terminal artifact evidence after a staged-download submission", () => {
  const guard = createToolLoopGuard();
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Fetch https://example.com/ byte-for-byte and save the exact file as exact.html." }
  );
  assert.deepEqual(call(guard, "pixel_ops_download_stage"), {
    params: { url: "https://example.com/", filename: "exact.html" },
  });
  afterCall(guard, "pixel_ops_download_stage", {
    event: {
      params: { url: "https://example.com/", filename: "exact.html" },
      result: {
        details: {
          jobId: "ops-1234567890123-abcdef123456",
          status: "submitted",
          kind: "download",
        },
      },
    },
  });
  assert.deepEqual(call(guard, "pixel_ops_job_wait"), {
    params: { jobId: "ops-1234567890123-abcdef123456" },
  });
  assert.deepEqual(reply(guard), {
    payload: {
      text: EXACT_DOWNLOAD_UNVERIFIED_DELIVERY_PREFIX,
      metadata: { preserved: true },
    },
    reason:
      "Pixel replaced an unverified terminal reply with host-authoritative evidence truth.",
  });
});

test("accepts a matching terminal staged-download artifact receipt", () => {
  const guard = createToolLoopGuard();
  const jobId = "ops-1234567890123-abcdef123456";
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Download https://example.com/ byte-for-byte as web/example.html and report the exact digest." }
  );
  afterCall(guard, "pixel_ops_download_stage", {
    event: {
      params: { url: "https://example.com/", filename: "example.html" },
      result: { details: { jobId, status: "submitted", kind: "download" } },
    },
  });
  afterCall(guard, "pixel_ops_job_wait", {
    event: {
      params: { jobId, timeoutSeconds: 20 },
      result: {
        details: {
          jobId,
          status: "succeeded",
          waitTimedOut: false,
          steps: [{
            action: "download.stage",
            target: "broker",
            exitCode: 0,
            artifact: {
              path: `/var/lib/pixel-ops-broker/artifacts/${jobId}/example.html`,
              filename: "example.html",
              bytes: 559,
              sha256: "a".repeat(64),
              source: "https://example.com/",
              redirects: [],
              executable: false,
            },
          }],
        },
      },
    },
  });
  assert.equal(reply(guard)?.payload?.text, EXACT_DOWNLOAD_UNPUBLISHED_DELIVERY_PREFIX);
  assert.deepEqual(call(guard, "read", { event: { params: { path: "/var/lib/pixel-ops-broker/artifacts" } } }), {
    block: true,
    blockReason: EXACT_DOWNLOAD_REQUIRES_PROMOTION_REASON,
  });
  assert.deepEqual(call(guard, "pixel_ods_download_promote"), {
    params: {
      jobId,
      filename: "example.html",
      relativePath: "web/example.html",
      sha256: "a".repeat(64),
      sourceUrl: "https://example.com/",
    },
  });
  afterCall(guard, "pixel_ods_download_promote", {
    event: {
      params: {
        jobId,
        filename: "example.html",
        relativePath: "web/example.html",
        sha256: "a".repeat(64),
        sourceUrl: "https://example.com/",
      },
      result: {
        details: {
          schemaVersion: 1,
          kind: "ods-pixel-download-promotion",
          status: "succeeded",
          jobId,
          filename: "example.html",
          relativePath: "web/example.html",
          bytes: 559,
          sha256: "a".repeat(64),
          source: "https://example.com/",
          requestedSource: "https://example.com/",
          executable: false,
          overwritten: false,
          boundary:
            "Verified create-only promotion from Pixel Operations quarantine into the configured owner workspace; no arbitrary source, overwrite, execution, or path traversal authority.",
        },
      },
    },
  });
  const delivered = reply(guard)?.payload?.text;
  assert.match(delivered, new RegExp(`^${EXACT_DOWNLOAD_PUBLISHED_DELIVERY_PREFIX}`));
  assert.match(delivered, /web\/example\.html/);
  assert.match(delivered, /Bytes: 559/);
  assert.match(delivered, /a{64}/);
  assert.match(delivered, /Executable: no; overwrite: no/);
});

test("rejects mismatched or malformed staged-download terminal evidence", () => {
  const guard = createToolLoopGuard();
  const jobId = "ops-1234567890123-abcdef123456";
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Save exact origin bytes from https://example.com/ as substitute.html and give me the SHA-256." }
  );
  afterCall(guard, "pixel_ops_download_stage", {
    event: {
      params: { url: "https://example.com/", filename: "substitute.html" },
      result: { details: { jobId, status: "submitted", kind: "download" } },
    },
  });
  afterCall(guard, "pixel_ops_job_get", {
    event: {
      params: { jobId },
      result: {
        details: {
          jobId,
          status: "succeeded",
          steps: [{
            action: "download.stage",
            target: "broker",
            exitCode: 0,
            artifact: {
              path: "workspace/substitute.html",
              filename: "substitute.html",
              bytes: 12,
              sha256: "b".repeat(64),
              source: "https://example.com/",
              redirects: [],
              executable: false,
            },
          }],
        },
      },
    },
  });
  assert.equal(reply(guard)?.payload?.text, EXACT_DOWNLOAD_UNVERIFIED_DELIVERY_PREFIX);
});

test("binds staged-download success to the submitted expected digest", () => {
  const guard = createToolLoopGuard();
  const jobId = "ops-1234567890123-abcdef123456";
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    {
      prompt: `Download https://example.com/ as exact.html, preserve the exact bytes, and verify SHA-256 ${"d".repeat(64)}.`,
    }
  );
  afterCall(guard, "pixel_ops_download_stage", {
    event: {
      params: {
        url: "https://example.com/",
        filename: "exact.html",
        expectedSha256: "d".repeat(64),
      },
      result: { details: { jobId, status: "submitted", kind: "download" } },
    },
  });
  afterCall(guard, "pixel_ops_job_get", {
    event: {
      params: { jobId },
      result: {
        details: {
          jobId,
          status: "succeeded",
          steps: [{
            action: "download.stage",
            target: "broker",
            exitCode: 0,
            artifact: {
              path: `/var/lib/pixel-ops-broker/artifacts/${jobId}/exact.html`,
              filename: "exact.html",
              bytes: 559,
              sha256: "e".repeat(64),
              source: "https://example.com/",
              redirects: [],
              expectedSha256Matched: true,
              executable: false,
            },
          }],
        },
      },
    },
  });
  assert.equal(reply(guard)?.payload?.text, EXACT_DOWNLOAD_UNVERIFIED_DELIVERY_PREFIX);
});

test("reports a matching staged-download terminal failure without claiming an artifact", () => {
  const guard = createToolLoopGuard();
  const jobId = "ops-1234567890123-abcdef123456";
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Download https://example.com/ as exact.html and report the exact-byte artifact digest." }
  );
  afterCall(guard, "pixel_ops_download_stage", {
    event: {
      params: { url: "https://example.com/", filename: "exact.html" },
      result: { details: { jobId, status: "submitted", kind: "download" } },
    },
  });
  afterCall(guard, "pixel_ops_job_wait", {
    event: {
      params: { jobId, timeoutSeconds: 20 },
      result: {
        details: {
          jobId,
          status: "failed",
          waitTimedOut: false,
        },
      },
    },
  });
  assert.equal(
    reply(guard)?.payload?.text,
    `${EXACT_DOWNLOAD_FAILED_DELIVERY_PREFIX} Job: ${jobId}. Terminal status: failed.`
  );
});

test("reports a matching immutable staged-download plan that needs owner approval", () => {
  const guard = createToolLoopGuard();
  const jobId = "ops-1234567890123-abcdef123456";
  const planHash = "c".repeat(64);
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Download https://example.com/ as exact.html and report the exact-byte artifact digest." }
  );
  afterCall(guard, "pixel_ops_download_stage", {
    event: {
      params: { url: "https://example.com/", filename: "exact.html" },
      result: { details: { jobId, status: "submitted", kind: "download" } },
    },
  });
  afterCall(guard, "pixel_ops_job_get", {
    event: {
      params: { jobId },
      result: {
        details: {
          jobId,
          status: "awaiting-approval",
          approvalRequired: true,
          planHash,
          waitTimedOut: false,
        },
      },
    },
  });
  assert.equal(
    reply(guard)?.payload?.text,
    `${EXACT_DOWNLOAD_APPROVAL_DELIVERY_PREFIX} Job: ${jobId}. Plan SHA-256: ${planHash}.`
  );
});

test("rejects malformed staged-download approval evidence", () => {
  const guard = createToolLoopGuard();
  const jobId = "ops-1234567890123-abcdef123456";
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Fetch the exact origin bytes from https://example.com/ and save the artifact as exact.html." }
  );
  afterCall(guard, "pixel_ops_download_stage", {
    event: {
      params: { url: "https://example.com/", filename: "exact.html" },
      result: { details: { jobId, status: "submitted", kind: "download" } },
    },
  });
  afterCall(guard, "pixel_ops_job_get", {
    event: {
      params: { jobId },
      result: {
        details: {
          jobId,
          status: "awaiting-approval",
          approvalRequired: true,
          planHash: "not-a-digest",
          waitTimedOut: false,
        },
      },
    },
  });
  assert.equal(reply(guard)?.payload?.text, EXACT_DOWNLOAD_UNVERIFIED_DELIVERY_PREFIX);
});

test("routes explicit ODS facts through projections before mixed workspace work", () => {
  const guard = createToolLoopGuard();
  const context = { agentId: "pixel", runId: "run-1", sessionId: "session-1" };
  const prompt =
    "Use ODS tools to identify the exact active model and configured n8n URL, then create result.txt.";
  assert.deepEqual(userMessageOdsToolRequirements([], prompt), [
    "pixel_ods_status",
    "pixel_ods_apps_list",
  ]);
  guard.observeRun(context, "pixel", { prompt });

  const redirected = call(guard, "exec", { event: { params: { command: "find ." } } });
  assert.equal(redirected.block, true);
  assert.match(redirected.blockReason, /call pixel_ods_status and pixel_ods_apps_list exactly once/);
  assert.equal(call(guard, "pixel_ods_status"), undefined);
  assert.equal(call(guard, "pixel_ods_apps_list"), undefined);
  assert.equal(call(guard, "exec", { event: { params: { command: "printf done" } } }), undefined);
});

test("does not route unrelated model, app, or n8n implementation work", () => {
  assert.deepEqual(userMessageOdsToolRequirements([], "Explain model classes in my app."), []);
  assert.deepEqual(
    userMessageOdsToolRequirements([], "Create an n8n workflow fixture in flow.json."),
    []
  );
  assert.deepEqual(userMessageOdsToolRequirements([], "Which model is currently active?"), [
    "pixel_ods_status",
  ]);
  assert.deepEqual(userMessageOdsToolRequirements([], "Is Pixel available?"), [
    "pixel_ods_status",
  ]);
  assert.deepEqual(
    userMessageOdsToolRequirements(
      [],
      "Use the safe Operations capabilities available to inspect the ODS host kernel."
    ),
    []
  );
  assert.deepEqual(userMessageOdsToolRequirements([], "What is the configured n8n URL?"), [
    "pixel_ods_apps_list",
  ]);
  assert.deepEqual(
    userMessageOdsToolRequirements(
      [],
      "Research https://github.com/Osmantic/Pixel. Do not use shell or ODS status tools."
    ),
    []
  );
  assert.deepEqual(
    userMessageOdsToolRequirements([], "Research Pixel without using ODS tools."),
    []
  );
  assert.deepEqual(
    userMessageOdsToolRequirements(
      [],
      "Inspect https://github.com/Osmantic/ODS and end each claim with a source URL. Do not use ODS status tools."
    ),
    []
  );
  assert.deepEqual(userMessageOdsToolRequirements([], "List the ODS URLs."), [
    "pixel_ods_apps_list",
  ]);
  assert.deepEqual(userMessageOdsToolRequirements([], "Which ODS apps are local?"), [
    "pixel_ods_apps_list",
  ]);
  assert.deepEqual(
    userMessageOdsToolRequirements(
      [],
      "Do not use shell, but use pixel_ods_status exactly once for the current model."
    ),
    ["pixel_ods_status"]
  );
});

test("classifies explicit host evidence as Operations work", () => {
  assert.equal(
    userMessageRequiresOperations(
      [],
      "Tell me the ODS host hostname, kernel, and machine architecture using Operations capabilities."
    ),
    true
  );
  assert.equal(
    userMessageRequiresOperations([], "Explain the operational considerations in this code."),
    false
  );
  assert.equal(userMessageRequiresOperations([], "Run unit tests in the workspace."), false);
  assert.deepEqual(
    userMessageOperationsRequirements(
      [],
      "Tell me the exact hostname, kernel, OS signature, and machine architecture of the ODS host."
    ),
    {
      required: true,
      actions: ["host.identity", "host.kernel", "host.architecture", "host.os-release"],
    }
  );
});

test("classifies installable extension catalog work as one exact Operations action", () => {
  for (const prompt of [
    "Search the installable ODS extension catalog for workflow automation.",
    "Which extensions are available for notebooks?",
    "Call ods.extensions.search with query x; id exactly.",
  ]) {
    assert.equal(userMessageRequestsExtensionCatalog([], prompt), true);
    assert.deepEqual(userMessageOperationsRequirements([], prompt), {
      required: true,
      actions: ["ods.extensions.search"],
    });
  }
  assert.equal(
    userMessageRequestsExtensionCatalog([], "List the installed ODS applications and URLs."),
    false
  );
  assert.equal(
    userMessageExtensionCatalogExactQuery(
      [],
      "Call ods.extensions.search with query x; id exactly as written."
    ),
    "x; id"
  );
  assert.equal(
    userMessageExtensionCatalogExactQuery(
      [],
      "Search the extension catalog with query: `workflow automation`."
    ),
    "workflow automation"
  );
});

test("routes extension catalog requests only to the exact broker action", () => {
  const guard = createToolLoopGuard();
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Search the installable ODS extension catalog for notebooks." }
  );
  assert.deepEqual(call(guard, "pixel_ods_apps_list"), {
    block: true,
    blockReason: OPERATIONS_REQUIRES_BROKER_REASON,
  });
  assert.equal(call(guard, "pixel_ops_inventory"), undefined);
  assert.match(
    call(guard, "pixel_ops_run", {
      event: {
        params: {
          target: "ods-host",
          action: "host.identity",
          parameters: {},
        },
      },
    })?.blockReason,
    new RegExp(OPERATIONS_WRONG_ACTION_REASON)
  );
  assert.deepEqual(
    call(guard, "pixel_ops_run", {
      event: {
        params: {
          target: "ods-host",
          action: "ods.extensions.search",
          parameters: { query: "notebook" },
        },
      },
    }),
    undefined
  );
});

test("repairs a distorted owner-labeled extension query before the broker boundary", () => {
  const guard = createToolLoopGuard();
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Call ods.extensions.search with query x; id exactly as written." }
  );
  assert.deepEqual(
    call(guard, "pixel_ops_run", {
      event: {
        params: {
          target: "ods-host",
          action: "ods.extensions.search",
          parameters: { query: "x" },
        },
      },
    }),
    {
      params: {
        target: "ods-host",
        action: "ods.extensions.search",
        parameters: { query: "x; id" },
      },
    }
  );
  assert.equal(
    call(guard, "pixel_ops_run", {
      event: {
        params: {
          target: "ods-host",
          action: "ods.extensions.search",
          parameters: { query: "x; id" },
        },
      },
    }),
    undefined
  );
});

test("renders a strictly validated extension catalog receipt instead of host evidence", () => {
  const guard = createToolLoopGuard();
  const jobId = "ops-1234567890123-abcdef123456";
  const parameters = { query: "workflow automation" };
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Search the installable ODS extension catalog for workflow automation." }
  );
  afterCall(guard, "pixel_ops_run", {
    event: {
      params: { target: "ods-host", action: "ods.extensions.search", parameters },
      result: { details: { jobId, status: "submitted", kind: "action" } },
    },
  });
  afterCall(guard, "pixel_ops_job_wait", {
    event: {
      params: { jobId },
      result: {
        details: {
          jobId,
          status: "succeeded",
          waitTimedOut: false,
          steps: [{
            stepId: "step",
            target: "ods-host",
            action: "ods.extensions.search",
            exitCode: 0,
            stdout: JSON.stringify({
              schemaVersion: 1,
              kind: "ods-pixel-extension-search",
              query: "workflow automation",
              totalCatalog: 30,
              totalMatches: 1,
              truncated: false,
              matches: [{
                id: "n8n",
                name: "n8n",
                description: "Workflow automation platform.",
                category: "recommended",
                gpuBackends: ["all"],
                dependsOn: [],
                requiredConfiguration: ["N8N_ENCRYPTION_KEY"],
                optionalConfiguration: ["N8N_HOST"],
                tags: ["automation"],
                featureNames: ["Workflow Automation"],
              }],
              boundary:
                "Read-only catalog projection; it grants no installation or configuration authority.",
            }) + "\n",
            stderr: "",
            outputTruncated: { stdout: false, stderr: false },
            riskSignals: [],
          }],
        },
      },
    },
  });
  const text = reply(guard)?.payload?.text;
  assert.match(text, new RegExp(`^${OPERATIONS_EXTENSION_CATALOG_EVIDENCE_PREFIX}`));
  assert.match(text, /Top match: `n8n` \(`n8n`\)/);
  assert.match(text, /Required configuration keys: `N8N_ENCRYPTION_KEY`/);
  assert.match(text, /no installation or configuration authority/);
  assert.doesNotMatch(text, /host facts/);
});

test("classifies one exact extension lifecycle action and owner extension ID", () => {
  assert.deepEqual(
    userMessageExtensionLifecycleIntent([], "Install the ODS extension CrewAI."),
    { action: "install", serviceId: "crewai" }
  );
  assert.deepEqual(
    userMessageExtensionLifecycleIntent([], "Uninstall extension n8n"),
    { action: "remove", serviceId: "n8n" }
  );
  assert.deepEqual(
    userMessageExtensionLifecycleIntent([], "Enable ODS extension vendor.crewai."),
    { action: "enable", serviceId: "vendor.crewai" }
  );
  assert.deepEqual(
    userMessageExtensionLifecycleIntent(
      [],
      "Inspect and enable the installed ODS extension continue."
    ),
    { action: "enable", serviceId: "continue" }
  );
  assert.equal(
    userMessageExtensionLifecycleIntent([], `Install ODS extension ${"a".repeat(65)}`),
    undefined
  );
  assert.deepEqual(
    userMessageOperationsRequirements([], "Install the ODS extension CrewAI."),
    {
      required: true,
      actions: ["ods.extensions.inspect", "ods.extensions.install"],
    }
  );
});

test("binds Operations continuation only to one exact current-message job and plan hash", () => {
  const jobId = "ops-1234567890123-abcdef123456";
  const planHash = "a".repeat(64);
  assert.deepEqual(
    userMessageOperationsContinuation(
      [],
      `Check exact job ${jobId} with plan SHA-256 ${planHash} and report its status.`
    ),
    { jobId, planHash }
  );
  assert.equal(
    userMessageOperationsContinuation(
      [],
      `Approved job ${jobId} with plan SHA-256 ${planHash}.`
    ),
    undefined
  );
  assert.equal(
    userMessageOperationsContinuation(
      [],
      `Check jobs ${jobId} and ops-1234567890124-fedcba654321 with plan SHA-256 ${planHash}.`
    ),
    undefined
  );
  const currentJob = "ops-1234567890125-012345abcdef";
  const currentHash = "b".repeat(64);
  assert.deepEqual(
    userMessageOperationsContinuation(
      [],
      `[Chat messages since your last reply - for context]\n` +
        `Assistant: Job ${jobId}. Plan SHA-256: ${planHash}.\n\n` +
        `[Current message - respond to this]\nUser: Check job ${currentJob} ` +
        `with plan SHA-256 ${currentHash}.`
    ),
    { jobId: currentJob, planHash: currentHash }
  );
});

test("forces extension lifecycle inspection, exact IDs, and sequential submissions", () => {
  const guard = createToolLoopGuard();
  const inspectJob = "ops-1234567890123-abcdef123456";
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Install the ODS extension crewai." }
  );
  assert.equal(
    call(guard, "pixel_ops_workflow_submit", { event: { params: { steps: [] } } })
      ?.blockReason,
    OPERATIONS_EXTENSION_LIFECYCLE_SEQUENCE_REASON
  );
  assert.equal(
    call(guard, "pixel_ops_run", {
      event: {
        params: {
          target: "ods-host",
          action: "ods.extensions.install",
          parameters: { serviceId: "different" },
        },
      },
    })?.blockReason,
    OPERATIONS_EXTENSION_LIFECYCLE_SEQUENCE_REASON
  );
  assert.deepEqual(
    call(guard, "pixel_ops_run", {
      event: {
        params: {
          target: "invented",
          action: "ods.extensions.inspect",
          parameters: { serviceId: "different", command: "id" },
        },
      },
    }),
    {
      params: {
        target: "ods-host",
        action: "ods.extensions.inspect",
        parameters: { serviceId: "crewai" },
      },
    }
  );
  afterCall(guard, "pixel_ops_run", {
    event: {
      params: {
        target: "ods-host",
        action: "ods.extensions.inspect",
        parameters: { serviceId: "crewai" },
      },
      result: { details: { jobId: inspectJob, status: "submitted", kind: "action" } },
    },
  });
  afterCall(guard, "pixel_ops_job_wait", {
    event: {
      params: { jobId: inspectJob },
      result: {
        details: {
          jobId: inspectJob,
          status: "succeeded",
          waitTimedOut: false,
          steps: [lifecycleStep("inspect")],
        },
      },
    },
  });
  assert.deepEqual(
    call(guard, "pixel_ops_run", {
      event: {
        params: {
          target: "wrong",
          action: "ods.extensions.install",
          parameters: { serviceId: "n8n", extra: true },
        },
      },
    }),
    {
      params: {
        target: "ods-host",
        action: "ods.extensions.install",
        parameters: { serviceId: "crewai" },
      },
    }
  );
});

test("renders missing extension configuration as a verified no-effect result", () => {
  const guard = createToolLoopGuard();
  const jobId = "ops-1234567890123-abcdef123456";
  const parameters = { serviceId: "crewai" };
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Install the ODS extension crewai." }
  );
  afterCall(guard, "pixel_ops_run", {
    event: {
      params: { target: "ods-host", action: "ods.extensions.inspect", parameters },
      result: { details: { jobId, status: "submitted", kind: "action" } },
    },
  });
  afterCall(guard, "pixel_ops_job_wait", {
    event: {
      params: { jobId },
      result: {
        details: {
          jobId,
          status: "succeeded",
          waitTimedOut: false,
          steps: [lifecycleStep("inspect", lifecycleResult("inspect", {
            outcome: "blocked",
            requiredConfiguration: ["CREWAI_API_KEY"],
            missingConfiguration: ["CREWAI_API_KEY"],
          }))],
        },
      },
    },
  });
  assert.equal(
    call(guard, "pixel_ops_run", {
      event: {
        params: { target: "ods-host", action: "ods.extensions.install", parameters },
      },
    })?.blockReason,
    OPERATIONS_EXTENSION_LIFECYCLE_SEQUENCE_REASON
  );
  const text = reply(guard)?.payload?.text;
  assert.match(text, new RegExp(`^${OPERATIONS_EXTENSION_LIFECYCLE_EVIDENCE_PREFIX}`));
  assert.match(text, /Missing required configuration keys: `CREWAI_API_KEY`/);
  assert.match(text, /no change or external effect occurred/);
});

test("accepts verified lifecycle no-ops when inspection already satisfies the request", async (t) => {
  const cases = [
    ["install", "Install the ODS extension continue.", "enabled"],
    ["enable", "Inspect and enable the installed ODS extension continue.", "cli_installed"],
    ["disable", "Disable the ODS extension continue.", "disabled"],
    ["remove", "Remove the ODS extension continue.", "not_installed"],
  ];
  for (const [action, prompt, status] of cases) {
    await t.test(action, () => {
      const guard = createToolLoopGuard();
      const inspectJob = "ops-1234567890123-abcdef123456";
      const parameters = { serviceId: "continue" };
      guard.observeRun(
        { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
        "pixel",
        { prompt }
      );
      afterCall(guard, "pixel_ops_run", {
        event: {
          params: { target: "ods-host", action: "ods.extensions.inspect", parameters },
          result: { details: { jobId: inspectJob, status: "submitted", kind: "action" } },
        },
      });
      afterCall(guard, "pixel_ops_job_wait", {
        event: {
          params: { jobId: inspectJob },
          result: {
            details: {
              jobId: inspectJob,
              status: "succeeded",
              waitTimedOut: false,
              steps: [lifecycleStep("inspect", lifecycleResult("inspect", {
                extensionId: "continue",
                previousStatus: status,
                currentStatus: status,
              }))],
            },
          },
        },
      });

      const text = reply(guard)?.payload?.text;
      assert.match(text, new RegExp(`^${OPERATIONS_EXTENSION_LIFECYCLE_EVIDENCE_PREFIX}`));
      assert.match(text, new RegExp(`Requested action: \`${action}\`; verified outcome: already satisfied`));
      assert.match(text, new RegExp(`State: \`${status}\`; no mutation or external effect was needed`));
      assert.match(text, new RegExp(inspectJob));
    });
  }
});

test("does not treat an inspection in the wrong state as a lifecycle no-op", () => {
  const guard = createToolLoopGuard();
  const inspectJob = "ops-1234567890123-abcdef123456";
  const parameters = { serviceId: "continue" };
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Inspect and enable the installed ODS extension continue." }
  );
  afterCall(guard, "pixel_ops_run", {
    event: {
      params: { target: "ods-host", action: "ods.extensions.inspect", parameters },
      result: { details: { jobId: inspectJob, status: "submitted", kind: "action" } },
    },
  });
  afterCall(guard, "pixel_ops_job_wait", {
    event: {
      params: { jobId: inspectJob },
      result: {
        details: {
          jobId: inspectJob,
          status: "succeeded",
          waitTimedOut: false,
          steps: [lifecycleStep("inspect", lifecycleResult("inspect", {
            extensionId: "continue",
            previousStatus: "disabled",
            currentStatus: "disabled",
          }))],
        },
      },
    },
  });

  assert.equal(reply(guard)?.payload?.text, OPERATIONS_UNVERIFIED_DELIVERY_PREFIX);
});

test("reports an immutable lifecycle approval without claiming completion", () => {
  const guard = createToolLoopGuard();
  const inspectJob = "ops-1234567890123-abcdef123456";
  const enableJob = "ops-1234567890124-fedcba654321";
  const planHash = "d".repeat(64);
  const parameters = { serviceId: "continue" };
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Inspect and enable the installed ODS extension continue." }
  );
  afterCall(guard, "pixel_ops_run", {
    event: {
      params: { target: "ods-host", action: "ods.extensions.inspect", parameters },
      result: { details: { jobId: inspectJob, status: "submitted", kind: "action" } },
    },
  });
  afterCall(guard, "pixel_ops_job_wait", {
    event: {
      params: { jobId: inspectJob },
      result: {
        details: {
          jobId: inspectJob,
          status: "succeeded",
          waitTimedOut: false,
          steps: [lifecycleStep("inspect", lifecycleResult("inspect", {
            extensionId: "continue",
            previousStatus: "disabled",
            currentStatus: "disabled",
          }))],
        },
      },
    },
  });
  afterCall(guard, "pixel_ops_run", {
    event: {
      params: { target: "ods-host", action: "ods.extensions.enable", parameters },
      result: { details: { jobId: enableJob, status: "submitted", kind: "action" } },
    },
  });
  afterCall(guard, "pixel_ops_job_wait", {
    event: {
      params: { jobId: enableJob },
      result: {
        details: {
          jobId: enableJob,
          status: "awaiting-approval",
          waitTimedOut: false,
          approvalRequired: true,
          planHash,
        },
      },
    },
  });
  const text = reply(guard)?.payload?.text;
  assert.match(text, /^Pixel prepared the exact ods\.extensions\.enable plan/);
  assert.match(text, /external approval is required/);
  assert.match(text, new RegExp(enableJob));
  assert.match(text, new RegExp(planHash));
  assert.match(text, /No lifecycle change was executed/);
  assert.doesNotMatch(text, new RegExp(`^${OPERATIONS_EXTENSION_LIFECYCLE_EVIDENCE_PREFIX}`));
});

test("accepts an exact failed remove receipt only when rollback restores prior state", () => {
  const guard = createToolLoopGuard();
  const inspectJob = "ops-1234567890123-abcdef123456";
  const removeJob = "ops-1234567890124-fedcba654321";
  const parameters = { serviceId: "continue" };
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Remove the installed ODS extension continue." }
  );
  for (const [action, jobId, step] of [
    ["ods.extensions.inspect", inspectJob, lifecycleStep("inspect", lifecycleResult("inspect", {
      extensionId: "continue",
      previousStatus: "enabled",
      currentStatus: "enabled",
    }))],
    ["ods.extensions.remove", removeJob, lifecycleStep("remove", lifecycleResult("remove", {
      extensionId: "continue",
      outcome: "failed",
      previousStatus: "enabled",
      currentStatus: "cli_installed",
      changed: false,
      externalEffectOccurred: true,
      rollback: { attempted: true, succeeded: true },
    }))],
  ]) {
    afterCall(guard, "pixel_ops_run", {
      event: {
        params: { target: "ods-host", action, parameters },
        result: { details: { jobId, status: "submitted", kind: "action" } },
      },
    });
    afterCall(guard, "pixel_ops_job_wait", {
      event: {
        params: { jobId },
        result: {
          details: {
            jobId,
            status: "succeeded",
            waitTimedOut: false,
            steps: [step],
          },
        },
      },
    });
  }
  const text = reply(guard)?.payload?.text;
  assert.match(text, new RegExp(`^${OPERATIONS_EXTENSION_LIFECYCLE_EVIDENCE_PREFIX}`));
  assert.match(text, /Requested action: `remove`; verified outcome: `failed`/);
  assert.match(text, /State: `enabled` -> `cli_installed`/);
  assert.match(text, /Rollback: succeeded/);
});

test("accepts only a structurally bound extension lifecycle success receipt", () => {
  const guard = createToolLoopGuard();
  const inspectJob = "ops-1234567890123-abcdef123456";
  const installJob = "ops-1234567890124-fedcba654321";
  const parameters = { serviceId: "crewai" };
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Install the ODS extension crewai." }
  );
  for (const [action, jobId, step] of [
    ["ods.extensions.inspect", inspectJob, lifecycleStep("inspect")],
    ["ods.extensions.install", installJob, lifecycleStep("install")],
  ]) {
    afterCall(guard, "pixel_ops_run", {
      event: {
        params: { target: "ods-host", action, parameters },
        result: { details: { jobId, status: "submitted", kind: "action" } },
      },
    });
    afterCall(guard, "pixel_ops_job_wait", {
      event: {
        params: { jobId },
        result: {
          details: {
            jobId,
            status: "succeeded",
            waitTimedOut: false,
            steps: [step],
          },
        },
      },
    });
  }
  const text = reply(guard)?.payload?.text;
  assert.match(text, new RegExp(`^${OPERATIONS_EXTENSION_LIFECYCLE_EVIDENCE_PREFIX}`));
  assert.match(text, /Requested action: `install`; verified outcome: `succeeded`/);
  assert.match(text, /State: `not_installed` -> `enabled`/);
  assert.match(text, /external effect attempted: yes/);
});

test("continues one exact approved lifecycle job without resubmitting the mutation", () => {
  const guard = createToolLoopGuard();
  const jobId = "ops-1234567890124-fedcba654321";
  const planHash = "d".repeat(64);
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    {
      prompt:
        `The administrator approved job ${jobId} with plan SHA-256 ${planHash}. ` +
        "Check that exact job and report only the host-authoritative status.",
    }
  );
  assert.equal(
    call(guard, "pixel_ops_inventory")?.blockReason,
    OPERATIONS_CONTINUATION_REQUIRES_STATUS_REASON
  );
  assert.deepEqual(
    call(guard, "pixel_ops_job_get", {
      event: { params: { jobId: "ops-1234567890999-aaaaaaaaaaaa" } },
    }),
    { params: { jobId } }
  );
  afterCall(guard, "pixel_ops_job_get", {
    event: {
      params: { jobId },
      result: {
        details: {
          jobId,
          planHash,
          status: "succeeded",
          approvalRequired: true,
          waitTimedOut: false,
          steps: [lifecycleStep("install", lifecycleResult("install", {
            extensionId: "continue",
          }))],
        },
      },
    },
  });
  const text = reply(guard)?.payload?.text;
  assert.match(text, new RegExp(`^${OPERATIONS_EXTENSION_LIFECYCLE_EVIDENCE_PREFIX}`));
  assert.match(text, /Extension: `continue`/);
  assert.match(text, /Requested action: `install`; verified outcome: `succeeded`/);
  assert.match(text, new RegExp(jobId));
  assert.match(text, new RegExp(planHash));
});

test("rejects approval prose and mismatched continuation receipts as host evidence", () => {
  const guard = createToolLoopGuard();
  const jobId = "ops-1234567890124-fedcba654321";
  const planHash = "d".repeat(64);
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    {
      prompt:
        `I approved job ${jobId} with plan SHA-256 ${planHash}; ` +
        "check it and report the status.",
    }
  );
  assert.equal(
    reply(guard)?.payload?.text,
    OPERATIONS_CONTINUATION_UNVERIFIED_DELIVERY_PREFIX
  );
  afterCall(guard, "pixel_ops_job_get", {
    event: {
      params: { jobId },
      result: {
        details: {
          jobId,
          planHash: "e".repeat(64),
          status: "succeeded",
          approvalRequired: true,
          waitTimedOut: false,
          steps: [lifecycleStep("install")],
        },
      },
    },
  });
  assert.equal(
    reply(guard)?.payload?.text,
    OPERATIONS_CONTINUATION_UNVERIFIED_DELIVERY_PREFIX
  );
});

test("fails closed on truncated or multi-step continuation evidence", () => {
  const jobId = "ops-1234567890124-fedcba654321";
  const planHash = "d".repeat(64);
  const baseStep = lifecycleStep("install");
  for (const steps of [
    [{
      ...baseStep,
      outputTruncated: { stdout: true, stderr: false },
    }],
    [baseStep, lifecycleStep("remove", lifecycleResult("remove", {
      previousStatus: "disabled",
      currentStatus: "not_installed",
    }))],
  ]) {
    const guard = createToolLoopGuard();
    guard.observeRun(
      { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
      "pixel",
      { prompt: `Check job ${jobId} with plan SHA-256 ${planHash}.` }
    );
    afterCall(guard, "pixel_ops_job_get", {
      event: {
        params: { jobId },
        result: {
          details: {
            jobId,
            planHash,
            status: "succeeded",
            approvalRequired: true,
            waitTimedOut: false,
            steps,
          },
        },
      },
    });
    assert.equal(
      reply(guard)?.payload?.text,
      OPERATIONS_CONTINUATION_UNVERIFIED_DELIVERY_PREFIX
    );
  }
});

test("reports a matching terminal continuation failure without model improvisation", () => {
  const guard = createToolLoopGuard();
  const jobId = "ops-1234567890124-fedcba654321";
  const planHash = "d".repeat(64);
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: `Verify job ${jobId} with plan SHA-256 ${planHash}.` }
  );
  afterCall(guard, "pixel_ops_job_get", {
    event: {
      params: { jobId },
      result: {
        details: {
          jobId,
          planHash,
          status: "failed",
          waitTimedOut: false,
        },
      },
    },
  });
  const text = reply(guard)?.payload?.text;
  assert.match(text, /verified terminal status is failed/);
  assert.match(text, /No successful lifecycle result was accepted/);
  assert.doesNotMatch(text, /Model claimed success/);
});

test("routes host evidence through Operations and requires a matching terminal job", () => {
  const guard = createToolLoopGuard();
  const jobId = "ops-1234567890123-abcdef123456";
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Use Operations to report the ODS host identity." }
  );
  assert.deepEqual(call(guard, "exec", { event: { params: { command: "hostname" } } }), {
    block: true,
    blockReason: OPERATIONS_REQUIRES_BROKER_REASON,
  });
  assert.equal(call(guard, "pixel_ops_inventory"), undefined);
  assert.match(
    call(guard, "pixel_ops_run", {
      event: { params: { target: "ods-host", action: "host.platform" } },
    })?.blockReason,
    new RegExp(OPERATIONS_WRONG_ACTION_REASON)
  );
  assert.equal(
    call(guard, "pixel_ops_run", {
      event: { params: { target: "ods-host", action: "host.identity" } },
    }),
    undefined
  );
  afterCall(guard, "pixel_ops_run", {
    event: {
      params: { target: "ods-host", action: "host.identity" },
      result: { details: { jobId, status: "submitted", kind: "action" } },
    },
  });
  assert.equal(reply(guard)?.payload?.text, OPERATIONS_UNVERIFIED_DELIVERY_PREFIX);
  afterCall(guard, "pixel_ops_job_wait", {
    event: {
      params: { jobId },
      result: {
        details: {
          jobId,
          status: "succeeded",
          waitTimedOut: false,
          steps: [{
            stepId: "step",
            target: "ods-host",
            action: "host.identity",
            exitCode: 0,
            stdout: "light-worker\n",
            stderr: "",
            outputTruncated: { stdout: false, stderr: false },
            riskSignals: [],
          }],
        },
      },
    },
  });
  assert.equal(
    reply(guard)?.payload?.text,
    `${OPERATIONS_HOST_EVIDENCE_PREFIX}\n- Hostname: \`light-worker\` (job \`${jobId}\`)`
  );
});

test("binds every requested host fact to exact workflow actions and terminal output", () => {
  const guard = createToolLoopGuard();
  const jobId = "ops-1234567890123-abcdef123456";
  const prompt =
    "Tell me the exact hostname, kernel, OS signature, and machine architecture of the ODS host using Operations.";
  const steps = [
    { id: "identity", target: "ods-host", action: "host.identity" },
    { id: "kernel", target: "ods-host", action: "host.kernel" },
    { id: "architecture", target: "ods-host", action: "host.architecture" },
    { id: "os", target: "ods-host", action: "host.os-release" },
  ];
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt }
  );
  assert.equal(
    call(guard, "pixel_ops_workflow_submit", { event: { params: { steps } } }),
    undefined
  );
  afterCall(guard, "pixel_ops_workflow_submit", {
    event: {
      params: { steps },
      result: { details: { jobId, status: "submitted", kind: "workflow" } },
    },
  });
  afterCall(guard, "pixel_ops_job_wait", {
    event: {
      params: { jobId },
      result: {
        details: {
          jobId,
          status: "succeeded",
          waitTimedOut: false,
          steps: [
            { stepId: "identity", target: "ods-host", action: "host.identity", exitCode: 0, stdout: "light-worker\n", stderr: "", outputTruncated: { stdout: false, stderr: false }, riskSignals: [] },
            { stepId: "kernel", target: "ods-host", action: "host.kernel", exitCode: 0, stdout: "Linux 6.6.87.2-microsoft-standard-WSL2\n", stderr: "", outputTruncated: { stdout: false, stderr: false }, riskSignals: [] },
            { stepId: "architecture", target: "ods-host", action: "host.architecture", exitCode: 0, stdout: "x86_64\n", stderr: "", outputTruncated: { stdout: false, stderr: false }, riskSignals: [] },
            { stepId: "os", target: "ods-host", action: "host.os-release", exitCode: 0, stdout: 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nNAME="Ubuntu"\n', stderr: "", outputTruncated: { stdout: false, stderr: false }, riskSignals: [] },
          ],
        },
      },
    },
  });
  const text = reply(guard)?.payload?.text;
  assert.match(text, new RegExp(`^${OPERATIONS_HOST_EVIDENCE_PREFIX}`));
  assert.match(text, /Hostname: `light-worker`/);
  assert.match(text, /Kernel: `Linux 6\.6\.87\.2-microsoft-standard-WSL2`/);
  assert.match(text, /Architecture: `x86_64`/);
  assert.match(text, /Operating system: `Ubuntu 24\.04\.3 LTS`/);
  assert.doesNotMatch(text, /Model claimed success/);
});

test("rejects terminal Operations evidence whose action or output is not bound", () => {
  const guard = createToolLoopGuard();
  const jobId = "ops-1234567890123-abcdef123456";
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Use Operations to report the ODS host identity." }
  );
  afterCall(guard, "pixel_ops_run", {
    event: {
      params: { target: "ods-host", action: "host.identity" },
      result: { details: { jobId, status: "submitted", kind: "action" } },
    },
  });
  afterCall(guard, "pixel_ops_job_wait", {
    event: {
      params: { jobId },
      result: {
        details: {
          jobId,
          status: "succeeded",
          waitTimedOut: false,
          steps: [{
            stepId: "step",
            target: "ods-host",
            action: "host.platform",
            exitCode: 0,
            stdout: "invented-host",
            stderr: "",
            outputTruncated: { stdout: false, stderr: false },
            riskSignals: [],
          }],
        },
      },
    },
  });
  assert.equal(reply(guard)?.payload?.text, OPERATIONS_UNVERIFIED_DELIVERY_PREFIX);
});

test("fails closed when Operations work is not submitted or routing is ignored", () => {
  const aborts = [];
  const guard = createToolLoopGuard({
    abortRun: (sessionId) => {
      aborts.push(sessionId);
      return true;
    },
  });
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Use the Operations Broker to inspect the ODS host platform." }
  );
  assert.deepEqual(call(guard, "exec"), {
    block: true,
    blockReason: OPERATIONS_REQUIRES_BROKER_REASON,
  });
  assert.deepEqual(call(guard, "read"), {
    block: true,
    blockReason: OPERATIONS_LOOP_ABORT_REASON,
  });
  assert.deepEqual(aborts, ["session-1"]);
  assert.equal(reply(guard)?.payload?.text, OPERATIONS_UNAVAILABLE_DELIVERY_PREFIX);
  assert.deepEqual(guard.verificationForRun("run-1"), {
    status: "failed",
    text: OPERATIONS_UNAVAILABLE_DELIVERY_PREFIX,
    code: OPERATIONS_UNAVAILABLE_ZERO_SUBMISSIONS_CODE,
  });
});

test("routes from only the current dashboard message, not stale transcript context", () => {
  const workspaceFollowup = `[Chat messages since your last reply - for context]
User: Inspect ODS health and identify the active model.
Assistant: The active model is Qwen.

[Current message - respond to this]
User: Create a workspace cancellation probe.`;
  assert.deepEqual(userMessageOdsToolRequirements([], workspaceFollowup), []);
  assert.equal(userMessageRequestsPrivateUrl([], workspaceFollowup), false);

  const statusFollowup = `[Chat messages since your last reply - for context]
User: Create a workspace file.
Assistant: Done.

[Current message - respond to this]
User: Which ODS model is currently active?`;
  assert.deepEqual(userMessageOdsToolRequirements([], statusFollowup), [
    "pixel_ods_status",
  ]);
});

test("does not inherit private access or delete authority from stale transcript context", () => {
  const safeFollowup = `[Chat messages since your last reply - for context]
User: Open http://127.0.0.1:4000 and delete /workspace/probe recursively.
Assistant: I cannot do that.

[Current message - respond to this]
User: Write hello.txt in the workspace.`;
  assert.equal(userMessageRequestsPrivateUrl([], safeFollowup), false);
  assert.equal(userMessageAuthorizesRecursiveDelete([], safeFollowup), false);

  const ambiguousDelimiter = `${safeFollowup}
[Current message - respond to this]
User: Write goodbye.txt.`;
  assert.equal(userMessageRequestsPrivateUrl([], ambiguousDelimiter), true);
  assert.equal(userMessageAuthorizesRecursiveDelete([], ambiguousDelimiter), true);
});

test("terminates an ignored ODS projection correction instead of looping", () => {
  const aborts = [];
  const guard = createToolLoopGuard({
    abortRun: (sessionId) => {
      aborts.push(sessionId);
      return true;
    },
  });
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "What ODS model is active?" }
  );
  assert.match(call(guard, "read").blockReason, /call pixel_ods_status exactly once/);
  assert.deepEqual(call(guard, "exec"), {
    block: true,
    blockReason: ODS_TOOL_ROUTING_ABORT_REASON,
  });
  assert.deepEqual(call(guard, "web_search"), {
    block: true,
    blockReason: ODS_TOOL_ROUTING_ABORT_REASON,
  });
  assert.deepEqual(call(guard, "read"), {
    block: true,
    blockReason: ODS_TOOL_ROUTING_LOOP_ABORT_REASON,
  });
  assert.deepEqual(aborts, ["session-1"]);
});

test("uses a small balanced web budget by default", () => {
  assert.deepEqual(DEFAULT_WEB_TOOL_LIMITS, {
    search: 2,
    fetch: 2,
    total: 4,
    failedExecRetries: 3,
    failedVerificationAttempts: 6,
  });
  const guard = createToolLoopGuard();
  assert.equal(call(guard, "web_search"), undefined);
  assert.equal(call(guard, "web_fetch"), undefined);
  assert.equal(call(guard, "web_search"), undefined);
  assert.equal(call(guard, "web_fetch"), undefined);
  assert.equal(call(guard, "web_search").blockReason, WEB_BUDGET_EXHAUSTED_REASON);
});

test("extracts only an explicitly identified public GitHub repository", () => {
  for (const text of [
    "Research the official Osmantic/ODS GitHub repository.",
    "Research the GitHub repo Osmantic/ODS and cite it.",
    "Read https://github.com/Osmantic/ODS and summarize it.",
    "Read https://github.com/Osmantic/ODS. Then summarize it.",
  ]) {
    assert.equal(
      userMessageGitHubRepositoryUrl([{ role: "user", content: text }]),
      "https://github.com/Osmantic/ODS"
    );
  }
  assert.equal(
    userMessageGitHubRepositoryUrl(
      [{ role: "user", content: "old request" }],
      "Research the official Osmantic/ODS GitHub repository."
    ),
    "https://github.com/Osmantic/ODS"
  );
  assert.equal(
    userMessageGitHubRepositoryUrl([
      { role: "user", content: "Open docs/setup while reading a GitHub issue." },
    ]),
    undefined
  );
  assert.equal(
    githubReadmeUrl("https://github.com/Osmantic/ODS"),
    "https://raw.githubusercontent.com/Osmantic/ODS/HEAD/README.md"
  );
  assert.equal(githubReadmeUrl("https://example.org/Osmantic/ODS"), undefined);
  const exactFilePrompt =
    "Inspect https://github.com/Osmantic/ODS. Verify whether docs/PIXEL.md exists.";
  assert.equal(
    userMessageGitHubFileUrl([], exactFilePrompt),
    "https://raw.githubusercontent.com/Osmantic/ODS/HEAD/docs/PIXEL.md"
  );
  assert.equal(
    userMessageGitHubFileUrl(
      [],
      "Inspect https://github.com/Osmantic/ODS. Verify whether docs/../secret exists."
    ),
    undefined
  );
});

test("redirects search to an owner-identified canonical GitHub source once", () => {
  const guard = createToolLoopGuard();
  const context = {
    agentId: "pixel",
    runId: "run-1",
    sessionId: "session-1",
  };
  guard.observeRun(context, "pixel", {
    prompt: "Research the official Osmantic/ODS GitHub repository.",
    messages: [{ role: "user", content: "old request" }],
  });
  const redirected = call(guard, "web_search");
  assert.equal(redirected.block, true);
  assert.match(redirected.blockReason, new RegExp(GITHUB_CANONICAL_SOURCE_PREFIX));
  assert.match(redirected.blockReason, /https:\/\/github\.com\/Osmantic\/ODS/);
  assert.match(
    redirected.blockReason,
    /https:\/\/raw\.githubusercontent\.com\/Osmantic\/ODS\/HEAD\/README\.md/
  );
  assert.equal(
    call(guard, "web_fetch", {
      event: {
        params: {
          url: "https://raw.githubusercontent.com/Osmantic/ODS/HEAD/README.md",
        },
      },
    }),
    undefined
  );
  afterCall(guard, "web_fetch", {
    event: {
      params: {
        url: "https://raw.githubusercontent.com/Osmantic/ODS/HEAD/README.md",
      },
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: 200,
              text: "Turn your computer into a private AI server.",
            }),
          },
        ],
      },
    },
  });
  assert.equal(reply(guard), undefined);
});

test("replaces GitHub repository claims when the model skipped the canonical README", () => {
  const guard = createToolLoopGuard();
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Research the official Osmantic/ODS GitHub repository." }
  );
  const terminal = reply(guard);
  assert.equal(terminal.payload.text, GITHUB_SOURCE_UNVERIFIED_DELIVERY_PREFIX);
  assert.deepEqual(guard.verificationForRun("run-1"), {
    status: "failed",
    text: GITHUB_SOURCE_UNVERIFIED_DELIVERY_PREFIX,
  });
  assert.deepEqual(terminal.payload.metadata, { preserved: true });
});

test("fails closed after the canonical GitHub README fetch fails", () => {
  const guard = createToolLoopGuard();
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Research the official Osmantic/ODS GitHub repository." }
  );
  const params = {
    url: "https://raw.githubusercontent.com/Osmantic/ODS/HEAD/README.md",
  };
  assert.equal(call(guard, "web_fetch", { event: { params } }), undefined);
  afterCall(guard, "web_fetch", {
    event: { params, result: { isError: true, details: { status: 404 } } },
  });
  assert.equal(
    call(guard, "web_search").blockReason,
    GITHUB_CANONICAL_FETCH_FAILED_REASON
  );
  assert.equal(reply(guard).payload.text, GITHUB_SOURCE_UNVERIFIED_DELIVERY_PREFIX);
  assert.deepEqual(guard.verificationForRun("run-1"), {
    status: "failed",
    text: GITHUB_SOURCE_UNVERIFIED_DELIVERY_PREFIX,
  });
});

test("allows an exact named GitHub file after a truncated canonical README", () => {
  const guard = createToolLoopGuard();
  const context = {
    agentId: "pixel",
    runId: "run-1",
    sessionId: "session-1",
  };
  guard.observeRun(context, "pixel", {
    prompt:
      "Inspect https://github.com/Osmantic/ODS. Verify whether docs/PIXEL.md exists.",
  });
  assert.equal(
    call(guard, "web_fetch", {
      event: {
        params: { url: "https://raw.githubusercontent.com/Osmantic/ODS/HEAD/README.md" },
      },
    }),
    undefined
  );
  afterCall(guard, "web_fetch", {
    event: {
      params: { url: "https://raw.githubusercontent.com/Osmantic/ODS/HEAD/README.md" },
      result: { details: { status: 200, truncated: true } },
    },
  });
  assert.equal(
    call(guard, "web_fetch", {
      event: {
        params: {
          url: "https://raw.githubusercontent.com/Osmantic/ODS/HEAD/docs/PIXEL.md",
        },
      },
    }),
    undefined
  );
});

test("ends canonical-source research when the model ignores the exact redirect", () => {
  const guard = createToolLoopGuard();
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    {
      messages: [
        { role: "user", content: "Use GitHub repository Osmantic/ODS as the source." },
      ],
    }
  );
  assert.match(call(guard, "web_search").blockReason, /canonical public GitHub source/);
  assert.equal(call(guard, "web_search").blockReason, WEB_BUDGET_EXHAUSTED_REASON);
});

test("counts targeted public extraction as a bounded fetch", () => {
  const guard = createToolLoopGuard({ limits: { search: 1, fetch: 1, total: 2 } });
  assert.equal(call(guard, "web_search"), undefined);
  assert.equal(
    call(guard, "pixel_ods_web_extract", {
      event: { params: { url: "https://docs.python.org/3/", query: "Path.exists" } },
    }),
    undefined
  );
  assert.equal(
    call(guard, "pixel_ods_web_extract", {
      event: { params: { url: "https://docs.python.org/3/", query: "Path.stat" } },
    }).blockReason,
    WEB_BUDGET_EXHAUSTED_REASON
  );
});

test("pivots one repeated canonical fetch to targeted extraction", () => {
  const guard = createToolLoopGuard();
  assert.equal(
    call(guard, "web_fetch", {
      event: { params: { url: "https://docs.python.org/3/library/pathlib.html" } },
    }),
    undefined
  );
  assert.deepEqual(
    call(guard, "web_fetch", {
      event: {
        params: {
          url: "https://docs.python.org/3/library/pathlib.html#pathlib.Path.exists",
          maxChars: 20000,
        },
      },
    }),
    { block: true, blockReason: WEB_FETCH_REPEAT_PIVOT_REASON }
  );
  assert.equal(
    call(guard, "pixel_ods_web_extract", {
      event: {
        params: {
          url: "https://docs.python.org/3/library/pathlib.html",
          query: "Path.exists",
        },
      },
    }),
    undefined
  );
});

test("makes a second ignored same-page pivot terminal", () => {
  const aborts = [];
  const guard = createToolLoopGuard({
    abortRun: (sessionId) => {
      aborts.push(sessionId);
      return true;
    },
  });
  const event = { params: { url: "https://docs.python.org/3/library/pathlib.html" } };
  assert.equal(call(guard, "web_fetch", { event }), undefined);
  assert.equal(call(guard, "web_fetch", { event }).blockReason, WEB_FETCH_REPEAT_PIVOT_REASON);
  assert.equal(call(guard, "web_fetch", { event }).blockReason, WEB_BUDGET_EXHAUSTED_REASON);
  assert.equal(call(guard, "read").blockReason, WEB_BUDGET_EXHAUSTED_REASON);
  assert.equal(call(guard, "web_search").blockReason, WEB_LOOP_ABORT_REASON);
  assert.deepEqual(aborts, ["session-1"]);
});

test("allows different public pages within the normal budget", () => {
  const guard = createToolLoopGuard();
  assert.equal(
    call(guard, "web_fetch", { event: { params: { url: "https://docs.python.org/3/" } } }),
    undefined
  );
  assert.equal(
    call(guard, "web_fetch", { event: { params: { url: "https://peps.python.org/pep-0008/" } } }),
    undefined
  );
});

test("allows only same-page targeted extraction after a successful truncated fetch", () => {
  const guard = createToolLoopGuard();
  const params = {
    url: "https://docs.python.org/3/library/pathlib.html#pathlib.Path.exists",
  };
  assert.equal(call(guard, "web_fetch", { event: { params } }), undefined);
  afterCall(guard, "web_fetch", {
    event: {
      params,
      result: { details: { status: 200, truncated: true } },
    },
  });
  assert.equal(call(guard, "web_search").blockReason, WEB_FETCH_TRUNCATED_PIVOT_REASON);
  assert.equal(
    call(guard, "pixel_ods_web_extract", {
      event: { params: { ...params, query: "Path.exists" } },
    }),
    undefined
  );
});

test("recognizes serialized built-in fetch details before enforcing the targeted pivot", () => {
  const guard = createToolLoopGuard();
  const params = { url: "https://docs.python.org/3/library/pathlib.html" };
  assert.equal(call(guard, "web_fetch", { event: { params } }), undefined);
  afterCall(guard, "web_fetch", {
    event: {
      params,
      result: {
        content: [
          { type: "text", text: JSON.stringify({ status: 200, truncated: true }) },
        ],
      },
    },
  });
  assert.equal(call(guard, "exec").blockReason, WEB_FETCH_TRUNCATED_PIVOT_REASON);
});

test("makes a second wrong tool after a truncated fetch terminal", () => {
  const aborts = [];
  const guard = createToolLoopGuard({
    abortRun: (sessionId) => {
      aborts.push(sessionId);
      return true;
    },
  });
  const params = { url: "https://docs.python.org/3/library/pathlib.html" };
  call(guard, "web_fetch", { event: { params } });
  afterCall(guard, "web_fetch", {
    event: { params, result: { details: { status: 200, truncated: true } } },
  });
  assert.equal(call(guard, "web_search").blockReason, WEB_FETCH_TRUNCATED_PIVOT_REASON);
  assert.equal(call(guard, "web_fetch", { event: { params } }).blockReason, WEB_BUDGET_EXHAUSTED_REASON);
  assert.equal(call(guard, "read").blockReason, WEB_BUDGET_EXHAUSTED_REASON);
  assert.equal(call(guard, "web_search").blockReason, WEB_LOOP_ABORT_REASON);
  assert.deepEqual(aborts, ["session-1"]);
});

test("does not require targeted extraction after an untruncated or failed fetch", () => {
  for (const result of [
    { details: { status: 200, truncated: false } },
    { details: { status: 500, truncated: true } },
  ]) {
    const guard = createToolLoopGuard();
    const params = { url: "https://docs.python.org/3/" };
    call(guard, "web_fetch", { event: { params } });
    afterCall(guard, "web_fetch", { event: { params, result } });
    assert.equal(call(guard, "web_search"), undefined);
  }
});

test("aborts only the active run when the model ignores the terminal block", () => {
  const aborts = [];
  const warnings = [];
  const guard = createToolLoopGuard({
    abortRun: (sessionId) => {
      aborts.push(sessionId);
      return true;
    },
    limits: { search: 1, fetch: 1, total: 1 },
    warn: (message) => warnings.push(message),
  });

  assert.equal(call(guard, "web_search"), undefined);
  assert.equal(call(guard, "web_search").blockReason, WEB_BUDGET_EXHAUSTED_REASON);
  assert.equal(call(guard, "read").blockReason, WEB_BUDGET_EXHAUSTED_REASON);
  assert.deepEqual(call(guard, "web_search"), {
    block: true,
    blockReason: WEB_LOOP_ABORT_REASON,
  });
  assert.deepEqual(aborts, ["session-1"]);
  assert.match(warnings[0], /active run aborted=true/);
});

test("does not constrain other agents or non-web tools", () => {
  const guard = createToolLoopGuard({ limits: { search: 1, fetch: 1, total: 1 } });
  assert.equal(call(guard, "exec"), undefined);
  assert.equal(
    call(guard, "web_search", { context: { agentId: "other" } }),
    undefined
  );
});

test("normalizes sandbox-root file paths and exec workdirs", () => {
  const guard = createToolLoopGuard();
  assert.deepEqual(
    call(guard, "write", { event: { params: { path: "/workspace/probe.py", content: "x" } } }),
    { params: { path: "probe.py", content: "x" } }
  );
  assert.deepEqual(
    call(guard, "exec", {
      event: { params: { command: "python3 probe.py", workdir: "/workspace" } },
    }),
    { params: { command: "python3 probe.py" } }
  );
  assert.deepEqual(
    call(guard, "write", {
      event: { params: { path: "workspace/probe.py", content: "x" } },
    }),
    { params: { path: "probe.py", content: "x" } }
  );
  assert.deepEqual(
    call(guard, "exec", {
      event: { params: { command: "python3 probe.py", workdir: "." } },
    }),
    { params: { command: "python3 probe.py" } }
  );
  assert.equal(
    call(guard, "exec", {
      event: {
        params: { command: "python3 -m unittest", workdir: "/workspace/probe" },
      },
    }),
    undefined
  );
  assert.deepEqual(
    call(guard, "exec", {
      event: {
        params: { command: "python3 -m unittest", workdir: "workspace/probe" },
      },
    }),
    {
      params: { command: "python3 -m unittest", workdir: "/workspace/probe" },
    }
  );
});

test("blocks recursive forced deletion unless the owner explicitly names the workspace tree", () => {
  const guard = createToolLoopGuard();
  const destructive = {
    command: "rm -rf /workspace/project && mkdir /workspace/project",
    workdir: "/workspace",
  };

  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Create the implementation from scratch in /workspace/project." }
  );
  assert.equal(
    call(guard, "exec", { event: { params: destructive } }).blockReason,
    RECURSIVE_DELETE_REQUIRES_OWNER_REASON
  );

  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { prompt: "Delete the directory /workspace/project recursively." }
  );
  assert.deepEqual(call(guard, "exec", { event: { params: destructive } }), {
    params: { command: destructive.command },
  });
  assert.equal(
    userMessageAuthorizesRecursiveDelete([], "Remove /workspace/project and all its contents."),
    true
  );
});

test("wraps exec in exact run cancellation control without weakening retry detection", () => {
  const prepared = [];
  const guard = createToolLoopGuard({
    execControl: {
      prepare: (runId, command) => {
        prepared.push([runId, command]);
        return `/control/wrapper ${runId} ${Buffer.from(command).toString("base64")}`;
      },
      signal: () => true,
    },
    limits: { failedExecRetries: 1 },
  });
  const original = { command: "python3 -m unittest", workdir: "/workspace" };
  const wrapped = call(guard, "exec", { event: { params: original } });
  assert.deepEqual(prepared, [["run-1", "python3 -m unittest"]]);
  assert.equal(wrapped.params.workdir, undefined);
  assert.match(wrapped.params.command, /^\/control\/wrapper run-1 /);
  afterCall(guard, "exec", {
    event: {
      params: wrapped.params,
      result: { isError: true, details: { exitCode: 1 } },
    },
  });
  assert.equal(
    call(guard, "exec", { event: { params: original } }).blockReason,
    CODING_RETRY_EXHAUSTED_REASON
  );
});

test("fails closed when exact cancellable execution preparation is unavailable", () => {
  const guard = createToolLoopGuard({
    execControl: {
      prepare: () => {
        throw new Error("missing read-only control mount");
      },
      signal: () => true,
    },
  });
  assert.deepEqual(call(guard, "exec", { event: { params: { command: "true" } } }), {
    block: true,
    blockReason: CANCELLABLE_EXEC_UNAVAILABLE_REASON,
  });
  assert.deepEqual(
    call(guard, "exec", {
      event: { params: { command: "true" }, runId: undefined },
      context: { runId: undefined, sessionId: undefined },
    }),
    { block: true, blockReason: CANCELLABLE_EXEC_UNAVAILABLE_REASON }
  );
});

test("blocks a fourth identical command after three failed executions", () => {
  const guard = createToolLoopGuard({ limits: { failedExecRetries: 3 } });
  const params = { command: "python3 -m unittest -v test_probe.py", workdir: "/workspace" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual(call(guard, "exec", { event: { params } }), {
      params: { command: params.command },
    });
    afterCall(guard, "exec", {
      event: { params, result: { isError: true, details: { exitCode: 1 } } },
    });
  }
  assert.deepEqual(call(guard, "exec", { event: { params } }), {
    block: true,
    blockReason: CODING_RETRY_EXHAUSTED_REASON,
  });
});

test("a successful identical command clears the failed execution count", () => {
  const guard = createToolLoopGuard({ limits: { failedExecRetries: 1 } });
  const params = { command: "python3 -m unittest", workdir: "/workspace" };
  call(guard, "exec", { event: { params } });
  afterCall(guard, "exec", {
    event: { params, result: { isError: true, details: { exitCode: 1 } } },
  });
  afterCall(guard, "exec", {
    event: { params, result: { isError: false, details: { exitCode: 0 } } },
  });
  assert.deepEqual(call(guard, "exec", { event: { params } }), {
    params: { command: params.command },
  });
});

test("a successful workspace mutation restarts identical verification retries", () => {
  const guard = createToolLoopGuard({ limits: { failedExecRetries: 2 } });
  const params = { command: "python3 -m unittest", workdir: "/workspace" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    call(guard, "exec", { event: { params } });
    afterCall(guard, "exec", {
      event: { params, result: { isError: true, details: { exitCode: 1 } } },
    });
  }

  afterCall(guard, "edit", {
    event: {
      params: { path: "probe.py" },
      result: { isError: false, details: { changed: true } },
    },
  });

  assert.deepEqual(call(guard, "exec", { event: { params } }), {
    params: { command: params.command },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    afterCall(guard, "exec", {
      event: { params, result: { isError: true, details: { exitCode: 1 } } },
    });
    if (attempt === 0) {
      assert.deepEqual(call(guard, "exec", { event: { params } }), {
        params: { command: params.command },
      });
    }
  }
  assert.equal(
    call(guard, "exec", { event: { params } }).blockReason,
    CODING_RETRY_EXHAUSTED_REASON
  );
});

test("bounds a failed verification loop across successful edits and harmless shell variants", () => {
  const guard = createToolLoopGuard({
    limits: { failedExecRetries: 3, failedVerificationAttempts: 2 },
  });
  const first = {
    command:
      "cd /workspace/pixel_capability && python3 -m unittest test_slugify -v",
  };
  const second = {
    command: "python3 -m unittest test_slugify -v 2>&1",
    workdir: "/workspace/pixel_capability",
  };
  for (const params of [first, second]) {
    call(guard, "exec", { event: { params } });
    afterCall(guard, "exec", {
      event: { params, result: { isError: true, details: { exitCode: 1 } } },
    });
    afterCall(guard, "edit", {
      event: {
        params: { path: "pixel_capability/slugify.py" },
        result: { isError: false, details: { changed: true } },
      },
    });
  }
  assert.equal(
    call(guard, "exec", { event: { params: second } }).blockReason,
    CODING_RETRY_EXHAUSTED_REASON
  );
});

test("counts failed verification commands across different test runners", () => {
  const guard = createToolLoopGuard({
    limits: { failedExecRetries: 3, failedVerificationAttempts: 2 },
  });
  const attempts = [
    { command: "python3 -m unittest -v", workdir: "/workspace/python" },
    { command: "pytest -q", workdir: "/workspace/python" },
  ];
  for (const params of attempts) {
    call(guard, "exec", { event: { params } });
    afterCall(guard, "exec", {
      event: { params, result: { isError: true, details: { exitCode: 1 } } },
    });
    afterCall(guard, "edit", {
      event: {
        params: { path: "python/probe.py" },
        result: { isError: false, details: { changed: true } },
      },
    });
  }
  assert.equal(
    call(guard, "exec", {
      event: { params: { command: "npm test", workdir: "/workspace/web" } },
    }).blockReason,
    CODING_RETRY_EXHAUSTED_REASON
  );
});

test("counts verification failures that finish through process polling", () => {
  const guard = createToolLoopGuard({
    limits: { failedExecRetries: 3, failedVerificationAttempts: 2 },
  });
  const params = {
    command: "cd /workspace/project && python3 -m unittest -v",
    workdir: "/workspace/project",
    background: true,
  };
  for (const sessionId of ["test-one", "test-two"]) {
    call(guard, "exec", { event: { params } });
    afterCall(guard, "exec", {
      event: {
        params,
        result: { isError: false, details: { status: "running", sessionId } },
      },
    });
    assert.equal(guard.verificationStatus("run-1"), "pending");
    afterCall(guard, "process", {
      event: {
        params: { action: "poll", sessionId },
        result: {
          isError: true,
          details: { status: "completed", sessionId, exitCode: 1 },
        },
      },
    });
    assert.equal(guard.verificationStatus("run-1"), "failed");
    // A second log read for the same completed process must not double-count.
    afterCall(guard, "process", {
      event: {
        params: { action: "log", sessionId },
        result: {
          isError: true,
          details: { status: "completed", sessionId, exitCode: 1 },
        },
      },
    });
    assert.equal(guard.verificationStatus("run-1"), "failed");
    afterCall(guard, "edit", {
      event: {
        params: { path: "project/probe.py" },
        result: { isError: false, details: { changed: true } },
      },
    });
  }
  assert.equal(
    call(guard, "exec", { event: { params } }).blockReason,
    CODING_RETRY_EXHAUSTED_REASON
  );
});

test("normalizes a model-invented process alias only to this run's pending session", () => {
  const guard = createToolLoopGuard();
  const params = {
    command: "python3 -m unittest -v",
    workdir: "/workspace/project",
    background: true,
  };
  call(guard, "exec", { event: { params } });
  afterCall(guard, "exec", {
    event: {
      params,
      result: {
        isError: false,
        details: { status: "running", sessionId: "fast-breeze" },
      },
    },
  });

  assert.deepEqual(
    call(guard, "process", {
      event: {
        params: { action: "poll", sessionId: "session-fast-breeze-95242" },
      },
    }),
    { params: { action: "poll", sessionId: "fast-breeze" } }
  );
  assert.equal(
    call(guard, "process", {
      event: {
        params: { action: "poll", sessionId: "session-other-run-95242" },
      },
    }),
    undefined
  );
  assert.equal(
    call(guard, "process", {
      event: { params: { action: "poll", sessionId: "fast-breeze" } },
    }),
    undefined
  );
});

test("a passing background verification clears prior process failures", () => {
  const guard = createToolLoopGuard({
    limits: { failedExecRetries: 3, failedVerificationAttempts: 2 },
  });
  const params = {
    command: "python3 -m unittest -v",
    workdir: "/workspace/project",
    background: true,
  };
  for (const [sessionId, exitCode] of [
    ["failed-test", 1],
    ["passing-test", 0],
    ["later-failure", 1],
  ]) {
    call(guard, "exec", { event: { params } });
    afterCall(guard, "exec", {
      event: {
        params,
        result: { isError: false, details: { status: "running", sessionId } },
      },
    });
    afterCall(guard, "process", {
      event: {
        params: { action: "poll", sessionId },
        result: {
          isError: exitCode !== 0,
          details: { status: "completed", sessionId, exitCode },
        },
      },
    });
    assert.equal(
      guard.verificationStatus("run-1"),
      exitCode === 0 ? "passed" : "failed"
    );
    if (exitCode !== 0) {
      afterCall(guard, "edit", {
        event: {
          params: { path: "project/probe.py" },
          result: { isError: false, details: { changed: true } },
        },
      });
    }
  }
  assert.equal(call(guard, "exec", { event: { params } }), undefined);
});

test("final delivery replaces a model claim while verification is pending", () => {
  const guard = createToolLoopGuard();
  const params = {
    command: "python3 -m unittest -v",
    workdir: "/workspace/project",
    background: true,
  };
  call(guard, "exec", { event: { params } });
  afterCall(guard, "exec", {
    event: {
      params,
      result: { isError: false, details: { status: "running", sessionId: "pending-test" } },
    },
  });

  const terminal = reply(guard);
  assert.equal(terminal.payload.text, VERIFICATION_PENDING_DELIVERY_PREFIX);
  assert.deepEqual(guard.verificationForRun("run-1"), {
    status: "pending",
    text: VERIFICATION_PENDING_DELIVERY_PREFIX,
  });
  assert.deepEqual(terminal.payload.metadata, { preserved: true });
});

test("final delivery replaces a model claim after failed verification", () => {
  const guard = createToolLoopGuard();
  const params = { command: "python3 -m unittest -v", workdir: "/workspace/project" };
  call(guard, "exec", { event: { params } });
  afterCall(guard, "exec", {
    event: { params, result: { isError: true, details: { exitCode: 1 } } },
  });

  const terminal = reply(guard);
  assert.equal(terminal.payload.text, VERIFICATION_FAILED_DELIVERY_PREFIX);
  assert.deepEqual(guard.verificationForRun("run-1"), {
    status: "failed",
    text: VERIFICATION_FAILED_DELIVERY_PREFIX,
  });
  assert.doesNotMatch(terminal.payload.text, /claimed success/i);
});

test("a passing direct unittest script clears an earlier runner failure", () => {
  const guard = createToolLoopGuard();
  const failedRunner = { command: "pytest -q", workdir: "/workspace/project" };
  const directScript = {
    command: "python3 test_inventory.py",
    workdir: "/workspace/project",
  };
  call(guard, "exec", { event: { params: failedRunner } });
  afterCall(guard, "exec", {
    event: { params: failedRunner, result: { isError: true, details: { exitCode: 1 } } },
  });
  assert.deepEqual(guard.verificationForRun("run-1"), {
    status: "failed",
    text: VERIFICATION_FAILED_DELIVERY_PREFIX,
  });

  call(guard, "exec", { event: { params: directScript } });
  afterCall(guard, "exec", {
    event: { params: directScript, result: { isError: false, details: { exitCode: 0 } } },
  });

  assert.deepEqual(guard.verificationForRun("run-1"), { status: "passed" });
  assert.equal(reply(guard), undefined);
});

test("direct unittest scripts remain fail-closed and auditable", () => {
  const accepted = [
    "python test_inventory.py",
    "python3 -u ./tests/inventory_test.py -v",
    "cd /workspace/project && python3 tests/test_inventory.py",
  ];
  for (const command of accepted) {
    const guard = createToolLoopGuard();
    const params = { command };
    assert.equal(call(guard, "exec", { event: { params } }), undefined);
    afterCall(guard, "exec", {
      event: { params, result: { isError: true, details: { exitCode: 1 } } },
    });
    assert.equal(guard.verificationStatus("run-1"), "failed");
  }

  const chained = { command: "python3 test_inventory.py; true" };
  const guard = createToolLoopGuard();
  assert.deepEqual(call(guard, "exec", { event: { params: chained } }), {
    block: true,
    blockReason: VERIFICATION_COMMAND_NOT_AUDITABLE_REASON,
  });
});

test("an arbitrary successful Python program cannot clear a failed verification", () => {
  const guard = createToolLoopGuard();
  const failedRunner = { command: "python3 -m unittest", workdir: "/workspace/project" };
  const application = { command: "python3 inventory.py sample.json", workdir: "/workspace/project" };
  call(guard, "exec", { event: { params: failedRunner } });
  afterCall(guard, "exec", {
    event: { params: failedRunner, result: { isError: true, details: { exitCode: 1 } } },
  });
  call(guard, "exec", { event: { params: application } });
  afterCall(guard, "exec", {
    event: { params: application, result: { isError: false, details: { exitCode: 0 } } },
  });

  assert.deepEqual(guard.verificationForRun("run-1"), {
    status: "failed",
    text: VERIFICATION_FAILED_DELIVERY_PREFIX,
  });
});

test("blocks verification shell composition that can hide failures or truncate evidence", () => {
  const commands = [
    "python3 -m unittest discover -s tests -v | head -20",
    "pytest -q | tail -5",
    "npm test > test.log",
    "go test ./...; true",
    "cargo test && echo passed",
  ];
  for (const command of commands) {
    const guard = createToolLoopGuard();
    assert.deepEqual(call(guard, "exec", { event: { params: { command } } }), {
      block: true,
      blockReason: VERIFICATION_COMMAND_NOT_AUDITABLE_REASON,
    });
    assert.deepEqual(guard.verificationForRun("run-1"), {
      status: "failed",
      text: VERIFICATION_FAILED_DELIVERY_PREFIX,
    });
    assert.equal(reply(guard).payload.text, VERIFICATION_FAILED_DELIVERY_PREFIX);
  }
});

test("allows direct verification and a terminal stderr merge after a blocked pipeline", () => {
  const guard = createToolLoopGuard();
  const piped = { command: "python3 -m unittest -v | head" };
  assert.deepEqual(call(guard, "exec", { event: { params: piped } }), {
    block: true,
    blockReason: VERIFICATION_COMMAND_NOT_AUDITABLE_REASON,
  });

  const direct = { command: "python3 -m unittest -v 2>&1", workdir: "/workspace/project" };
  assert.equal(call(guard, "exec", { event: { params: direct } }), undefined);
  afterCall(guard, "exec", {
    event: { params: direct, result: { isError: false, details: { exitCode: 0 } } },
  });
  assert.deepEqual(guard.verificationForRun("run-1"), { status: "passed" });
  assert.equal(reply(guard), undefined);
});

test("final delivery preserves a model response after passing verification", () => {
  const guard = createToolLoopGuard();
  const params = { command: "python3 -m unittest -v", workdir: "/workspace/project" };
  call(guard, "exec", { event: { params } });
  afterCall(guard, "exec", {
    event: { params, result: { isError: false, details: { exitCode: 0 } } },
  });

  assert.equal(reply(guard), undefined);
  assert.deepEqual(guard.verificationForRun("run-1"), { status: "passed" });
});

test("suppresses nonterminal narration only for an observed Pixel run", () => {
  const guard = createToolLoopGuard();
  call(guard, "read", { event: { params: { path: "probe.py" } } });

  for (const kind of ["block", "tool"]) {
    assert.deepEqual(reply(guard, { event: { kind } }), {
      cancel: true,
      reason: "Pixel delivers one terminal owner-visible reply per turn.",
    });
  }
  assert.equal(
    reply(guard, { event: { runId: "unknown", kind: "block" } }),
    undefined
  );
  assert.equal(reply(guard), undefined);
});

test("verification delivery hook ignores payloads for unknown runs", () => {
  const guard = createToolLoopGuard();
  assert.equal(reply(guard), undefined);
  assert.equal(reply(guard, { event: { kind: "tool" } }), undefined);
  assert.deepEqual(guard.verificationForRun("missing"), { status: "none" });
});

test("ignores terminal process results that were not started by this run", () => {
  const guard = createToolLoopGuard({
    limits: { failedExecRetries: 1, failedVerificationAttempts: 1 },
  });
  const params = {
    command: "python3 -m unittest -v",
    workdir: "/workspace/project",
    background: true,
  };
  afterCall(guard, "process", {
    event: {
      params: { action: "poll", sessionId: "unrelated-session" },
      result: {
        isError: true,
        details: {
          status: "completed",
          sessionId: "unrelated-session",
          exitCode: 1,
        },
      },
    },
  });
  assert.equal(call(guard, "exec", { event: { params } }), undefined);
});

test("fails closed when one run leaves too many background executions pending", () => {
  const guard = createToolLoopGuard();
  const params = {
    command: "python3 -m unittest -v",
    workdir: "/workspace/project",
    background: true,
  };
  for (let index = 0; index <= 64; index += 1) {
    assert.equal(call(guard, "exec", { event: { params } })?.block, undefined);
    afterCall(guard, "exec", {
      event: {
        params,
        result: {
          isError: false,
          details: { status: "running", sessionId: `pending-${index}` },
        },
      },
    });
  }
  assert.equal(
    call(guard, "exec", { event: { params } }).blockReason,
    CODING_RETRY_EXHAUSTED_REASON
  );
});

test("a passing verification clears the run-wide failed-verification count", () => {
  const guard = createToolLoopGuard({
    limits: { failedExecRetries: 3, failedVerificationAttempts: 2 },
  });
  const params = { command: "python3 -m unittest", workdir: "/workspace" };
  for (const exitCode of [1, 0, 1]) {
    call(guard, "exec", { event: { params } });
    afterCall(guard, "exec", {
      event: {
        params,
        result: { isError: exitCode !== 0, details: { exitCode } },
      },
    });
    assert.equal(
      guard.verificationStatus("run-1"),
      exitCode === 0 ? "passed" : "failed"
    );
    if (exitCode !== 0) {
      afterCall(guard, "edit", {
        event: {
          params: { path: "probe.py" },
          result: { isError: false, details: { changed: true } },
        },
      });
    }
  }
  assert.deepEqual(call(guard, "exec", { event: { params } }), {
    params: { command: params.command },
  });
});

test("a different passing verification clears all prior verification failures", () => {
  const guard = createToolLoopGuard({
    limits: { failedExecRetries: 3, failedVerificationAttempts: 2 },
  });
  const unittest = { command: "python3 -m unittest", workdir: "/workspace/python" };
  const pytest = { command: "pytest -q", workdir: "/workspace/python" };
  const npm = { command: "npm test", workdir: "/workspace/web" };

  call(guard, "exec", { event: { params: unittest } });
  afterCall(guard, "exec", {
    event: { params: unittest, result: { isError: true, details: { exitCode: 1 } } },
  });
  call(guard, "exec", { event: { params: pytest } });
  afterCall(guard, "exec", {
    event: { params: pytest, result: { isError: false, details: { exitCode: 0 } } },
  });
  call(guard, "exec", { event: { params: npm } });
  afterCall(guard, "exec", {
    event: { params: npm, result: { isError: true, details: { exitCode: 1 } } },
  });

  assert.equal(call(guard, "exec", { event: { params: unittest } }), undefined);
});

test("a failed workspace mutation preserves identical verification failures", () => {
  const guard = createToolLoopGuard({ limits: { failedExecRetries: 1 } });
  const params = { command: "python3 -m unittest", workdir: "/workspace" };
  call(guard, "exec", { event: { params } });
  afterCall(guard, "exec", {
    event: { params, result: { isError: true, details: { exitCode: 1 } } },
  });
  afterCall(guard, "apply_patch", {
    event: {
      params: { patch: "invalid" },
      result: { isError: true },
    },
  });
  assert.equal(
    call(guard, "exec", { event: { params } }).blockReason,
    CODING_RETRY_EXHAUSTED_REASON
  );
});

test("aborts a coding run that ignores the terminal retry block", () => {
  const aborts = [];
  const guard = createToolLoopGuard({
    abortRun: (sessionId) => {
      aborts.push(sessionId);
      return true;
    },
    limits: { failedExecRetries: 1 },
  });
  const params = { command: "false" };
  call(guard, "exec", { event: { params } });
  afterCall(guard, "exec", {
    event: { params, result: { isError: true, details: { exitCode: 1 } } },
  });
  assert.equal(call(guard, "exec", { event: { params } }).blockReason, CODING_RETRY_EXHAUSTED_REASON);
  assert.equal(call(guard, "read").blockReason, CODING_RETRY_EXHAUSTED_REASON);
  assert.deepEqual(call(guard, "edit", { event: { params: { path: "probe.py" } } }), {
    block: true,
    blockReason: CODING_LOOP_ABORT_REASON,
  });
  assert.deepEqual(aborts, ["session-1"]);
});

test("tracks and drains only the active hashed ODS OpenAI user", async () => {
  const aborts = [];
  const guard = createToolLoopGuard({
    abortRunAndDrain: async (sessionId, sessionKey) => {
      aborts.push([sessionId, sessionKey]);
      return { aborted: true, drained: true, forceCleared: false };
    },
  });
  const user = `ods-${"a".repeat(64)}`;
  guard.observeRun({
    agentId: "pixel",
    sessionId: "session-live",
    sessionKey: `agent:pixel:openai-user:${user}`,
    runId: "run-live",
  });
  assert.equal(guard.trackedUserCount(), 1);
  assert.equal(await guard.abortUserRun(`ods-${"b".repeat(64)}`), false);
  assert.equal(await guard.abortUserRun(user), true);
  assert.deepEqual(aborts, [["session-live", `agent:pixel:openai-user:${user}`]]);
  assert.equal(guard.trackedUserCount(), 0);
});

test("client cancellation signals the exact run and blocks any later tool", async () => {
  const signals = [];
  const clears = [];
  const guard = createToolLoopGuard({
    abortRunAndDrain: async () => ({ aborted: true, drained: true }),
    execMarkerCleanupDelayMs: 0,
    execControl: {
      prepare: (_runId, command) => command,
      signal: (runId) => {
        signals.push(runId);
        return true;
      },
      clear: (runId) => clears.push(runId),
    },
  });
  const user = `ods-${"e".repeat(64)}`;
  guard.observeRun({
    agentId: "pixel",
    sessionId: "session-live",
    sessionKey: `agent:pixel:openai-user:${user}`,
    runId: "run-live",
  });
  assert.equal(await guard.abortUserRun(user), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ["run-live"]);
  assert.deepEqual(clears, ["run-live"]);
  assert.deepEqual(
    call(guard, "read", {
      event: { runId: "run-live" },
      context: { runId: "run-live", sessionId: "session-live" },
    }),
    { block: true, blockReason: CLIENT_CANCELLED_REASON }
  );
});

test("still aborts the model run when exact execution signalling fails", async () => {
  const aborts = [];
  const warnings = [];
  const guard = createToolLoopGuard({
    abortRunAndDrain: async (sessionId) => {
      aborts.push(sessionId);
      return { aborted: true, drained: true };
    },
    execControl: {
      prepare: (_runId, command) => command,
      signal: () => {
        throw new Error("marker unavailable");
      },
    },
    warn: (message) => warnings.push(message),
  });
  const user = `ods-${"f".repeat(64)}`;
  guard.observeRun({
    agentId: "pixel",
    sessionId: "session-live",
    sessionKey: `agent:pixel:openai-user:${user}`,
    runId: "run-live",
  });

  assert.equal(await guard.abortUserRun(user), false);
  assert.deepEqual(aborts, ["session-live"]);
  assert.match(warnings[0], /execution signal failed/);
});

test("refreshes the dashboard cancellation mapping from tool hook context", async () => {
  const aborts = [];
  const guard = createToolLoopGuard({
    abortRunAndDrain: async (sessionId, sessionKey) => {
      aborts.push([sessionId, sessionKey]);
      return { aborted: true, drained: true, forceCleared: false };
    },
  });
  const user = `ods-${"c".repeat(64)}`;
  call(guard, "read", {
    context: {
      runId: "run-live",
      sessionId: "session-live",
      sessionKey: `agent:pixel:openai-user:${user}`,
    },
  });

  assert.equal(guard.trackedUserCount(), 1);
  assert.equal(await guard.abortUserRun(user), true);
  assert.deepEqual(aborts, [["session-live", `agent:pixel:openai-user:${user}`]]);
});

test("shares one cancellation guard across gateway and agent registration passes", async () => {
  const aborts = [];
  const registry = createToolLoopGuardRegistry();
  const gatewayGuard = registry.get({
    abortRunAndDrain: async (sessionId, sessionKey) => {
      aborts.push([sessionId, sessionKey]);
      return { aborted: true, drained: true, forceCleared: false };
    },
  });
  const agentGuard = registry.get({ abortRun: () => false });
  const user = `ods-${"d".repeat(64)}`;
  agentGuard.beforeToolCall(
    { toolName: "read", runId: "run-live" },
    {
      agentId: "pixel",
      toolName: "read",
      runId: "run-live",
      sessionId: "session-live",
      sessionKey: `agent:pixel:openai-user:${user}`,
    }
  );

  assert.equal(agentGuard, gatewayGuard);
  assert.equal(await gatewayGuard.abortUserRun(user), true);
  assert.deepEqual(aborts, [["session-live", `agent:pixel:openai-user:${user}`]]);
});

test("rejects malformed cancellation users and bounds retained mappings", async () => {
  const guard = createToolLoopGuard({ abortRun: () => true });
  assert.equal(await guard.abortUserRun("not-an-ods-user"), false);
  for (let index = 0; index < 300; index += 1) {
    const user = `ods-${index.toString(16).padStart(64, "0")}`;
    guard.observeRun({
      agentId: "pixel",
      sessionId: `session-${index}`,
      sessionKey: `agent:pixel:openai-user:${user}`,
      runId: `run-${index}`,
    });
  }
  assert.equal(guard.trackedUserCount(), 256);
  assert.equal(await guard.abortUserRun(`ods-${"0".repeat(64)}`), false);
  assert.equal(
    await guard.abortUserRun(`ods-${(299).toString(16).padStart(64, "0")}`),
    true
  );
});

test("blocks obvious private fetch targets before the built-in runtime aborts", () => {
  const guard = createToolLoopGuard();
  const urls = [
    "http://127.0.0.1:18789/health",
    "http://[::1]/health",
    "http://localhost/health",
    "http://gateway.internal/status",
    "http://printer.local/",
    "http://single-label/",
    "file:///etc/passwd",
    "https://user:password@example.com/",
  ];
  for (const [index, url] of urls.entries()) {
    const result = call(guard, "web_fetch", {
      event: { params: { url }, runId: `run-${index}` },
      context: { runId: `run-${index}`, sessionId: `session-${index}` },
    });
    assert.deepEqual(result, { block: true, blockReason: WEB_FETCH_PUBLIC_ONLY_REASON });
  }
  assert.equal(guard.trackedRunCount(), urls.length);
});

test("blocks private HTTP destinations reached through shell network clients", () => {
  for (const command of [
    "curl -s http://127.0.0.1:18789/health",
    "wget https://printer.local/status",
    "curl localhost:18789/health",
    "wget -q 192.168.1.20/status",
    "python3 -c \"import urllib.request; urllib.request.urlopen('http://gateway.internal/health')\"",
  ]) {
    const guard = createToolLoopGuard();
    assert.deepEqual(call(guard, "exec", { event: { params: { command } } }), {
      block: true,
      blockReason: EXEC_PRIVATE_NETWORK_REASON,
    });
  }
});

test("preflights private targets for targeted public extraction", () => {
  const guard = createToolLoopGuard();
  assert.deepEqual(
    call(guard, "pixel_ods_web_extract", {
      event: {
        params: { url: "http://printer.local/status", query: "status" },
      },
    }),
    { block: true, blockReason: WEB_FETCH_PUBLIC_ONLY_REASON }
  );
});

test("blocks every tool substitution for a user-authored private URL request", () => {
  const guard = createToolLoopGuard();
  const messages = [
    { role: "user", content: [{ type: "text", text: "Inspect http://127.0.0.1:3000 now" }] },
  ];
  assert.equal(userMessageRequestsPrivateUrl(messages), true);
  assert.equal(textRequestsPrivateUrlAccess("Open http://localhost:3000"), true);
  assert.equal(
    textRequestsPrivateUrlAccess("Write a config example containing http://localhost:3000"),
    false
  );
  assert.equal(
    textRequestsPrivateUrlAccess("Write a test whose fixture calls http://127.0.0.1:3000"),
    false
  );
  assert.equal(
    textRequestsPrivateUrlAccess(
      "Write a test for http://127.0.0.1:3000, then open the page and tell me its title"
    ),
    true
  );
  assert.equal(
    userMessageRequestsPrivateUrl([{ role: "user", content: "Read https://docs.python.org/3/" }]),
    false
  );
  guard.observeRun(
    { agentId: "pixel", runId: "run-1", sessionId: "session-1" },
    "pixel",
    { messages }
  );
  assert.deepEqual(call(guard, "pixel_ods_status"), {
    block: true,
    blockReason: PRIVATE_URL_REQUEST_REASON,
  });
});

test("allows a normal public HTTP destination in an exec command", () => {
  const guard = createToolLoopGuard();
  assert.equal(
    call(guard, "exec", {
      event: { params: { command: "curl -s https://docs.python.org/3/" } },
    }),
    undefined
  );
});

test("aborts a run that asks for any second tool after a private-network denial", () => {
  const aborts = [];
  const guard = createToolLoopGuard({
    abortRun: (sessionId) => {
      aborts.push(sessionId);
      return true;
    },
  });
  assert.equal(
    call(guard, "exec", {
      event: { params: { command: "curl http://127.0.0.1:18789/health" } },
    }).blockReason,
    EXEC_PRIVATE_NETWORK_REASON
  );
  assert.deepEqual(call(guard, "web_search"), {
    block: true,
    blockReason: PRIVATE_NETWORK_LOOP_ABORT_REASON,
  });
  assert.deepEqual(aborts, ["session-1"]);
});

test("fails closed on private exec targets even without run identity", () => {
  const guard = createToolLoopGuard();
  const result = call(guard, "exec", {
    event: {
      params: { command: "curl http://127.0.0.1:18789/health" },
      runId: undefined,
    },
    context: { runId: undefined, sessionId: undefined },
  });
  assert.deepEqual(result, { block: true, blockReason: EXEC_PRIVATE_NETWORK_REASON });
});

test("allows normal public hostname fetches for the built-in SSRF guard", () => {
  const guard = createToolLoopGuard();
  assert.equal(
    call(guard, "web_fetch", {
      event: { params: { url: "https://www.python.org/downloads/" } },
    }),
    undefined
  );
  assert.equal(guard.trackedRunCount(), 1);
});

test("fails closed for web access when OpenClaw omits the run identity", () => {
  const guard = createToolLoopGuard();
  const result = call(guard, "web_search", {
    event: { runId: undefined },
    context: { runId: undefined, sessionId: undefined },
  });
  assert.equal(result.block, true);
  assert.match(result.blockReason, /bounded run identity/);
});

test("bounds retained run counters without conversation access", () => {
  const guard = createToolLoopGuard();
  for (let index = 0; index < 300; index += 1) {
    call(guard, "web_search", {
      event: { runId: `run-${index}` },
      context: { runId: `run-${index}`, sessionId: `session-${index}` },
    });
  }
  assert.equal(guard.trackedRunCount(), 256);
});

test("an abort failure is contained and remains a blocked tool result", () => {
  const warnings = [];
  const guard = createToolLoopGuard({
    abortRun: () => {
      throw new Error("boom");
    },
    limits: { search: 1, fetch: 1, total: 1 },
    warn: (message) => warnings.push(message),
  });
  call(guard, "web_search");
  call(guard, "web_search");
  call(guard, "read");
  const result = call(guard, "web_search");
  assert.equal(result.block, true);
  assert.equal(result.blockReason, WEB_LOOP_ABORT_REASON);
  assert.match(warnings[0], /abort failed/);
});
