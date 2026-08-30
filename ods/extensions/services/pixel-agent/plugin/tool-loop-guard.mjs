// Pixel per-run tool-loop guard.
//
// OpenClaw's built-in identical-call detector blocks a repeated tool call, but
// a model can keep asking for the blocked tool on later continuation passes.
// Bound the web-research portion of a Pixel response. A duplicate fetch of the
// same canonical page gets one nonterminal pivot to targeted extraction; all
// terminal blocks get one result in which to produce a useful final answer. If
// the model ignores a terminal instruction, abort only that active agent run
// through OpenClaw's public harness runtime.

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isIP } from "node:net";

export const DEFAULT_WEB_TOOL_LIMITS = Object.freeze({
  search: 2,
  fetch: 2,
  total: 4,
  failedExecRetries: 3,
});

export const WEB_BUDGET_EXHAUSTED_REASON =
  "Pixel's web-research budget is exhausted for this response. Do not call any tool again in this turn. Give the user a visible final answer now using the evidence already collected, clearly stating any uncertainty.";

export const WEB_LOOP_ABORT_REASON =
  "Pixel stopped this response because it requested another web tool after the bounded research budget was exhausted. Start a fresh message to continue with a narrower research question.";

export const WEB_FETCH_REPEAT_PIVOT_REASON =
  "Pixel already fetched this public page in this response. Do not repeat web_fetch or narrate a retry. If the needed detail was beyond the returned prefix, call pixel_ods_web_extract now with the same URL and a distinctive literal method or section name; otherwise answer from the evidence already returned.";

export const WEB_FETCH_TRUNCATED_PIVOT_REASON =
  "The fetched public page was truncated. Either answer from evidence already present or make exactly one pixel_ods_web_extract call now using that same page URL and a distinctive literal method or section name. Do not call or narrate any other tool; a different next tool will stop this response.";

export const WEB_FETCH_PUBLIC_ONLY_REASON =
  "Pixel blocked this fetch because web_fetch is restricted to public HTTP(S) hostnames and must not contact local, private, or raw-IP destinations. Do not call another tool in this turn; explain the boundary to the user.";

export const GITHUB_CANONICAL_SOURCE_PREFIX =
  "Pixel already has the owner's identified canonical public GitHub source:";

export const EXEC_PRIVATE_NETWORK_REASON =
  "Pixel blocked this command because shell execution cannot be used to contact local, private, or raw-IP HTTP(S) destinations. Do not call another tool in this turn; explain the boundary to the user.";

export const PRIVATE_NETWORK_LOOP_ABORT_REASON =
  "Pixel stopped this response because it requested another tool after a private-network boundary was enforced. Start a fresh message with a safe public destination or an approved ODS status capability.";

export const PRIVATE_URL_REQUEST_REASON =
  "This request contains a private URL that Pixel cannot open from this chat. Do not call or substitute any tool, including ODS status or shell tools. Reply concisely that the private page was not accessed and ask the user to provide its content or use a separately approved private-access capability.";

export const CODING_RETRY_EXHAUSTED_REASON =
  "Pixel stopped repeating the same failing command after three attempts. Do not call another tool in this turn. Give the user a visible summary of the verified failure, the changes attempted, and the most useful next step.";

export const CODING_LOOP_ABORT_REASON =
  "Pixel stopped this response because it requested another coding tool after the repeated-command limit was reached. Start a fresh message to continue from the preserved workspace with a different approach.";

export const CANCELLABLE_EXEC_UNAVAILABLE_REASON =
  "Pixel could not establish the exact cancellation boundary for this command. Do not call another tool in this turn; explain that execution is temporarily unavailable.";

export const CLIENT_CANCELLED_REASON =
  "The owner cancelled this Pixel response. Do not call another tool or continue the task in this turn.";

