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
  GITHUB_CANONICAL_SOURCE_PREFIX,
  PRIVATE_URL_REQUEST_REASON,
  PRIVATE_NETWORK_LOOP_ABORT_REASON,
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
  userMessageGitHubFileUrl,
  userMessageGitHubRepositoryUrl,
  userMessageRequestsPrivateUrl,
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

test("uses a small balanced web budget by default", () => {
  assert.deepEqual(DEFAULT_WEB_TOOL_LIMITS, {
    search: 2,
    fetch: 2,
    total: 4,
    failedExecRetries: 3,
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
