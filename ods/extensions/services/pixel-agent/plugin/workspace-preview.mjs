// Publish one static site from Pixel's workspace through the dedicated,
// loopback-only ODS preview service. The host service independently validates
// and snapshots every byte before returning a browser-verifiable URL.

import net from "node:net";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SOCKET_PATH = "/run/ods-pixel-preview/control.sock";
const PATH_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SITE_ID = /^site-[a-f0-9]{24}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 8192;
const SCAFFOLD_THEMES = new Set(["aurora", "ember", "ocean", "orchid", "solar"]);
const BOUNDARY =
  "Create-only static-site snapshot from the configured Pixel workspace to a dedicated loopback preview origin; no arbitrary host path, network destination, server process, overwrite, or execution authority.";

function validRelativeDirectory(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  const parts = value.split("/");
  return (
    parts.length <= 12 &&
    parts.every(
      (part) => !["", ".", ".."].includes(part) && PATH_COMPONENT.test(part)
    )
  );
}

function normalizedScaffold(value, relativeDirectory) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\n") !== "tagline\ntheme\ntitle" ||
    relativeDirectory.includes("/")
  ) {
    throw new Error("invalid Pixel workspace preview request");
  }
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const tagline = typeof value.tagline === "string" ? value.tagline.trim() : "";
  if (
    !title ||
    title.length > 80 ||
    !tagline ||
    tagline.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(`${title}${tagline}`) ||
    !SCAFFOLD_THEMES.has(value.theme)
  ) {
    throw new Error("invalid Pixel workspace preview request");
  }
  return { title, tagline, theme: value.theme };
}

export function normalizeWorkspacePreviewParams(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["relativeDirectory", "relativeDirectory\nscaffold"].includes(
      Object.keys(value).sort().join("\n")
    ) ||
    !Object.hasOwn(value, "relativeDirectory") ||
    !validRelativeDirectory(value.relativeDirectory)
  ) {
    throw new Error("invalid Pixel workspace preview request");
  }
  const scaffold = normalizedScaffold(value.scaffold, value.relativeDirectory);
  return {
    schemaVersion: 1,
    action: "publish",
    relativeDirectory: value.relativeDirectory,
    ...(scaffold ? { scaffold } : {}),
  };
}

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]
  );
}

