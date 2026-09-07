import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createAccessRuntime, executionHostForAgent} from '../plugin/access-runtime.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ods-access-runtime-test-'));
  fs.chmodSync(root, 0o700);
  return {directory: path.join(root, 'runtime'), runtimeVersion: '2026.6.33', hooksAllowed: true};
}
const token = 'a'.repeat(64), other = 'b'.repeat(64);

test('all agent IDs and cron/native turns retain admission until end', () => {
  const runtime = createAccessRuntime(fixture());
  assert.equal(runtime.admit(null, {runId: 'native', agentId: 'another'}).outcome, 'pass');
  assert.equal(runtime.admit(null, {runId: 'cron', agentId: 'pixel', trigger: 'cron'}).outcome, 'pass');
  assert.equal(runtime.status().active, 2);
  assert.throws(() => runtime.acquire(token, runtime.status().revision));
  runtime.finish({}, {runId: 'native'});
  assert.equal(runtime.status().active, 1);
  runtime.finish({runId: 'cron'}, {});
  assert.equal(runtime.status().phase, 'idle');
});

test('held lease blocks new native admission and direct tools', () => {
  const runtime = createAccessRuntime(fixture());
  runtime.acquire(token, runtime.status().revision);
  assert.equal(runtime.admit({}, {runId: 'later'}).outcome, 'block');
  assert.equal(runtime.beforeTool({toolCallId: 'direct'}).block, true);
  assert.throws(() => runtime.release(other));
  assert.equal(runtime.status().phase, 'held');
  runtime.release(token);
  assert.equal(runtime.admit({}, {runId: 'later'}).outcome, 'pass');
});

test('stale revision and missing run identity cannot gain admission', () => {
  const runtime = createAccessRuntime(fixture());
  const old = runtime.status().revision;
  runtime.admit({}, {runId: 'work'}); runtime.finish({}, {runId: 'work'});
  assert.throws(() => runtime.acquire(token, old));
  assert.equal(runtime.admit({}, {}).outcome, 'block');
});

test('direct tools and detached exec keep transition busy after agent end', () => {
  const runtime = createAccessRuntime(fixture());
  runtime.admit({}, {runId: 'work'});
  runtime.beforeTool({toolCallId: 'exec-1'}, {runId: 'work'});
  runtime.afterTool({toolCallId: 'exec-1', toolName: 'exec', result: {details: {status: 'running', sessionId: 'child'}}});
  runtime.finish({}, {runId: 'work'});
  assert.throws(() => runtime.acquire(token, runtime.status().revision));
  runtime.beforeTool({toolCallId: 'poll'});
  runtime.afterTool({toolCallId: 'poll', toolName: 'process', params: {sessionId: 'child'}, result: {details: {status: 'completed'}}});
  assert.equal(runtime.status().phase, 'idle');
});

test('parallel process registration cannot replace the live owner gate', () => {
  const options = fixture(), runtime = createAccessRuntime(options);
  runtime.acquire(token, runtime.status().revision);
  const second = createAccessRuntime(options);
  assert.equal(second.status().available, false);
  assert.equal(runtime.status().phase, 'held');
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.directory, 'state.json'))).phase, 'held');
});

test('held gate survives gateway process restart; busy crash requires recovery', () => {
  for (const phase of ['held', 'busy']) {
    const options = fixture();
    const script = `import {createAccessRuntime} from ${JSON.stringify(new URL('../plugin/access-runtime.mjs', import.meta.url).href)};
      const r=createAccessRuntime(${JSON.stringify(options)});
      ${phase === 'held' ? `r.acquire('${token}',r.status().revision)` : `r.admit({}, {runId:'active'})`};`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'});
    assert.equal(child.status, 0, child.stderr);
    const runtime = createAccessRuntime(options);
    assert.equal(runtime.status().phase, phase === 'held' ? 'held' : 'interrupted');
    assert.equal(runtime.admit({}, {runId: 'new'}).outcome, 'block');
    runtime.acquire(token, runtime.status().revision);
    runtime.release(token);
    assert.equal(runtime.status().phase, 'idle');
  }
});

test('unsafe state directory and malformed state fail closed', () => {
  const options = fixture(); fs.mkdirSync(options.directory, {mode: 0o755});
  // Exercise unsafe permissions even when the test runner uses umask 0077.
  fs.chmodSync(options.directory, 0o755);
  const runtime = createAccessRuntime(options);
  assert.equal(runtime.status().available, false);
  assert.equal(runtime.admit({}, {runId: 'anything'}).outcome, 'block');
});

test('execution cancellation host follows exact loaded agent override', () => {
  const config = {agents: {defaults: {sandbox: {mode: 'all'}}, list: [{id: 'pixel'}]}};
  assert.equal(executionHostForAgent(config), 'sandbox');
  config.agents.list[0] = {id: 'pixel', sandbox: {mode: 'off'}, tools: {exec: {host: 'gateway'}}};
  assert.equal(executionHostForAgent(config), 'gateway');
  config.agents.list[0].tools.exec.host = 'node';
  assert.throws(() => executionHostForAgent(config));
});

test('missing admission permission or an unqualified SDK cannot enable changes', () => {
  for (const overrides of [{hooksAllowed: false}, {runtimeVersion: 'future'}]) {
    const runtime = createAccessRuntime({...fixture(), ...overrides});
    assert.equal(runtime.status().available, false);
    assert.throws(() => runtime.acquire(token, runtime.status().revision));
  }
});
