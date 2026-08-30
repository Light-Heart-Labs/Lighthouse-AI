// Pixel per-run tool-loop guard.
//
// OpenClaw's built-in identical-call detector blocks a repeated tool call, but
// a model can keep asking for the blocked tool on later continuation passes.
// Bound the web-research and coding-repair portions of a Pixel response. A
// duplicate fetch gets one nonterminal pivot to targeted extraction, while
// repeated foreground or background verification failures share a run-wide
// budget. Terminal blocks get one result in which to produce a useful final
// answer; if the model ignores one, abort only that active agent run through
// OpenClaw's public harness runtime.

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
  failedVerificationAttempts: 6,
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

export const GITHUB_CANONICAL_FETCH_FAILED_REASON =
  "Pixel could not fetch the owner's identified canonical GitHub README. Do not call another tool in this turn or answer repository facts from memory; state that the requested source could not be verified.";

export const GITHUB_SOURCE_UNVERIFIED_DELIVERY_PREFIX =
  "Pixel could not verify the requested GitHub repository because its identified canonical README was not successfully fetched in this response. No repository claims are verified; please retry.";

export const EXEC_PRIVATE_NETWORK_REASON =
  "Pixel blocked this command because shell execution cannot be used to contact local, private, or raw-IP HTTP(S) destinations. Do not call another tool in this turn; explain the boundary to the user.";

export const PRIVATE_NETWORK_LOOP_ABORT_REASON =
  "Pixel stopped this response because it requested another tool after a private-network boundary was enforced. Start a fresh message with a safe public destination or an approved ODS status capability.";

export const PRIVATE_URL_REQUEST_REASON =
  "This request contains a private URL that Pixel cannot open from this chat. Do not call or substitute any tool, including ODS status or shell tools. Reply concisely that the private page was not accessed and ask the user to provide its content or use a separately approved private-access capability.";

export const CODING_RETRY_EXHAUSTED_REASON =
  "Pixel stopped a no-progress coding repair loop after its bounded failed-verification limit. Do not call another tool in this turn. Give the user a visible summary of the verified failure, the changes attempted, and the most useful next step.";

export const CODING_LOOP_ABORT_REASON =
  "Pixel stopped this response because it requested another coding tool after the repeated-command limit was reached. Start a fresh message to continue from the preserved workspace with a different approach.";

export const VERIFICATION_PENDING_DELIVERY_PREFIX =
  "Pixel stopped before the verification process reached a terminal result, so success is unverified. The workspace is preserved; ask Pixel to continue the run or inspect the process.";

export const VERIFICATION_FAILED_DELIVERY_PREFIX =
  "Pixel could not complete this task successfully because the latest verification check failed. The workspace is preserved; ask Pixel to continue with a focused repair.";

export const RECURSIVE_DELETE_REQUIRES_OWNER_REASON =
  "Pixel blocked this recursive forced deletion because the owner's current request did not explicitly authorize deleting that workspace tree. Inspect the exact target and use focused file edits, or ask the owner for deletion approval. Do not substitute another destructive command.";

export const CANCELLABLE_EXEC_UNAVAILABLE_REASON =
  "Pixel could not establish the exact cancellation boundary for this command. Do not call another tool in this turn; explain that execution is temporarily unavailable.";

export const CLIENT_CANCELLED_REASON =
  "The owner cancelled this Pixel response. Do not call another tool or continue the task in this turn.";

export const ODS_TOOL_ROUTING_ABORT_REASON =
  "Pixel stopped this response because the required dedicated ODS projection tool was not used after one correction. Do not call another tool in this turn. State that the requested ODS facts were not verified and ask the owner to retry.";

export const ODS_TOOL_ROUTING_LOOP_ABORT_REASON =
  "Pixel stopped this response because it requested another tool after the ODS projection route was enforced. Start a fresh message to continue.";