const WEB_TOOLS = new Set(["web_search", "web_fetch", "pixel_ods_web_extract"]);
const CODING_TOOLS = new Set(["exec", "write", "edit", "apply_patch"]);
const WORKSPACE_MUTATION_TOOLS = new Set(["write", "edit", "apply_patch"]);
const FILE_PATH_TOOLS = new Set(["read", "write", "edit"]);
const MAX_TRACKED_RUNS = 256;
const ODS_OPENAI_USER = /^ods-[0-9a-f]{64}$/;
const EXEC_CONTROL_WRAPPER = "/run/pixel-ods-control/cancellable-exec.sh";
const ARTIFACT_DRAFT_PREFIX =
  /^\s*(?:please\s+)?(?:write|draft|document|compose|create|edit|update|refactor|implement|generate)\b/i;
const ARTIFACT_NOUN =
  /\b(?:code|config(?:uration)?|documentation|example|file|fixture|readme|script|snippet|test)\b/i;
const FOLLOWUP_PRIVATE_ACCESS =
  /\b(?:and\s+)?then\s+(?:access|browse|call|check|connect|download|fetch|inspect|open|query|read|request|retrieve|summari[sz]e|test|visit)\b/i;

function execMarkerId(runId) {
  if (typeof runId !== "string" || !runId) throw new Error("invalid Pixel run id");
  return createHash("sha256").update(runId, "utf8").digest("hex");
}

export function createExecCancellationControl({
  root = path.join(homedir(), ".openclaw", ".ods-exec-control"),
} = {}) {
  const resolvedRoot = path.resolve(root);

  function assertRoot() {
    const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
    const rootInfo = fs.lstatSync(resolvedRoot);
    const wrapperInfo = fs.lstatSync(path.join(resolvedRoot, "cancellable-exec.sh"));
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      (rootInfo.mode & 0o777) !== 0o700 ||
      (owner !== undefined && rootInfo.uid !== owner) ||
      !wrapperInfo.isFile() ||
      wrapperInfo.isSymbolicLink() ||
      wrapperInfo.nlink !== 1 ||
      (wrapperInfo.mode & 0o777) !== 0o500 ||
      (owner !== undefined && wrapperInfo.uid !== owner)
    ) {
      throw new Error("unsafe Pixel execution control root");
    }
  }

  function markerPath(runId) {
    return path.join(resolvedRoot, `${execMarkerId(runId)}.cancel`);
  }

  return {
    prepare(runId, command) {
      if (typeof command !== "string" || !command.trim() || command.includes("\0")) {
        throw new Error("invalid Pixel exec command");
      }
      assertRoot();
      try {
        fs.unlinkSync(markerPath(runId));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const encoded = Buffer.from(command, "utf8").toString("base64");
      return `${EXEC_CONTROL_WRAPPER} ${execMarkerId(runId)} ${encoded}`;
    },

    signal(runId) {
      assertRoot();
      const target = markerPath(runId);
      const temporary = path.join(
        resolvedRoot,
        `.${execMarkerId(runId)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
      );
      try {
        const fd = fs.openSync(temporary, "wx", 0o600);
        fs.closeSync(fd);
        fs.renameSync(temporary, target);
        return true;
      } finally {
        try {
          fs.unlinkSync(temporary);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    },

    clear(runId) {
      assertRoot();
      try {
        fs.unlinkSync(markerPath(runId));
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    },
  };
}

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

function normalizeWorkspaceFilePath(value) {
  if (value === "/workspace" || value === "workspace") return ".";
  if (typeof value === "string" && value.startsWith("/workspace/")) {
    return value.slice("/workspace/".length);
  }
  if (typeof value === "string" && value.startsWith("workspace/")) {
    return value.slice("workspace/".length);
  }
  return value;
}

function normalizeExecWorkdir(value) {
  if (value === "/workspace" || value === "workspace" || value === ".") return ".";
  if (typeof value === "string" && value.startsWith("workspace/")) {
    return `/${value}`;
  }
  return value;
}

function normalizeWorkspaceParams(toolName, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const updated = { ...params };
  let changed = false;
  if (FILE_PATH_TOOLS.has(toolName) && typeof params.path === "string") {
    const path = normalizeWorkspaceFilePath(params.path);
    if (path !== params.path) {
      updated.path = path;
      changed = true;
    }
  }
  if (toolName === "exec" && typeof params.workdir === "string") {
    const workdir = normalizeExecWorkdir(params.workdir);
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
  const normalizedWorkdir = normalizeExecWorkdir(params.workdir);
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

function toolCallFailed(event) {
  if (event?.error) return true;
  const result = event?.result;
  return Boolean(
    result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      result.isError === true
  );
}

function webFetchWasTruncated(event) {
  if (event?.error) return false;
  const details = event?.result?.details;
  if (
    details &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    details.truncated === true &&
    details.status === 200
  ) {
    return true;
  }
  const content = event?.result?.content;
  if (!Array.isArray(content)) return false;
  for (const part of content) {
    if (!part || typeof part !== "object" || typeof part.text !== "string") continue;
    try {
      const parsed = JSON.parse(part.text);
      if (parsed?.truncated === true && parsed?.status === 200) return true;
    } catch {
      // Non-JSON tool text cannot establish a successful truncated fetch.
    }
  }
  return false;
}

function runIdentity(event, context) {
  const runId = context?.runId ?? event?.runId;
  const sessionId = context?.sessionId;
  return {
    runId: typeof runId === "string" && runId ? runId : undefined,
    sessionId: typeof sessionId === "string" && sessionId ? sessionId : undefined,
  };
}

export function urlTargetsNonPublicAddress(raw) {
  if (typeof raw !== "string" || !raw) return false;
  try {
    const target = new URL(raw);
    if (!new Set(["http:", "https:"]).has(target.protocol)) return true;
    if (target.username || target.password) return true;
    const hostname = target.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/, "")
      .toLowerCase();
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

export function textRequestsPrivateUrlAccess(text) {
  if (typeof text !== "string" || !text) return false;
  const urls = text.match(/https?:\/\/[^\s"'`|;&<>]+/gi) ?? [];
  if (!urls.some((url) => urlTargetsNonPublicAddress(url.replace(/[),.\]}]+$/, "")))) {
    return false;
  }
  if (
    ARTIFACT_DRAFT_PREFIX.test(text) &&
    ARTIFACT_NOUN.test(text) &&
    !FOLLOWUP_PRIVATE_ACCESS.test(text)
  ) {
    return false;
  }
  return /\b(?:access|browse|call|check|connect|download|fetch|inspect|open|query|read|request|retrieve|summarize|test|visit)\b|\btell\s+me\b|\bwhat(?:'s|\s+is)\s+(?:at|on)\b/i.test(
    text
  );
}

function messageContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function currentUserText(messages, prompt = undefined) {
  if (typeof prompt === "string" && prompt) return prompt;
  if (!Array.isArray(messages)) return "";
  const userMessage = [...messages]
    .reverse()
    .find((message) => message && message.role === "user");
  return messageContentText(userMessage?.content);
}

export function userMessageRequestsPrivateUrl(messages, prompt = undefined) {
  const text = currentUserText(messages, prompt);
  return textRequestsPrivateUrlAccess(text);
}

function validGitHubRepository(owner, repository) {
  return (
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) &&
    /^[A-Za-z0-9._-]{1,100}$/.test(repository) &&
    !repository.endsWith(".")
  );
}

export function userMessageGitHubRepositoryUrl(messages, prompt = undefined) {
  const text = currentUserText(messages, prompt);
  if (!text) return undefined;
  const explicit = text.match(
    /https?:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?=[\s/?#),.;\]}]|$)/i
  );
  let match = explicit;
  if (!match) {
    match = text.match(
      /\b([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\b(?=.{0,64}\bGitHub\s+(?:repo(?:sitory)?|project)\b)/i
    );
  }
  if (!match) {
    match = text.match(
      /\bGitHub\s+(?:repo(?:sitory)?|project)\b.{0,64}\b([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\b/i
    );
  }
  if (!match) return undefined;
  // A sentence-final period is not part of the repository name, but the URL
  // matcher must otherwise allow dots for legitimate names and the .git form.
  const repository = match[2].replace(/\.+$/g, "").replace(/\.git$/i, "");
  if (!repository || !validGitHubRepository(match[1], repository)) return undefined;
  return `https://github.com/${match[1]}/${repository}`;
}

export function userMessageGitHubFileUrl(messages, prompt = undefined) {
  const text = currentUserText(messages, prompt);
  const repositoryUrl = userMessageGitHubRepositoryUrl(messages, prompt);
  if (!text || !repositoryUrl) return undefined;
  let repository;
  try {
    const target = new URL(repositoryUrl);
    const parts = target.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || !validGitHubRepository(parts[0], parts[1])) {
      return undefined;
    }
    repository = parts;
  } catch {
    return undefined;
  }

  // Accept only a plainly named, repository-relative path. Do not interpret
  // traversal, URL-encoded text, absolute paths, or the Owner/Repo identifier
  // itself as a file target. Each accepted segment is safe to place in a raw
  // GitHub URL after independent encoding.
  const paths = text.matchAll(
    /(?:^|[\s"'`(])((?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+)(?=[\s"'`,).;:?!\]}]|$)/g
  );
  for (const match of paths) {
    const relative = match[1];
    if (relative.length > 240) continue;
    if (relative.toLowerCase() === `${repository[0]}/${repository[1]}`.toLowerCase()) {
      continue;
    }
    const segments = relative.split("/");
    if (
      segments.length < 2 ||
      segments.length > 16 ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      continue;
    }
    const encoded = segments.map((segment) => encodeURIComponent(segment)).join("/");
    return `https://raw.githubusercontent.com/${repository[0]}/${repository[1]}/HEAD/${encoded}`;
  }
  return undefined;
}

export function githubReadmeUrl(repositoryUrl) {
  if (typeof repositoryUrl !== "string") return undefined;
  try {
    const target = new URL(repositoryUrl);
    const parts = target.pathname.split("/").filter(Boolean);
    if (
      target.protocol !== "https:" ||
      target.hostname.toLowerCase() !== "github.com" ||
      parts.length !== 2 ||
      !validGitHubRepository(parts[0], parts[1])
    ) {
      return undefined;
    }
    return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/HEAD/README.md`;
  } catch {
    return undefined;
  }
}

function fetchTargetsNonPublicAddress(event) {
  return urlTargetsNonPublicAddress(event?.params?.url);
}

function canonicalFetchUrl(event) {
  const raw = event?.params?.url;
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const target = new URL(raw);
    if (!new Set(["http:", "https:"]).has(target.protocol)) return undefined;
    target.hash = "";
    return target.toString();
  } catch {
    return undefined;
  }
}

function execTargetsNonPublicAddress(event) {
  const command = event?.params?.command;
  if (typeof command !== "string" || !command) return false;
  const urls = command.match(/https?:\/\/[^\s"'`|;&<>]+/gi) ?? [];
  if (urls.some((url) => urlTargetsNonPublicAddress(url.replace(/[),.\]}]+$/, "")))) {
    return true;
  }
  if (!/(?:^|\s|[;&|])(?:curl|wget)(?:\s|$)/i.test(command)) return false;
  const arguments_ = command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return arguments_.some((argument) => {
    const candidate = argument.replace(/^["']|["'),.;\]}]+$/g, "");
    if (
      candidate.startsWith("-") ||
      !/^(?:localhost|[a-z0-9.-]+\.(?:local|internal)|\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/|$)/i.test(
        candidate
      )
    ) {
      return false;
    }
    return urlTargetsNonPublicAddress(`http://${candidate}`);
  });
}

export function createToolLoopGuard({
  abortRun,
  abortRunAndDrain,
  execControl,
  execMarkerCleanupDelayMs = 5000,
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
        webTerminalBlocks: 0,
        codingExhausted: false,
        codingTerminalBlocks: 0,
        privateNetworkExhausted: false,
        privateNetworkPrompt: false,
        clientCancelled: false,
        fetchedUrls: new Set(),
        fetchPivots: new Set(),
        targetedExtractPending: undefined,
        targetedExtractBlocks: 0,
        githubCanonicalUrl: undefined,
        githubReadmeUrl: undefined,
        githubFileUrl: undefined,
        githubCanonicalSatisfied: false,
        githubCanonicalBlocks: 0,
        failedExec: new Map(),
        execOriginalByWrapped: new Map(),
      };
      runs.set(runId, state);
    }
    return state;
  }

  function beforeToolCall(event, context, agentId = "pixel") {
    if (context?.agentId !== agentId) return undefined;
    // OpenClaw 2026.6 does not consistently expose sessionKey during
    // before_prompt_build for OpenAI-compatible HTTP turns. Tool hooks do
    // receive the complete run context, so refresh the opaque user -> session
    // cancellation mapping here as well. This keeps dashboard disconnects
    // capable of aborting a long model continuation after the first tool.
    observeRun(context, agentId);
    const toolName = context?.toolName ?? event?.toolName;
    const normalizedParams = normalizeWorkspaceParams(toolName, event?.params);

    const { runId, sessionId } = runIdentity(event, context);
    const state = runId && sessionId ? stateFor(runId) : undefined;

    if (state?.clientCancelled) {
      return { block: true, blockReason: CLIENT_CANCELLED_REASON };
    }

    if (state?.privateNetworkPrompt) {
      state.privateNetworkPrompt = false;
      state.privateNetworkExhausted = true;
      return { block: true, blockReason: PRIVATE_URL_REQUEST_REASON };
    }

    if (state?.privateNetworkExhausted) {
      let aborted = false;
      try {
        aborted = typeof abortRun === "function" && Boolean(abortRun(sessionId));
      } catch (error) {
        warn(`Pixel private-network abort failed for run ${runId}: ${String(error)}`);
      }
      warn(
        `Pixel stopped a tool retry after a private-network block for run ${runId}; active run aborted=${aborted}`
      );
      return { block: true, blockReason: PRIVATE_NETWORK_LOOP_ABORT_REASON };
    }

    if (
      (toolName === "web_fetch" || toolName === "pixel_ods_web_extract") &&
      fetchTargetsNonPublicAddress(event)
    ) {
      if (state) state.privateNetworkExhausted = true;
      warn("Pixel blocked a non-public web_fetch destination before execution");
      return { block: true, blockReason: WEB_FETCH_PUBLIC_ONLY_REASON };
    }
    if (toolName === "exec" && execTargetsNonPublicAddress(event)) {
      if (state) state.privateNetworkExhausted = true;
      warn("Pixel blocked an exec-based private HTTP(S) destination before execution");
      return { block: true, blockReason: EXEC_PRIVATE_NETWORK_REASON };
    }

    if (state?.targetedExtractPending) {
      const requestedUrl = canonicalFetchUrl(event);
      const exactGitHubFileContinuation =
        toolName === "web_fetch" &&
        state.githubFileUrl &&
        requestedUrl === state.githubFileUrl &&
        state.targetedExtractPending === state.githubReadmeUrl;
      if (exactGitHubFileContinuation) {
        // The owner explicitly named this validated file in the same canonical
        // repository. A truncated README may already contain the requested
        // repository description, so allow the exact second source instead of
        // forcing an irrelevant same-page extraction.
        state.targetedExtractPending = undefined;
        state.targetedExtractBlocks = 0;
      } else if (
        toolName === "pixel_ods_web_extract" &&
        requestedUrl === state.targetedExtractPending
      ) {
        state.targetedExtractPending = undefined;
        state.targetedExtractBlocks = 0;
      } else if (state.targetedExtractBlocks === 0) {
        state.targetedExtractBlocks = 1;
        return { block: true, blockReason: WEB_FETCH_TRUNCATED_PIVOT_REASON };
      } else {
        state.targetedExtractPending = undefined;
        state.webExhausted = true;
        return { block: true, blockReason: WEB_BUDGET_EXHAUSTED_REASON };
      }
    }

    if (
      state?.githubCanonicalUrl &&
      !state.githubCanonicalSatisfied &&
      WEB_TOOLS.has(toolName)
    ) {
      const requestedUrl = canonicalFetchUrl(event);
      if (
        (toolName === "web_fetch" || toolName === "pixel_ods_web_extract") &&
        requestedUrl === state.githubReadmeUrl
      ) {
        state.githubCanonicalSatisfied = true;
        state.githubCanonicalBlocks = 0;
      } else if (state.githubCanonicalBlocks === 0) {
        state.githubCanonicalBlocks = 1;
        return {
          block: true,
          blockReason:
            `${GITHUB_CANONICAL_SOURCE_PREFIX} ${state.githubCanonicalUrl}. ` +
            `Do not search or narrate a retry. Call web_fetch once with exactly ${state.githubReadmeUrl} now.`,
        };
      } else {
        state.webExhausted = true;
        return { block: true, blockReason: WEB_BUDGET_EXHAUSTED_REASON };
      }
    }

    if (WEB_TOOLS.has(toolName) && (!runId || !sessionId)) {
      return {
        block: true,
        blockReason:
          "Pixel could not establish the bounded run identity required for web access. Do not call another tool in this turn; explain that web research is temporarily unavailable.",
      };
    }

    if (!runId || !sessionId) {
      if (toolName === "exec" && execControl) {
        return { block: true, blockReason: CANCELLABLE_EXEC_UNAVAILABLE_REASON };
      }
      return normalizedParams ? { params: normalizedParams } : undefined;
    }

    if (state.webExhausted) {
      if (state.webTerminalBlocks === 0) {
        state.webTerminalBlocks = 1;
        return { block: true, blockReason: WEB_BUDGET_EXHAUSTED_REASON };
      }
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

    if (state.codingExhausted) {
      if (state.codingTerminalBlocks === 0) {
        state.codingTerminalBlocks = 1;
        return { block: true, blockReason: CODING_RETRY_EXHAUSTED_REASON };
      }
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
      if (toolName === "exec" && execControl) {
        const params = { ...(normalizedParams ?? event?.params) };
        const originalFingerprint = execFingerprint(params);
        try {
          params.command = execControl.prepare(runId, params.command);
        } catch (error) {
          warn(`Pixel cancellable exec preparation failed for run ${runId}: ${String(error)}`);
          return { block: true, blockReason: CANCELLABLE_EXEC_UNAVAILABLE_REASON };
        }
        const wrappedFingerprint = execFingerprint(params);
        if (originalFingerprint && wrappedFingerprint) {
          state.execOriginalByWrapped.set(wrappedFingerprint, originalFingerprint);
        }
        return { params };
      }
      return normalizedParams ? { params: normalizedParams } : undefined;
    }

    if (toolName === "web_fetch") {
      const fetchUrl = canonicalFetchUrl(event);
      if (fetchUrl && state.fetchedUrls.has(fetchUrl)) {
        if (state.fetchPivots.has(fetchUrl)) {
          state.webExhausted = true;
          return { block: true, blockReason: WEB_BUDGET_EXHAUSTED_REASON };
        }
        state.fetchPivots.add(fetchUrl);
        return { block: true, blockReason: WEB_FETCH_REPEAT_PIVOT_REASON };
      }
    }

    const kind = toolName === "web_search" ? "search" : "fetch";
    if (state[kind] >= effective[kind] || state.total >= effective.total) {
      state.webExhausted = true;
      return { block: true, blockReason: WEB_BUDGET_EXHAUSTED_REASON };
    }

    state[kind] += 1;
    state.total += 1;
    if (toolName === "web_fetch") {
      const fetchUrl = canonicalFetchUrl(event);
      if (fetchUrl) state.fetchedUrls.add(fetchUrl);
    }
    return normalizedParams ? { params: normalizedParams } : undefined;
  }

  function observeRun(context, agentId = "pixel", event = undefined) {
    if (context?.agentId !== agentId) return;
    const runId = context?.runId;
    const sessionId = context?.sessionId;
    if (
      typeof runId === "string" &&
      runId &&
      typeof sessionId === "string" &&
      sessionId &&
      userMessageRequestsPrivateUrl(event?.messages, event?.prompt)
    ) {
      stateFor(runId).privateNetworkPrompt = true;
    }
    if (typeof runId === "string" && runId) {
      const githubUrl = userMessageGitHubRepositoryUrl(event?.messages, event?.prompt);
      if (githubUrl) {
        const state = stateFor(runId);
        if (!state.githubCanonicalUrl) {
          state.githubCanonicalUrl = githubUrl;
          state.githubReadmeUrl = githubReadmeUrl(githubUrl);
          state.githubFileUrl = userMessageGitHubFileUrl(event?.messages, event?.prompt);
        }
      }
    }
    const prefix = `agent:${agentId}:openai-user:`;
    const sessionKey = context?.sessionKey;
    if (
      typeof sessionKey !== "string" ||
      !sessionKey.startsWith(prefix) ||
      typeof runId !== "string" ||
      !runId ||
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
    activeUsers.set(user, { runId, sessionId, sessionKey });
  }

  async function abortUserRun(user) {
    if (typeof user !== "string" || !ODS_OPENAI_USER.test(user)) return false;
    const active = activeUsers.get(user);
    if (!active) return false;
    let aborted = false;
    let executionSignalled = execControl ? false : true;
    stateFor(active.runId).clientCancelled = true;
    if (execControl) {
      try {
        executionSignalled = Boolean(execControl.signal(active.runId));
      } catch (error) {
        warn(`Pixel client-cancel execution signal failed: ${String(error)}`);
      }
    }
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
    const cancelled = aborted && executionSignalled;
    if (executionSignalled && typeof execControl?.clear === "function") {
      const cleanup = setTimeout(() => {
        try {
          execControl.clear(active.runId);
        } catch (error) {
          warn(`Pixel client-cancel marker cleanup failed: ${String(error)}`);
        }
      }, Math.max(0, execMarkerCleanupDelayMs));
      cleanup.unref?.();
    }
    if (cancelled) activeUsers.delete(user);
    return cancelled;
  }

  function afterToolCall(event, context, agentId = "pixel") {
    if (context?.agentId !== agentId) return;
    const toolName = context?.toolName ?? event?.toolName;
    const runId = context?.runId ?? event?.runId;
    if (typeof runId !== "string" || !runId) return;
    const state = stateFor(runId);
    // A successful file mutation changes the program under test, so an
    // identical verification command is no longer an identical attempt. Drop
    // stale failures across all command fingerprints while retaining them when
    // the mutation itself failed.
    if (WORKSPACE_MUTATION_TOOLS.has(toolName) && !toolCallFailed(event)) {
      state.failedExec.clear();
    }
    if (toolName === "web_fetch" && webFetchWasTruncated(event)) {
      const fetchUrl = canonicalFetchUrl(event);
      if (fetchUrl) {
        state.targetedExtractPending = fetchUrl;
        state.targetedExtractBlocks = 0;
      }
      return;
    }
    if (toolName !== "exec") return;
    const observedFingerprint = execFingerprint(event?.params);
    const fingerprint = state.execOriginalByWrapped.get(observedFingerprint) ?? observedFingerprint;
    if (observedFingerprint) state.execOriginalByWrapped.delete(observedFingerprint);
    if (!fingerprint) return;
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

export function createToolLoopGuardRegistry() {
  let shared;
  return {
    get(options) {
      shared ??= createToolLoopGuard(options);
      return shared;
    },
  };
}
