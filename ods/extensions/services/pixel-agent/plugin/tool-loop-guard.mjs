// Pixel per-run tool-loop guard.
//
// OpenClaw's built-in identical-call detector blocks a repeated tool call, but
// a model can keep asking for the blocked tool on later continuation passes.
// Bound the web-research portion of a Pixel response and give the model one
// blocked result in which to produce a useful final answer. If it ignores that
// terminal instruction and requests another web tool, abort only that active
// agent run through OpenClaw's public harness runtime.

import { isIP } from "node:net";

export const DEFAULT_WEB_TOOL_LIMITS = Object.freeze({
  search: 4,
  fetch: 4,
  total: 6,
  failedExecRetries: 3,
});

export const WEB_BUDGET_EXHAUSTED_REASON =
  "Pixel's web-research budget is exhausted for this response. Do not call any tool again in this turn. Give the user a visible final answer now using the evidence already collected, clearly stating any uncertainty.";

export const WEB_LOOP_ABORT_REASON =
  "Pixel stopped this response because it requested another web tool after the bounded research budget was exhausted. Start a fresh message to continue with a narrower research question.";

export const WEB_FETCH_PUBLIC_ONLY_REASON =
  "Pixel blocked this fetch because web_fetch is restricted to public HTTP(S) hostnames and must not contact local, private, or raw-IP destinations. Do not retry an equivalent URL; explain the boundary to the user.";

export const CODING_RETRY_EXHAUSTED_REASON =
  "Pixel stopped repeating the same failing command after three attempts. Do not call another tool in this turn. Give the user a visible summary of the verified failure, the changes attempted, and the most useful next step.";

export const CODING_LOOP_ABORT_REASON =
  "Pixel stopped this response because it requested another coding tool after the repeated-command limit was reached. Start a fresh message to continue from the preserved workspace with a different approach.";

const WEB_TOOLS = new Set(["web_search", "web_fetch"]);
const CODING_TOOLS = new Set(["exec", "write", "edit", "apply_patch"]);
const FILE_PATH_TOOLS = new Set(["read", "write", "edit"]);
const MAX_TRACKED_RUNS = 256;
const ODS_OPENAI_USER = /^ods-[0-9a-f]{64}$/;

function validLimit(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizedLimits(limits = {}) {
  return {
    search: validLimit(limits.search, DEFAULT_WEB_TOOL_LIMITS.search),
    fetch: validLimit(limits.fetch, DEFAULT_WEB_TOOL_LIMITS.fetch),
    total: validLimit(limits.total, DEFAULT_WEB_TOOL_LIMITS.total),
    failedExecRetries: validLimit(
      limits.failedExecRetries,
      DEFAULT_WEB_TOOL_LIMITS.failedExecRetries
    ),
  };
}

function normalizeWorkspacePath(value) {
  if (value === "/workspace" || value === "workspace") return ".";
  if (typeof value === "string" && value.startsWith("/workspace/")) {
    return value.slice("/workspace/".length);
  }
  if (typeof value === "string" && value.startsWith("workspace/")) {
    return value.slice("workspace/".length);
  }
  return value;
}

function normalizeWorkspaceParams(toolName, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const updated = { ...params };
  let changed = false;
  if (FILE_PATH_TOOLS.has(toolName) && typeof params.path === "string") {
    const path = normalizeWorkspacePath(params.path);
    if (path !== params.path) {
      updated.path = path;
      changed = true;
    }
  }
  if (toolName === "exec" && typeof params.workdir === "string") {
    const workdir = normalizeWorkspacePath(params.workdir);
    if (workdir === ".") {
      delete updated.workdir;
      changed = true;
    } else if (workdir !== params.workdir) {
      updated.workdir = workdir;
      changed = true;
    }
  }
  return changed ? updated : undefined;
}

function execFingerprint(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const command = params.command;
  if (typeof command !== "string" || !command.trim()) return undefined;
  const normalizedWorkdir = normalizeWorkspacePath(params.workdir);
  const workdir = normalizedWorkdir === "." ? "" : normalizedWorkdir;
  return JSON.stringify([command.trim(), typeof workdir === "string" ? workdir : ""]);
}

function execFailed(event) {
  if (typeof event?.error === "string" && event.error) return true;
  const result = event?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  if (result.isError === true) return true;
  const exitCode = result?.details?.exitCode;
  return Number.isInteger(exitCode) && exitCode !== 0;
}

function runIdentity(event, context) {
  const runId = context?.runId ?? event?.runId;
  const sessionId = context?.sessionId;
  return {
    runId: typeof runId === "string" && runId ? runId : undefined,
    sessionId: typeof sessionId === "string" && sessionId ? sessionId : undefined,
  };
}

function fetchTargetsNonPublicAddress(event) {
  const raw = event?.params?.url;
  if (typeof raw !== "string" || !raw) return false;
  try {
    const target = new URL(raw);
    if (!new Set(["http:", "https:"]).has(target.protocol)) return true;
    if (target.username || target.password) return true;
    const hostname = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!hostname || isIP(hostname)) return true;
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      !hostname.includes(".")
    );
  } catch {
    // Let the built-in tool produce its normal validation error for malformed
    // public URLs. This preflight exists only to make obvious private targets
    // a clean, conversational denial before the fetch runtime aborts the run.
    return false;
  }
}