const WEB_TOOLS = new Set(["web_search", "web_fetch", "pixel_ods_web_extract"]);
const CODING_TOOLS = new Set(["exec", "write", "edit", "apply_patch"]);
const WORKSPACE_MUTATION_TOOLS = new Set(["write", "edit", "apply_patch"]);
const FILE_PATH_TOOLS = new Set(["read", "write", "edit"]);
const MAX_TRACKED_RUNS = 256;
const MAX_PENDING_EXEC_SESSIONS = 64;
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
    failedVerificationAttempts: validLimit(
      limits.failedVerificationAttempts,
      DEFAULT_WEB_TOOL_LIMITS.failedVerificationAttempts
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

function verificationExecFingerprint(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  if (typeof params.command !== "string" || !params.command.trim()) return undefined;
  let command = params.command.trim();
  let commandWorkdir;
  const workspaceCd = command.match(
    /^cd\s+(?:"(\/workspace(?:\/[^"\r\n]*)?)"|'(\/workspace(?:\/[^'\r\n]*)?)'|(\/workspace(?:\/[A-Za-z0-9._/-]+)?))\s*&&\s*(.+)$/is
  );
  if (workspaceCd) {
    commandWorkdir = workspaceCd[1] ?? workspaceCd[2] ?? workspaceCd[3];
    command = workspaceCd[4];
  }
  command = command
    .replace(/\s+2>&1\s*$/i, "")
    .replace(/\s+/g, " ");
  if (
    !/^(?:python(?:3(?:\.\d+)?)?\s+-m\s+(?:unittest|pytest)\b|pytest\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|go\s+test\b|cargo\s+test\b|dotnet\s+test\b|mvn(?:w)?\s+test\b|gradle(?:w)?\s+test\b)/i.test(command)
  ) {
    return undefined;
  }
  const normalizedWorkdir = normalizeExecWorkdir(params.workdir ?? commandWorkdir);
  const workdir = normalizedWorkdir === "." ? "" : normalizedWorkdir;
  return JSON.stringify([command, typeof workdir === "string" ? workdir : ""]);
}

function execFailed(event) {
  if (typeof event?.error === "string" && event.error) return true;
  const result = event?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  if (result.isError === true) return true;
  const exitCode = result?.details?.exitCode;
  return Number.isInteger(exitCode) && exitCode !== 0;
}

function runningExecSessionId(event) {
  const details = event?.result?.details;
  if (
    !details ||
    typeof details !== "object" ||
    Array.isArray(details) ||
    details.status !== "running" ||
    typeof details.sessionId !== "string" ||
    !details.sessionId
  ) {
    return undefined;
  }
  return details.sessionId;
}

function completedProcessResult(event) {
  const action = event?.params?.action;
  if (action !== "poll" && action !== "log") return undefined;
  const details = event?.result?.details;
  if (
    !details ||
    typeof details !== "object" ||
    Array.isArray(details) ||
    details.status !== "completed" ||
    typeof details.sessionId !== "string" ||
    !details.sessionId ||
    !Number.isInteger(details.exitCode)
  ) {
    return undefined;
  }
  return { sessionId: details.sessionId, failed: details.exitCode !== 0 };
}

function canonicalPendingProcessSessionId(params, pendingSessions) {
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    typeof params.sessionId !== "string" ||
    !params.sessionId ||
    !(pendingSessions instanceof Map)
  ) {
    return undefined;
  }
  if (pendingSessions.has(params.sessionId)) return params.sessionId;
  // Small local models sometimes combine OpenClaw's human-facing output
  // ("session fast-breeze, pid 95242") into the invented identifier
  // "session-fast-breeze-95242". Correct only that exact shape and only when
  // the embedded label is already a pending execution created by this run.
  // This cannot widen session visibility or select an unrelated process.
  const alias = params.sessionId.match(/^session-(.+)-([1-9][0-9]*)$/);
  if (!alias || !pendingSessions.has(alias[1])) return undefined;
  return alias[1];
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

