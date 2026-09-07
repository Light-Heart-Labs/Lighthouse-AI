// One gateway-process admission barrier for every agent, including native/cron
// runs. Decisions and disk commits are synchronous: admission cannot interleave
// with acquiring the transition lease. Never retain hook conversation payloads.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const revision = () => crypto.randomBytes(32).toString('hex');
const blocked = () => ({outcome: 'block', reason: 'ods-access-transition',
  message: 'Pixel access settings are changing. Retry when the transition completes.'});

export function executionHostForAgent(config, id = 'pixel') {
  const agents = config?.agents?.list?.filter(agent => agent?.id === id) ?? [];
  if (agents.length !== 1) throw new Error('Pixel agent configuration is ambiguous');
  const mode = agents[0].sandbox?.mode ?? config.agents?.defaults?.sandbox?.mode ?? 'off';
  const host = agents[0].tools?.exec?.host ?? config.tools?.exec?.host ?? 'sandbox';
  if (mode === 'off' && host === 'gateway') return 'gateway';
  if (mode === 'all' && host === 'sandbox') return 'sandbox';
  throw new Error('Pixel execution mode is unsupported');
}

export function createAccessRuntime({directory = path.join(os.homedir(), '.openclaw', '.ods-access-runtime'),
  config, createTools, resolveSandbox, execControl, runtimeVersion = 'unknown', hooksAllowed = false,
  probeDirectory = path.join('/var/lib/ods-pixel-access-probes', String(process.getuid?.() ?? 'unsupported'))} = {}) {
  if (typeof process.getuid !== 'function') {
    const unavailable = () => { throw new Error('POSIX admission unavailable'); };
    return {status: () => ({available: false, phase: 'unavailable', revision: null, active: 0, proof: null}),
      admit: () => ({outcome: 'pass'}), finish() {}, beforeTool() {}, afterTool() {},
      acquire: unavailable, release: unavailable, probe: unavailable, owns: () => false, isProbe: () => false};
  }
  // Admission coverage was inspected against these exact installed contracts.
  // Other releases keep normal guard behavior, but cannot change access until
  // their hook coverage is qualified. Held state always continues to block.
  const qualified = runtimeVersion === '2026.6.33' && hooksAllowed === true;
  const runs = new Set(), tools = new Set(), detached = new Set();
  const filename = path.join(directory, 'state.json');
  let state, failed = false, probeRun = null, proof = null;
  function privateEntry(target, directoryEntry = false) {
    const s = fs.lstatSync(target);
    if (s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077) ||
        (directoryEntry ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)) throw new Error('unsafe runtime state');
  }
  function save() {
    privateEntry(directory, true);
    const temporary = path.join(directory, `.state-${revision()}`);
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, filename);
      const dir = fs.openSync(directory, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch (error) { failed = true; throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  try {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, {mode: 0o700});
    privateEntry(directory, true);
    const lock = path.join(directory, 'process.json');
    if (fs.existsSync(lock)) {
      privateEntry(lock);
      const previous = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('invalid process lock');
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('another runtime owns admission');
      fs.unlinkSync(lock);
    }
    const lockFd = fs.openSync(lock, 'wx', 0o600);
    try { fs.writeFileSync(lockFd, JSON.stringify({pid: process.pid})); fs.fsyncSync(lockFd); }
    finally { fs.closeSync(lockFd); }
    if (fs.existsSync(filename)) {
      privateEntry(filename);
      if (fs.statSync(filename).size > 4096) throw new Error('oversized runtime state');
      state = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (state.version !== 1 || !hex(state.revision) || !['idle','busy','held','interrupted'].includes(state.phase) ||
          !(state.tokenHash === null || hex(state.tokenHash))) throw new Error('invalid runtime state');
      if (state.phase === 'busy') state.phase = 'interrupted';
    } else state = {version: 1, phase: 'idle', revision: revision(), tokenHash: null};
    // Restart invalidates every previous runtime proof, even at identical config.
    state.revision = revision(); save();
  } catch { failed = true; }
  const busy = () => runs.size + tools.size + detached.size > 0;
  function changed() { state.revision = revision(); save(); }
  function status() {
    return {available: !failed && qualified, phase: failed ? 'unavailable' : state.phase,
      revision: failed ? null : state.revision, active: runs.size + tools.size + detached.size,
      pid: process.pid, runtime_version: runtimeVersion, proof};
  }
  function admit(_event, context) {
    const id = context?.runId;
    if (failed || typeof id !== 'string' || !id || ['held','interrupted'].includes(state.phase)) return blocked();
    runs.add(id); state.phase = 'busy';
    try { changed(); } catch { return blocked(); }
    return {outcome: 'pass'};
  }
  function finish(event, context) {
    runs.delete(context?.runId ?? event?.runId);
    if (!failed && !busy() && state.phase === 'busy') { state.phase = 'idle'; changed(); }
  }
  function beforeTool(event, context) {
    if (context?.runId === probeRun && probeRun !== null) return;
    if (failed || ['held','interrupted'].includes(state.phase)) return {block: true, blockReason: blocked().message};
    // Missing identities cannot be paired safely; fail closed before execution.
    if (!event?.toolCallId) return {block: true, blockReason: 'Tool identity unavailable during access coordination.'};
    tools.add(event.toolCallId); state.phase = 'busy'; changed();
  }
  function afterTool(event, context) {
    if (context?.runId === probeRun && probeRun !== null) return;
    tools.delete(event?.toolCallId);
    const detail = event?.result?.details;
    if (event?.toolName === 'exec' && detail?.status === 'running' && detail.sessionId) detached.add(detail.sessionId);
    if (event?.toolName === 'process' && event?.params?.sessionId &&
        ['completed','failed','exited'].includes(detail?.status)) detached.delete(event.params.sessionId);
    if (!failed && !busy() && state.phase === 'busy') { state.phase = 'idle'; changed(); }
  }
  function acquire(token, expected) {
    if (failed || !qualified || !hex(token) || !hex(expected)) throw new Error('runtime unavailable');
    if (state.phase === 'held' && state.tokenHash === hash(token)) return status();
    if (expected !== state.revision || busy() || !['idle','interrupted'].includes(state.phase)) throw new Error('runtime busy or changed');
    state.phase = 'held'; state.tokenHash = hash(token); proof = null; changed(); return status();
  }
  function owns(token) { return !failed && hex(token) && state.phase === 'held' && state.tokenHash === hash(token); }
  function release(token) {
    if (!owns(token) || busy() || probeRun) throw new Error('runtime lease mismatch');
    state.phase = 'idle'; state.tokenHash = null; changed(); return status();
  }
  async function probe(token) {
    if (!owns(token) || busy() || probeRun) throw new Error('runtime lease mismatch');
    const cfg = config();
    const agent = cfg.agents.list.find(entry => entry.id === 'pixel');
    const workspace = agent.workspace ?? cfg.agents.defaults?.workspace;
    if (!path.isAbsolute(workspace ?? '')) throw new Error('workspace unavailable');
    const executionHost = executionHostForAgent(cfg);
    const model = agent.model ?? cfg.agents.defaults?.model;
    const primary = typeof model === 'string' ? model : model?.primary;
    if (typeof primary !== 'string' || !primary.includes('/')) throw new Error('model policy identity unavailable');
    const modelProvider = primary.slice(0, primary.indexOf('/'));
    const modelId = primary.slice(primary.indexOf('/') + 1);
    const id = crypto.randomUUID(), sessionKey = `agent:pixel:ods-access-proof:${id}`;
    const runId = `ods-access-proof-${id}`;
    // Root provisions this empty owner-private fixture outside home/workspace.
    // Its host path is fixed by UID; callers cannot supply a write destination.
    const outside = probeDirectory;
    privateEntry(outside, true);
    const sentinel = path.join(outside, `sentinel-${id}`);
    const nonce = revision();
    probeRun = runId;
    try {
      const sandbox = await resolveSandbox({config: cfg, sessionKey, workspaceDir: workspace});
      if ((executionHost === 'sandbox') !== Boolean(sandbox?.enabled)) throw new Error('sandbox runtime mismatch');
      const allTools = createTools({config: cfg, agentId: 'pixel', sessionKey, runId, sessionId: id,
        workspaceDir: workspace, cwd: workspace, sandbox, modelProvider, modelId, oneShotCliRun: true});
      const exec = allTools.find(tool => tool.name === 'exec');
      const write = allTools.find(tool => tool.name === 'write');
      if (!exec || !write) throw new Error('required core tools unavailable');
      // These calls use the installed core tool constructors and unchanged
      // loaded policy. They do not request a model or accept arbitrary commands.
      const control = execControl();
      const command = control.prepare(runId, `printf '%s' '${nonce}'`);
      const result = await exec.execute(`proof-exec-${id}`, {command, timeout: 10});
      const text = result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
      if (result?.isError || !text.includes(nonce) || result?.details?.status === 'running') throw new Error('core exec proof failed');
      const cancelledCommand = control.prepare(runId, 'sleep 30');
      let signalFailed = false;
      const timer = setTimeout(() => { try { control.signal(runId); } catch { signalFailed = true; } }, 250);
      let cancelled;
      try { cancelled = await exec.execute(`proof-cancel-${id}`, {command: cancelledCommand, timeout: 10, yieldMs: 10000}); }
      finally { clearTimeout(timer); }
      if (signalFailed || cancelled?.details?.exitCode !== 130) throw new Error('core cancellation proof failed');
      let writeDenied = false;
      try {
        const written = await write.execute(`proof-write-${id}`, {path: sentinel, content: nonce});
        writeDenied = written?.isError === true;
      } catch { writeDenied = true; }
      const present = fs.existsSync(sentinel) && fs.readFileSync(sentinel, 'utf8') === nonce;
      if (executionHost === 'gateway' ? (!present || writeDenied) : (present || !writeDenied)) throw new Error('filesystem boundary proof failed');
      proof = {mode: executionHost === 'gateway' ? 'full-access' : 'sandboxed', pid: process.pid,
        config_sha256: hash(JSON.stringify(cfg)), executed: true, at: new Date().toISOString()};
      return status();
    } finally {
      execControl().clear(runId); probeRun = null;
      // Only the unique directory and sentinel created by this probe.
      if (fs.existsSync(sentinel)) fs.unlinkSync(sentinel);
    }
  }
  return {status, admit, finish, beforeTool, afterTool, acquire, release, probe, owns,
    isProbe: context => probeRun !== null && context?.runId === probeRun};
}