function scaffoldHtml({ title, tagline, theme }) {
  const safeTitle = escapeHtml(title);
  const safeTagline = escapeHtml(tagline);
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${safeTitle}</title>
<style>
:root{--hue:272;--a:hsl(var(--hue) 100% 67%);--b:hsl(calc(var(--hue) + 68) 95% 61%);--ink:#f7f5ff;--muted:#aaa5bc;--panel:#14121dcc}*{box-sizing:border-box}html{background:#07060b;color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,sans-serif}body{margin:0;min-height:100vh;overflow-x:hidden;background:radial-gradient(circle at 20% 10%,hsl(var(--hue) 80% 18% / .45),transparent 38%),radial-gradient(circle at 90% 70%,hsl(calc(var(--hue) + 70) 85% 18% / .35),transparent 38%),#07060b}html[data-theme=ember]{--hue:18}html[data-theme=ocean]{--hue:194}html[data-theme=orchid]{--hue:304}html[data-theme=solar]{--hue:48}canvas{position:fixed;inset:0;width:100%;height:100%;opacity:.55;pointer-events:none}.shell{position:relative;z-index:1;max-width:1120px;margin:auto;padding:24px}.nav{display:flex;justify-content:space-between;align-items:center;padding:12px 0}.brand{font-weight:800;letter-spacing:.16em;text-transform:uppercase}.signal{display:flex;gap:8px;align-items:center;color:#8dffbb;font-size:.8rem}.dot{width:8px;height:8px;border-radius:50%;background:#4cff91;box-shadow:0 0 18px #4cff91}.hero{padding:12vh 0 8vh;max-width:850px}.eyebrow{color:var(--a);letter-spacing:.18em;text-transform:uppercase;font-size:.75rem}.hero h1{font-size:clamp(3rem,9vw,7rem);line-height:.88;letter-spacing:-.065em;margin:.2em 0;background:linear-gradient(120deg,#fff 20%,var(--a),var(--b));-webkit-background-clip:text;color:transparent}.hero p{max-width:680px;font-size:clamp(1rem,2vw,1.35rem);color:var(--muted)}button{border:1px solid #ffffff26;color:var(--ink);background:#ffffff0a;border-radius:999px;padding:12px 18px;cursor:pointer;transition:.2s transform,.2s border-color,.2s background}button:hover,button:focus-visible{transform:translateY(-2px);border-color:var(--a);background:#ffffff12;outline:none}.primary{background:linear-gradient(120deg,var(--a),var(--b));color:#08060c;font-weight:800;border:0;box-shadow:0 12px 50px hsl(var(--hue) 100% 55% / .25)}.actions,.themes{display:flex;gap:10px;flex-wrap:wrap;margin-top:28px}.themes button{width:34px;height:34px;padding:0;background:hsl(var(--c) 90% 60%);border:2px solid #fff5}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.card{position:relative;overflow:hidden;min-height:190px;padding:24px;border:1px solid #ffffff18;border-radius:24px;background:linear-gradient(145deg,#ffffff0d,#ffffff04);backdrop-filter:blur(16px);transition:.25s transform,.25s border-color}.card:hover,.card.active{transform:translateY(-7px);border-color:var(--a)}.card b{display:block;font-size:2.2rem}.card span{color:var(--muted)}.meter{height:6px;background:#ffffff12;border-radius:9px;margin-top:24px;overflow:hidden}.meter i{display:block;height:100%;width:18%;background:linear-gradient(90deg,var(--a),var(--b));transition:1s width}.console{display:flex;justify-content:space-between;gap:20px;margin:16px 0 60px;padding:18px 22px;border:1px solid #ffffff14;border-radius:18px;background:var(--panel);color:var(--muted)}#status{color:var(--a)}@media(max-width:720px){.grid{grid-template-columns:1fr}.hero{padding-top:8vh}.console{flex-direction:column}}
</style></head>
<body><canvas id="sky"></canvas><main class="shell"><nav class="nav"><div class="brand">${safeTitle}</div><div class="signal"><i class="dot"></i>LIVE SYSTEM</div></nav><section class="hero"><div class="eyebrow">Interactive field experiment</div><h1>${safeTitle}</h1><p>${safeTagline}</p><div class="actions"><button class="primary" id="launch">Launch sequence</button><button id="shuffle">Shift the spectrum</button></div><div class="themes" aria-label="Color themes"><button data-t="aurora" style="--c:272" aria-label="Aurora"></button><button data-t="ember" style="--c:18" aria-label="Ember"></button><button data-t="ocean" style="--c:194" aria-label="Ocean"></button><button data-t="orchid" style="--c:304" aria-label="Orchid"></button><button data-t="solar" style="--c:48" aria-label="Solar"></button></div></section><section class="grid"><article class="card"><b>01</b><h2>Responsive</h2><span>Fluid type, adaptive layout, and touch-friendly controls.</span><div class="meter"><i></i></div></article><article class="card"><b>02</b><h2>Alive</h2><span>A living canvas reacts while the interface changes around it.</span><div class="meter"><i></i></div></article><article class="card"><b>03</b><h2>Local</h2><span>Self-contained HTML, CSS, and JavaScript. No external calls.</span><div class="meter"><i></i></div></article></section><div class="console"><span>PIXEL / VERIFIED PREVIEW</span><span id="status">Ready for interaction</span></div></main>
<script>
const root=document.documentElement,status=document.querySelector('#status'),bars=[...document.querySelectorAll('.meter i')];document.querySelectorAll('[data-t]').forEach(b=>b.onclick=()=>{root.dataset.theme=b.dataset.t;status.textContent=b.dataset.t.toUpperCase()+' spectrum online'});document.querySelector('#shuffle').onclick=()=>{root.style.setProperty('--hue',Math.floor(Math.random()*360));status.textContent='Spectrum randomized'};document.querySelector('#launch').onclick=e=>{e.currentTarget.textContent='Sequence launched ✓';status.textContent='All interactive systems nominal';bars.forEach((b,i)=>setTimeout(()=>b.style.width=(72+i*12)+'%',i*180))};document.querySelectorAll('.card').forEach(c=>c.onclick=()=>c.classList.toggle('active'));
const c=document.querySelector('#sky'),x=c.getContext('2d'),pts=Array.from({length:70},()=>({x:Math.random(),y:Math.random(),r:Math.random()*1.7+.3,v:Math.random()*.0005+.0001}));function frame(){c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio;x.fillStyle='#fff';pts.forEach(p=>{p.y-=p.v;if(p.y<0)p.y=1;x.globalAlpha=.25+p.r/3;x.beginPath();x.arc(p.x*c.width,p.y*c.height,p.r*devicePixelRatio,0,7);x.fill()});requestAnimationFrame(frame)}frame();
</script></body></html>`;
}

export async function createWorkspaceScaffold(
  { workspaceRoot, relativeDirectory, scaffold },
  { currentUid = () => process.getuid?.() } = {}
) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const canonicalRoot = await realpath(resolvedRoot);
  const rootStat = await lstat(canonicalRoot);
  const uid = currentUid();
  if (
    canonicalRoot !== resolvedRoot ||
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !Number.isInteger(uid) ||
    rootStat.uid !== uid ||
    (rootStat.mode & 0o022) !== 0
  ) {
    throw new Error("unsafe Pixel workspace root");
  }
  const directory = path.join(canonicalRoot, relativeDirectory);
  await mkdir(directory, { mode: 0o700 });
  const canonicalDirectory = await realpath(directory);
  const directoryStat = await lstat(canonicalDirectory);
  if (
    canonicalDirectory !== directory ||
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== uid
  ) {
    throw new Error("unsafe Pixel workspace scaffold directory");
  }
  const entry = path.join(canonicalDirectory, "index.html");
  const flags =
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_WRONLY |
    (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(entry, flags, 0o600);
  try {
    await handle.writeFile(scaffoldHtml(scaffold), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validResponse(value, request) {
  const expectedKeys = [
    "boundary",
    "bytes",
    "entryFile",
    "entrySha256",
    "executable",
    "files",
    "httpStatus",
    "kind",
    "overwritten",
    "port",
    "readbackVerified",
    "relativeDirectory",
    "schemaVersion",
    "sha256",
    "siteId",
    "status",
    "url",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\n") !== expectedKeys.join("\n") ||
    value.schemaVersion !== 1 ||
    value.kind !== "ods-pixel-workspace-preview" ||
    value.status !== "succeeded" ||
    value.relativeDirectory !== request.relativeDirectory ||
    !SITE_ID.test(value.siteId) ||
    typeof value.url !== "string" ||
    value.url !== `http://localhost:${value.port}/${value.siteId}/` ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    !Number.isInteger(value.files) ||
    value.files < 1 ||
    value.files > 128 ||
    !Number.isInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > 16 * 1024 * 1024 ||
    !SHA256.test(value.sha256) ||
    !SHA256.test(value.entrySha256) ||
    value.entryFile !== "index.html" ||
    value.httpStatus !== 200 ||
    value.readbackVerified !== true ||
    value.executable !== false ||
    value.overwritten !== false ||
    value.boundary !== BOUNDARY
  ) {
    throw new Error("invalid Pixel workspace preview response");
  }
  return value;
}