function canonicalWebFetchSucceeded(event) {
  if (toolCallFailed(event)) return false;
  const statuses = [];
  const details = event?.result?.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    statuses.push(details.status);
  }
  const content = event?.result?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object" || typeof part.text !== "string") continue;
      try {
        statuses.push(JSON.parse(part.text)?.status);
      } catch {
        // Plain-text source content has no independently inspectable HTTP status.
      }
    }
  }
  return statuses.some(
    (status) => Number.isInteger(status) && status >= 200 && status < 300
  );
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

const CURRENT_MESSAGE_WRAPPER = "[Current message - respond to this]\nUser:";

function unwrapCurrentUserText(text) {
  if (typeof text !== "string" || !text) return "";
  const normalized = text.replace(/\r\n/g, "\n");
  const first = normalized.indexOf(CURRENT_MESSAGE_WRAPPER);
  if (first === -1) return normalized;
  // The dashboard/OpenClaw compatibility prompt uses exactly one trusted
  // current-message delimiter after its history transcript. If untrusted user
  // content introduces another delimiter, keep the complete prompt so every
  // safety classifier fails conservatively instead of accepting a forged tail.
  if (
    normalized.indexOf(CURRENT_MESSAGE_WRAPPER, first + CURRENT_MESSAGE_WRAPPER.length) !== -1
  ) {
    return normalized;
  }
  return normalized.slice(first + CURRENT_MESSAGE_WRAPPER.length).trimStart();
}

function currentUserText(messages, prompt = undefined) {
  if (typeof prompt === "string" && prompt) return unwrapCurrentUserText(prompt);
  if (!Array.isArray(messages)) return "";
  const userMessage = [...messages]
    .reverse()
    .find((message) => message && message.role === "user");
  return unwrapCurrentUserText(messageContentText(userMessage?.content));
}

function explicitlyRejectsOdsTool(text, toolPattern) {
  const actionNegation = new RegExp(
    `\\b(?:do\\s+not|don't|never|must\\s+not|should\\s+not)\\s+` +
      `(?:call|invoke|query|run|use)\\b[^.!?;\\n]{0,80}\\b(?:${toolPattern})\\b`,
    "i"
  );
  const omissionNegation = new RegExp(
    `\\b(?:avoid|skip|without)\\b[^.!?;\\n]{0,80}\\b(?:${toolPattern})\\b`,
    "i"
  );
  const directNegation = new RegExp(`\\bnot\\s+(?:the\\s+)?(?:${toolPattern})\\b`, "i");
  return text
    .split(/[.!?;\n]+|,\s*(?=(?:and\s+then|but|however|instead|then)\b)/i)
    .some(
      (clause) =>
        actionNegation.test(clause) ||
        omissionNegation.test(clause) ||
        directNegation.test(clause)
    );
}

export function userMessageAuthorizesRecursiveDelete(messages, prompt = undefined) {
  const text = currentUserText(messages, prompt);
  if (!text) return false;
  return /\b(?:delete|remove|erase|wipe)\s+(?:the\s+)?(?:directory|folder|tree|workspace\s+tree)?\s*(?:at\s+)?["'`]?\/workspace(?:\/[A-Za-z0-9._/-]+)?["'`]?\s+(?:recursively|and\s+(?:all\s+)?(?:its\s+)?contents)\b/i.test(
    text
  );
}

function requestsRecursiveForcedDelete(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const command = params.command;
  if (typeof command !== "string" || !command.trim()) return false;
  const invocations = command.matchAll(/(?:^|[;&|]\s*)rm\s+((?:(?:--[A-Za-z-]+|-[A-Za-z]+)\s+)+)/gim);
  for (const match of invocations) {
    const options = match[1];
    const recursive = /--recursive\b/i.test(options) || /(?:^|\s)-[A-Za-z]*[rR][A-Za-z]*(?:\s|$)/.test(options);
    const forced = /--force\b/i.test(options) || /(?:^|\s)-[A-Za-z]*f[A-Za-z]*(?:\s|$)/.test(options);
    if (recursive && forced) return true;
  }
  return false;
}