export function createToolLoopGuard({
  abortRun,
  abortRunAndDrain,
  limits,
  warn = () => {},
} = {}) {
  const effective = normalizedLimits(limits);
  // This intentionally stays plugin-local. OpenClaw's runContext write API is
  // disabled for this non-bundled hook path, while its agent_end hook requires
  // broader conversation access. Bound the cache itself instead of requesting
  // that permission merely for cleanup.
  const runs = new Map();
  const activeUsers = new Map();

  function pruneRuns() {
    while (runs.size >= MAX_TRACKED_RUNS) {
      runs.delete(runs.keys().next().value);
    }
  }

  function pruneActiveUsers() {
    while (activeUsers.size >= MAX_TRACKED_RUNS) {
      activeUsers.delete(activeUsers.keys().next().value);
    }
  }

  function stateFor(runId) {
    let state = runs.get(runId);
    if (!state) {
      pruneRuns();
      state = {
        search: 0,
        fetch: 0,
        total: 0,
        webExhausted: false,
        codingExhausted: false,
        failedExec: new Map(),
      };
      runs.set(runId, state);
    }
    return state;
  }

  function beforeToolCall(event, context, agentId = "pixel") {
    if (context?.agentId !== agentId) return undefined;
    const toolName = context?.toolName ?? event?.toolName;
    const normalizedParams = normalizeWorkspaceParams(toolName, event?.params);

    if (toolName === "web_fetch" && fetchTargetsNonPublicAddress(event)) {
      warn("Pixel blocked a non-public web_fetch destination before execution");
      return { block: true, blockReason: WEB_FETCH_PUBLIC_ONLY_REASON };
    }

    const { runId, sessionId } = runIdentity(event, context);
    if (WEB_TOOLS.has(toolName) && (!runId || !sessionId)) {
      return {
        block: true,
        blockReason:
          "Pixel could not establish the bounded run identity required for web access. Do not call another tool in this turn; explain that web research is temporarily unavailable.",
      };
    }

    if (!runId || !sessionId) {
      return normalizedParams ? { params: normalizedParams } : undefined;
    }
    const state = stateFor(runId);

    if (state.webExhausted && WEB_TOOLS.has(toolName)) {
      let aborted = false;
      try {
        aborted = typeof abortRun === "function" && Boolean(abortRun(sessionId));
      } catch (error) {
        warn(`Pixel web-loop abort failed for run ${runId}: ${String(error)}`);
      }
      warn(
        `Pixel stopped a repeated web-tool loop for run ${runId}; active run aborted=${aborted}`
      );
      return { block: true, blockReason: WEB_LOOP_ABORT_REASON };
    }

    if (state.codingExhausted && CODING_TOOLS.has(toolName)) {
      let aborted = false;
      try {
        aborted = typeof abortRun === "function" && Boolean(abortRun(sessionId));
      } catch (error) {
        warn(`Pixel coding-loop abort failed for run ${runId}: ${String(error)}`);
      }
      warn(
        `Pixel stopped a repeated coding-tool loop for run ${runId}; active run aborted=${aborted}`
      );
      return { block: true, blockReason: CODING_LOOP_ABORT_REASON };
    }

    if (toolName === "exec") {
      const fingerprint = execFingerprint(normalizedParams ?? event?.params);
      if (
        fingerprint &&
        (state.failedExec.get(fingerprint) ?? 0) >= effective.failedExecRetries
      ) {
        state.codingExhausted = true;
        return { block: true, blockReason: CODING_RETRY_EXHAUSTED_REASON };
      }
    }

    if (!WEB_TOOLS.has(toolName)) {
      return normalizedParams ? { params: normalizedParams } : undefined;
    }

    const kind = toolName === "web_search" ? "search" : "fetch";
    if (state[kind] >= effective[kind] || state.total >= effective.total) {
      state.webExhausted = true;
      return { block: true, blockReason: WEB_BUDGET_EXHAUSTED_REASON };
    }

    state[kind] += 1;
    state.total += 1;
    return normalizedParams ? { params: normalizedParams } : undefined;
  }

  function observeRun(context, agentId = "pixel") {
    if (context?.agentId !== agentId) return;
    const prefix = `agent:${agentId}:openai-user:`;
    const sessionKey = context?.sessionKey;
    const sessionId = context?.sessionId;
    if (
      typeof sessionKey !== "string" ||
      !sessionKey.startsWith(prefix) ||
      typeof sessionId !== "string" ||
      !sessionId
    ) {
      return;
    }
    const user = sessionKey.slice(prefix.length);
    if (!ODS_OPENAI_USER.test(user)) return;
    // A client can only send this cancellation request while its matching
    // dashboard response is still open. Keep the most recently observed
    // session per opaque user and bound stale completed entries instead of
    // requesting OpenClaw's broad raw-conversation permission for agent_end.
    if (activeUsers.has(user)) activeUsers.delete(user);
    pruneActiveUsers();
    activeUsers.set(user, { sessionId, sessionKey });
  }

  async function abortUserRun(user) {
    if (typeof user !== "string" || !ODS_OPENAI_USER.test(user)) return false;
    const active = activeUsers.get(user);
    if (!active) return false;
    let aborted = false;
    try {
      if (typeof abortRunAndDrain === "function") {
        const result = await abortRunAndDrain(active.sessionId, active.sessionKey);
        aborted = Boolean(result?.aborted ?? result);
      } else {
        aborted = typeof abortRun === "function" && Boolean(abortRun(active.sessionId));
      }
    } catch (error) {
      warn(`Pixel client-cancel abort failed: ${String(error)}`);
    }
    if (aborted) activeUsers.delete(user);
    return aborted;
  }

  function afterToolCall(event, context, agentId = "pixel") {
    if (context?.agentId !== agentId) return;
    const toolName = context?.toolName ?? event?.toolName;
    if (toolName !== "exec") return;
    const runId = context?.runId ?? event?.runId;
    if (typeof runId !== "string" || !runId) return;
    const fingerprint = execFingerprint(event?.params);
    if (!fingerprint) return;
    const state = stateFor(runId);
    if (execFailed(event)) {
      state.failedExec.set(fingerprint, (state.failedExec.get(fingerprint) ?? 0) + 1);
    } else {
      state.failedExec.delete(fingerprint);
    }
  }

  return {
    beforeToolCall,
    afterToolCall,
    observeRun,
    abortUserRun,
    trackedRunCount: () => runs.size,
    trackedUserCount: () => activeUsers.size,
  };
}