function socketRequest(payload, socketPath = SOCKET_PATH) {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection({ path: socketPath });
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      connection.destroy();
      callback(value);
    };
    connection.setTimeout(30_000);
    connection.on("connect", () => {
      connection.end(`${JSON.stringify(payload)}\n`);
    });
    connection.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        finish(reject, new Error("Pixel workspace preview response is too large"));
        return;
      }
      chunks.push(chunk);
    });
    connection.on("end", () => {
      try {
        const raw = Buffer.concat(chunks, total).toString("utf8");
        if (!raw.endsWith("\n") || raw.slice(0, -1).includes("\n")) {
          throw new Error("invalid Pixel workspace preview framing");
        }
        finish(resolve, JSON.parse(raw.slice(0, -1)));
      } catch (error) {
        finish(reject, error);
      }
    });
    connection.on("timeout", () =>
      finish(reject, new Error("Pixel workspace preview timed out"))
    );
    connection.on("error", (error) => finish(reject, error));
  });
}

function failedResult() {
  return {
    content: [{
      type: "text",
      text:
        "ODS could not publish a verified browser preview. Keep the site files in the workspace, correct the reported file or entry-point problem if one was returned, and do not claim a localhost URL is live.",
    }],
    details: {
      schemaVersion: 1,
      kind: "ods-pixel-workspace-preview",
      status: "failed",
      boundary: BOUNDARY,
    },
    isError: true,
  };
}

export function createWorkspacePreviewTool({
  request = socketRequest,
  scaffold = createWorkspaceScaffold,
  workspaceRoot = path.join(os.homedir(), ".openclaw", "workspace-pixel"),
} = {}) {
  return {
    name: "pixel_ods_workspace_preview",
    description:
      "Publish and verify a static website in Pixel's writable workspace. For an open-ended demo, include scaffold with a short title, tagline, and one theme (aurora, ember, ocean, orchid, or solar); ODS will create a polished interactive create-only index.html before publishing it. For a custom site already written with workspace tools, pass only relativeDirectory. ODS validates and snapshots the files, then returns the only localhost URL Pixel may claim is browser-accessible. Never start a sandbox server.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["relativeDirectory"],
      properties: {
        relativeDirectory: {
          type: "string",
          description:
            "Static-site directory relative to the Pixel workspace; it must contain index.html.",
        },
        scaffold: {
          type: "object",
          additionalProperties: false,
          required: ["title", "tagline", "theme"],
          properties: {
            title: { type: "string", maxLength: 80 },
            tagline: { type: "string", maxLength: 200 },
            theme: {
              type: "string",
              enum: ["aurora", "ember", "ocean", "orchid", "solar"],
            },
          },
        },
      },
    },
    execute: async (_toolCallId, params) => {
      try {
        const normalized = normalizeWorkspacePreviewParams(params);
        if (normalized.scaffold) {
          await scaffold({
            workspaceRoot,
            relativeDirectory: normalized.relativeDirectory,
            scaffold: normalized.scaffold,
          });
        }
        const publishRequest = {
          schemaVersion: normalized.schemaVersion,
          action: normalized.action,
          relativeDirectory: normalized.relativeDirectory,
        };
        const response = validResponse(await request(publishRequest), publishRequest);
        return {
          content: [{
            type: "text",
            text:
              `ODS ${normalized.scaffold ? "created, " : ""}published, and independently read back ${response.files} static files ` +
              `(${response.bytes} bytes). Verified browser URL: ${response.url}`,
          }],
          details: response,
        };
      } catch {
        return failedResult();
      }
    },
  };
}

export const testing = Object.freeze({
  BOUNDARY,
  validRelativeDirectory,
  validResponse,
});