export function userMessageOdsToolRequirements(messages, prompt = undefined) {
  const text = currentUserText(messages, prompt);
  if (!text) return [];
  const genericOdsTool = String.raw`ODS\s+(?:read-only\s+)?(?:projection|tool)s?`;
  const statusTool =
    String.raw`(?:pixel_ods_status|ODS\s+(?:health|model|status)(?:\s+(?:projection|tool)s?)?)`;
  const appsTool =
    String.raw`(?:pixel_ods_apps_list|ODS\s+(?:app|application)s?(?:\s+(?:list|projection|tool)s?)?)`;
  const rejectsStatus = explicitlyRejectsOdsTool(
    text,
    `(?:${genericOdsTool}|${statusTool})`
  );
  const rejectsApps = explicitlyRejectsOdsTool(text, `(?:${genericOdsTool}|${appsTool})`);
  const requirements = [];
  const asksStatus =
    !rejectsStatus &&
    (/\bpixel_ods_status\b/i.test(text) ||
      /\b(?:active|current|loaded|running)\s+(?:ODS\s+|Pixel\s+)?model\b/i.test(text) ||
      /\b(?:ODS\s+|Pixel\s+)?model\s+(?:is\s+)?(?:currently\s+)?(?:active|current|loaded|running)\b/i.test(
        text
      ) ||
      /\b(?:ODS|Pixel)\b.{0,80}\b(?:health|status|online|available|service count|services online|active model|current model|context (?:window|length|limit))\b/i.test(
        text
      ) ||
      /\b(?:health|status|online|available|service count|services online|active model|current model|context (?:window|length|limit))\b.{0,80}\b(?:ODS|Pixel)\b/i.test(
        text
      ));
  const asksApps =
    !rejectsApps &&
    (/\bpixel_ods_apps_list\b/i.test(text) ||
      /\bODS\b.{0,80}\b(?:apps?|applications?)\b/i.test(text) ||
      /\b(?:apps?|applications?)\b.{0,80}\bODS\b/i.test(text) ||
      /\bODS(?:\s+(?:app|application|service)s?)?\s+(?:links?|URLs?)\b/i.test(text) ||
      /\bconfigured\s+(?:app\s+)?(?:links?|URLs?)\b.{0,48}\bODS\b/i.test(text) ||
      (/\b(?:n8n|Open\s*WebUI|Perplexica|SearXNG|LiteLLM|Hermes)\b/i.test(text) &&
        /\b(?:configured|link|URL|where|open|address)\b/i.test(text)));
  if (asksStatus) requirements.push("pixel_ods_status");
  if (asksApps) requirements.push("pixel_ods_apps_list");
  return requirements;
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
  // disabled for this non-bundled hook path. Bound the cache itself instead of
  // requesting conversation access merely for cleanup.
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
        githubCanonicalFailed: false,
        githubCanonicalBlocks: 0,
        odsRoutingInitialized: false,
        odsRequiredTools: new Set(),
        odsRoutingBlocks: 0,
        odsRoutingExhausted: false,
        odsRoutingTerminalBlocks: 0,
        failedExec: new Map(),
        failedVerificationAttempts: 0,
        latestVerificationStatus: undefined,
        latestVerificationFingerprint: undefined,
        recursiveDeleteAuthorized: false,
        pendingExecSessions: new Map(),
        execOriginalByWrapped: new Map(),
        verificationOriginalByWrapped: new Map(),
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
    let normalizedParams = normalizeWorkspaceParams(toolName, event?.params);

    const { runId, sessionId } = runIdentity(event, context);
    const state = runId && sessionId ? stateFor(runId) : undefined;
    if (toolName === "process" && state) {
      const params = normalizedParams ?? event?.params;
      const canonicalSessionId = canonicalPendingProcessSessionId(
        params,
        state.pendingExecSessions
      );
      if (canonicalSessionId && canonicalSessionId !== params?.sessionId) {
        normalizedParams = { ...params, sessionId: canonicalSessionId };
      }
    }

    if (state?.clientCancelled) {
      return { block: true, blockReason: CLIENT_CANCELLED_REASON };
    }

    if (
      toolName === "exec" &&
      requestsRecursiveForcedDelete(normalizedParams ?? event?.params) &&
      !state?.recursiveDeleteAuthorized
    ) {
      return { block: true, blockReason: RECURSIVE_DELETE_REQUIRES_OWNER_REASON };
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

    if (state?.odsRoutingExhausted) {
      if (state.odsRoutingTerminalBlocks === 0) {
        state.odsRoutingTerminalBlocks = 1;
        return { block: true, blockReason: ODS_TOOL_ROUTING_ABORT_REASON };
      }
      let aborted = false;
      try {
        aborted = typeof abortRun === "function" && Boolean(abortRun(sessionId));
      } catch (error) {
        warn(`Pixel ODS-routing abort failed for run ${runId}: ${String(error)}`);
      }
      warn(
        `Pixel stopped a tool retry after an ODS-routing block for run ${runId}; active run aborted=${aborted}`
      );
      return { block: true, blockReason: ODS_TOOL_ROUTING_LOOP_ABORT_REASON };
    }

    if (state?.odsRequiredTools.size > 0) {
      if (state.odsRequiredTools.has(toolName)) {
        state.odsRequiredTools.delete(toolName);
        state.odsRoutingBlocks = 0;
      } else if (state.odsRoutingBlocks === 0) {
        state.odsRoutingBlocks = 1;
        const required = [...state.odsRequiredTools].join(" and ");
        return {
          block: true,
          blockReason:
            `This request asks for ODS facts exposed by dedicated read-only tools. ` +
            `Before any other tool, call ${required} exactly once. Then continue the owner's remaining work normally.`,
        };
      } else {
        state.odsRoutingExhausted = true;
        return { block: true, blockReason: ODS_TOOL_ROUTING_ABORT_REASON };
      }
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
      if (state.githubCanonicalFailed) {
        state.webExhausted = true;
        return { block: true, blockReason: GITHUB_CANONICAL_FETCH_FAILED_REASON };
      }
      const requestedUrl = canonicalFetchUrl(event);
      if (
        toolName === "web_fetch" &&
        requestedUrl === state.githubReadmeUrl
      ) {
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
      const verificationFingerprint = verificationExecFingerprint(
        normalizedParams ?? event?.params
      );
      if (
        (fingerprint &&
          (state.failedExec.get(fingerprint) ?? 0) >= effective.failedExecRetries) ||
        (verificationFingerprint &&
          state.failedVerificationAttempts >= effective.failedVerificationAttempts)
      ) {
        state.codingExhausted = true;
        return { block: true, blockReason: CODING_RETRY_EXHAUSTED_REASON };
      }
    }

    if (!WEB_TOOLS.has(toolName)) {
      if (toolName === "exec" && execControl) {
        const params = { ...(normalizedParams ?? event?.params) };
        const originalFingerprint = execFingerprint(params);
        const originalVerificationFingerprint = verificationExecFingerprint(params);
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
        if (originalVerificationFingerprint && wrappedFingerprint) {
          state.verificationOriginalByWrapped.set(
            wrappedFingerprint,
            originalVerificationFingerprint
          );
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
      const state = stateFor(runId);
      if (currentUserText(event?.messages, event?.prompt)) {
        state.recursiveDeleteAuthorized = userMessageAuthorizesRecursiveDelete(
          event?.messages,
          event?.prompt
        );
      }
      if (!state.odsRoutingInitialized) {
        const requirements = userMessageOdsToolRequirements(event?.messages, event?.prompt);
        if (requirements.length > 0) {
          state.odsRequiredTools = new Set(requirements);
          state.odsRoutingInitialized = true;
        }
      }
      const githubUrl = userMessageGitHubRepositoryUrl(event?.messages, event?.prompt);
      if (githubUrl) {
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
    if (
      state.githubReadmeUrl &&
      toolName === "web_fetch" &&
      canonicalFetchUrl(event) === state.githubReadmeUrl
    ) {
      state.githubCanonicalSatisfied = canonicalWebFetchSucceeded(event);
      state.githubCanonicalFailed = !state.githubCanonicalSatisfied;
    }
    if (toolName === "process") {
      const completion = completedProcessResult(event);
      if (!completion) return;
      const pending = state.pendingExecSessions.get(completion.sessionId);
      if (!pending) return;
      state.pendingExecSessions.delete(completion.sessionId);
      if (completion.failed) {
        if (pending.fingerprint) {
          state.failedExec.set(
            pending.fingerprint,
            (state.failedExec.get(pending.fingerprint) ?? 0) + 1
          );
        }
        if (pending.verificationFingerprint) {
          state.failedVerificationAttempts += 1;
          state.latestVerificationStatus = "failed";
        }
      } else {
        if (pending.fingerprint) state.failedExec.delete(pending.fingerprint);
        if (pending.verificationFingerprint) {
          state.failedVerificationAttempts = 0;
          state.latestVerificationStatus = "passed";
        }
      }
      return;
    }
    // A successful file mutation permits another identical command, but does
    // not erase the run-wide failed-verification count. This distinguishes a
    // useful repair cycle from unbounded edit/test churn.
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
    const verificationFingerprint =
      state.verificationOriginalByWrapped.get(observedFingerprint) ??
      verificationExecFingerprint(event?.params);
    if (observedFingerprint) state.execOriginalByWrapped.delete(observedFingerprint);
    if (observedFingerprint) {
      state.verificationOriginalByWrapped.delete(observedFingerprint);
    }
    if (!fingerprint && !verificationFingerprint) return;
    if (verificationFingerprint) {
      state.latestVerificationFingerprint = verificationFingerprint;
    }
    const pendingSessionId = runningExecSessionId(event);
    if (pendingSessionId) {
      if (state.pendingExecSessions.size >= MAX_PENDING_EXEC_SESSIONS) {
        state.codingExhausted = true;
        return;
      }
      state.pendingExecSessions.set(pendingSessionId, {
        fingerprint,
        verificationFingerprint,
      });
      if (verificationFingerprint) state.latestVerificationStatus = "pending";
      return;
    }
    if (execFailed(event)) {
      if (fingerprint) {
        state.failedExec.set(fingerprint, (state.failedExec.get(fingerprint) ?? 0) + 1);
      }
      if (verificationFingerprint) {
        state.failedVerificationAttempts += 1;
        state.latestVerificationStatus = "failed";
      }
    } else {
      if (fingerprint) state.failedExec.delete(fingerprint);
      if (verificationFingerprint) {
        state.failedVerificationAttempts = 0;
        state.latestVerificationStatus = "passed";
      }
    }
  }

  function verificationForRun(runId) {
    if (typeof runId !== "string" || !runId) return { status: "none" };
    const state = runs.get(runId);
    if (!state) return { status: "none" };
    if (state.latestVerificationStatus === "pending") {
      return { status: "pending", text: VERIFICATION_PENDING_DELIVERY_PREFIX };
    }
    if (state.latestVerificationStatus === "failed") {
      return { status: "failed", text: VERIFICATION_FAILED_DELIVERY_PREFIX };
    }
    if (state.githubCanonicalUrl && !state.githubCanonicalSatisfied) {
      return { status: "failed", text: GITHUB_SOURCE_UNVERIFIED_DELIVERY_PREFIX };
    }
    if (state.latestVerificationStatus === "passed") return { status: "passed" };
    return { status: "none" };
  }

  function replyPayloadSending(event) {
    if (event?.kind !== "final") return undefined;
    const verification = verificationForRun(event?.runId);
    const authoritativeText = verification.text;
    if (!authoritativeText) return undefined;
    return {
      payload: {
        ...(event.payload ?? {}),
        text: authoritativeText,
      },
      reason:
        "Pixel replaced an unverified terminal reply with host-authoritative evidence truth.",
    };
  }

  return {
    beforeToolCall,
    afterToolCall,
    replyPayloadSending,
    observeRun,
    abortUserRun,
    verificationForRun,
    verificationStatus: (runId) => runs.get(runId)?.latestVerificationStatus,
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
