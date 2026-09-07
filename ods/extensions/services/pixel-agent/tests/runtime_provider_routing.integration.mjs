// Explicit opt-in: starts only a disposable loopback OpenClaw 2026.6.33 gateway.
// Uses synthetic inference, no production config, paid credentials or host tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const pkg = process.env.OPENCLAW_PACKAGE;
const workerPython = process.env.ODS_PROVIDER_WORKER_PYTHON;
for (const workerMode of [false, ...(workerPython ? [true] : [])]) {
test('pinned gateway session/routing contract; private worker=' + workerMode,
  {skip: !pkg, timeout: 300000}, async () => {
    assert.equal(JSON.parse(readFileSync(join(pkg, 'package.json'))).version, '2026.6.33');
    const root = mkdtempSync(join(tmpdir(), 'ods-routing-gateway-'));
    const fixture = join(root, 'lease.json');
    const requests = [];
    let parallelActive = 0, maxParallelActive = 0, releaseParallel;
    const parallelGate = new Promise(r => {releaseParallel = r;});
    const upstream = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push({body, path: req.url, auth: req.headers.authorization});
      const validAuth = workerMode ? req.headers.authorization === 'Bearer fixture-upstream-key'
        : req.headers.authorization?.startsWith('Bearer fixture-lease-chatcmpl_');
      if (req.url !== '/v1/chat/completions' || !validAuth || body.model !== (workerMode ? 'fixture-model' : 'ods/pixel')) {
        res.writeHead(401); res.end(JSON.stringify({error: {message: 'fixture wire contract mismatch'}})); return;
      }
      if (requests.length >= 4) {
        parallelActive++; maxParallelActive = Math.max(maxParallelActive, parallelActive);
        if (parallelActive === 2) releaseParallel();
        await Promise.race([parallelGate, delay(5000)]);
        parallelActive--;
      }
      const first = requests.length === 1;
      const delta = first ? {role: 'assistant', tool_calls: [{index: 0, id: 'witness-call-1',
        type: 'function', function: {name: 'fixture_witness', arguments: '{}'}}]}
        : {role: 'assistant', content: requests.length === 2 ? 'first-turn-complete' : 'second-turn-complete'};
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      res.write('data: ' + JSON.stringify({id: 'fixture-response', object: 'chat.completion.chunk',
        model: 'ods/pixel', choices: [{index: 0, delta, finish_reason: null}]}) + '\n\n');
      res.end('data: ' + JSON.stringify({id: 'fixture-response', object: 'chat.completion.chunk',
        model: 'ods/pixel', choices: [{index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop'}],
        usage: {prompt_tokens: 100, completion_tokens: 10, total_tokens: 110}}) + '\n\ndata: [DONE]\n\n');
    });
    try {
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
    const providerDirectory = join(root, 'providers');
    let workerCommand;
    if (workerMode) {
      const setup = spawnSync(workerPython, ['-I', '-B', fileURLToPath(new URL('./fixtures/provider-lease-config.py', import.meta.url)),
        providerDirectory, baseUrl], {encoding: 'utf8', timeout: 180000,
        env: {PATH: process.env.PATH, ODS_PREPARE_LEASE_RUNTIME: process.env.ODS_PREPARE_LEASE_RUNTIME || '0'}});
      assert.equal(setup.status, 0, setup.stderr);
      const workerPath = process.env.ODS_PREPARE_LEASE_RUNTIME === '1' ? '../../../../bin/ods-pixel-route-lease'
        : '../../../../bin/pixel_provider/route_worker.py';
      workerCommand = [workerPython, '-I', '-B', fileURLToPath(new URL(workerPath, import.meta.url))];
    }
    const saveLease = (revision, refuse = false) => writeFileSync(fixture,
      JSON.stringify({baseUrl, revision, refuse}), {mode: 0o600});
    saveLease(1);
    const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
    const port = portProbe.address().port; await new Promise(r => portProbe.close(r));
    mkdirSync(join(root, 'node_modules')); symlinkSync(resolve(pkg), join(root, 'node_modules/openclaw'));
    const plugin = join(root, 'plugin'); mkdirSync(plugin);
    const original = readFileSync(new URL('./fixtures/provider-routing-gateway.mjs', import.meta.url), 'utf8');
    writeFileSync(join(plugin, 'index.mjs'), original.replaceAll('../../plugin/', './'));
    copyFileSync(fileURLToPath(new URL('../plugin/provider-routing.mjs', import.meta.url)), join(plugin, 'provider-routing.mjs'));
    copyFileSync(fileURLToPath(new URL('../plugin/provider-lease-worker.mjs', import.meta.url)), join(plugin, 'provider-lease-worker.mjs'));
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({name: 'ods-routing-fixture', version: '1.0.0',
      type: 'module', openclaw: {extensions: ['./index.mjs']}}));
    writeFileSync(join(plugin, 'openclaw.plugin.json'), JSON.stringify({id: 'ods-routing-fixture',
      providers: ['ods-policy'], contracts: {tools: ['fixture_witness']}, activation: {onStartup: true},
      configSchema: {type: 'object', properties: {}, additionalProperties: false}}));
    const config = {
      logging: {file: join(root, 'runtime.log')},
      update: {checkOnStart: false},
      gateway: {mode: 'local', port, bind: 'loopback', auth: {mode: 'token', token: 'fixture-gateway-key'},
        http: {endpoints: {chatCompletions: {enabled: true}}}},
      agents: {defaults: {workspace: join(root, 'workspace'), skipBootstrap: true,
        model: {primary: 'ods-policy/managed', fallbacks: []}, contextTokens: 32768, maxConcurrent: 2,
        heartbeat: {every: '0m'}}, list: [{id: 'pixel', default: true}]},
      models: {mode: 'replace', providers: {'ods-policy': {baseUrl: 'http://127.0.0.1:1/v1',
        api: 'openai-completions', apiKey: 'unused-placeholder', models: [{id: 'managed', name: 'ODS managed',
          contextWindow: 32768, maxTokens: 4096, reasoning: false, input: ['text']}]}}},
      tools: {allow: ['fixture_witness']},
      plugins: {allow: ['ods-routing-fixture'], load: {paths: [plugin]},
        entries: {'ods-routing-fixture': {enabled: true, hooks: {allowConversationAccess: true}}}},
    };
    writeFileSync(join(root, 'openclaw.json'), JSON.stringify(config), {mode: 0o600});
    const env = {PATH: process.env.PATH, HOME: root, TMPDIR: root,
      OPENCLAW_STATE_DIR: join(root, 'state'), OPENCLAW_CONFIG_PATH: join(root, 'openclaw.json'),
      XDG_CONFIG_HOME: join(root, 'xdg'), XDG_CACHE_HOME: join(root, 'cache'),
      ODS_ROUTING_FIXTURE: fixture, OPENCLAW_SKIP_CHANNELS: '1'};
    if (workerMode) Object.assign(env, {ODS_LEASE_DIRECTORY: providerDirectory,
      ODS_LEASE_WORKER_COMMAND: JSON.stringify(workerCommand)});
    const child = spawn(process.execPath, [join(pkg, 'openclaw.mjs'), 'gateway', 'run'],
      {env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    let log = ''; child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
    const exit = once(child, 'exit');
    try {
      let ready = false;
      for (let i = 0; i < 200 && child.exitCode === null; i++) {
        try { ready = (await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(500)})).ok; }
        catch { /* bounded startup */ }
        if (ready) break;
        await delay(100);
      }
      assert.ok(ready, log.slice(-8000));
      const chat = async (text, user = 'same-native-session') => {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer fixture-gateway-key'},
          body: JSON.stringify({model: 'openclaw:pixel', user, stream: false,
            messages: [{role: 'user', content: text}]}), signal: AbortSignal.timeout(30000)});
        return {status: res.status, text: await res.text()};
      };
      const first = await chat('Call fixture_witness once, then complete.');
      assert.match(first.text, /first-turn-complete/, log.slice(-8000) + first.text);
      saveLease(2);
      const second = await chat('Continue from the previous witness without calling it again.');
      assert.match(second.text, /second-turn-complete/, log.slice(-8000) + second.text);
      assert.equal(requests.length, 3);
      if (!workerMode) {
        assert.ok(requests.every(r => r.auth.startsWith('Bearer fixture-lease-chatcmpl_') && r.body.model === 'ods/pixel'));
        assert.equal(requests[0].auth, requests[1].auth);
        assert.notEqual(requests[1].auth, requests[2].auth);
      }
      assert.ok(requests[2].body.messages.some(m => m.role === 'tool' && JSON.stringify(m).includes('witness-retained-42')));
      saveLease(3, true);
      const denied = await chat('This must not reach inference.');
      assert.doesNotMatch(denied.text, /second-turn-complete/);
      assert.equal(requests.length, 3);
      const events = readFileSync(fixture + '.events', 'utf8').trim().split('\n').map(JSON.parse);
      const acquired = events.filter(e => e.kind === 'acquire');
      assert.equal(acquired.length, 3);
      assert.equal(new Set(acquired.map(e => e.sessionId)).size, 1);
      assert.equal(new Set(acquired.map(e => e.runId)).size, 3);
      assert.deepEqual(acquired.map(e => e.revision), [1, 2, 3]);
      assert.equal(events.filter(e => e.kind === 'tool').length, 1);
      const readEvents = () => readFileSync(fixture + '.events', 'utf8').trim().split('\n').map(JSON.parse);
      const waitReleases = async count => {
        for (let i = 0; i < 100; i++) {
          if (readEvents().filter(e => e.kind === 'release').length >= count) return;
          await delay(50);
        }
        assert.fail('lease cleanup did not complete');
      };
      await waitReleases(3);
      saveLease(4);
      const parallel = await Promise.all([chat('parallel-alpha', 'session-alpha'), chat('parallel-beta', 'session-beta')]);
      for (const result of parallel) assert.match(result.text, /second-turn-complete/);
      assert.equal(requests.length, 5);
      assert.equal(maxParallelActive, 2, 'must prove overlapping requests, not serialized Promise.all');
      if (!workerMode) assert.notEqual(requests[3].auth, requests[4].auth);
      for (const request of requests.slice(3)) {
        assert.ok(!request.body.messages.some(m => m.role === 'tool'));
      }
      await waitReleases(5);
      const finalEvents = readEvents();
      const runs = finalEvents.filter(e => e.kind === 'acquire');
      assert.equal(runs.length, 5);
      for (const run of runs) assert.equal(finalEvents.filter(e => e.kind === 'release' && e.runId === run.runId).length, 1);
      if (workerMode) {
        const leases = finalEvents.filter(e => e.kind === 'worker-lease');
        assert.equal(leases.length, 4);
        assert.equal(new Set(leases.map(e => e.tokenHash)).size, 4);
        for (const lease of leases) await assert.rejects(fetch(lease.baseUrl + '/models', {signal: AbortSignal.timeout(500)}));
      } else {
        for (const request of requests) assert.ok(runs.some(run => request.auth === 'Bearer fixture-lease-' + run.runId));
      }
      const privateState = join(root, 'state');
      for (const item of readdirSync(privateState, {recursive: true, withFileTypes: true})) {
        if (item.isFile()) {
          const contents = readFileSync(join(item.parentPath, item.name));
          for (const secretPrefix of ['fixture-lease-', 'ods_route_', 'fixture-upstream-key']) {
            assert.ok(!contents.includes(Buffer.from(secretPrefix)), 'credential must not persist in runtime state');
          }
        }
      }
      writeFileSync(join(root, 'result.json'), JSON.stringify({runtime: '2026.6.33', requests: 5,
        nativeSessionCount: 3, turns: 5, toolEffects: 1, deniedWithoutInference: true,
        perRunCredentials: true, maxParallelActive, credentialsNotPersisted: true, privateWorker: workerMode,
        exactReleaseCount: 5, gatewayPid: child.pid}));
      console.log('Evidence:', root);
    } finally {
      writeFileSync(join(root, 'gateway.log'), log, {mode: 0o600});
      writeFileSync(join(root, 'requests.json'), JSON.stringify(requests), {mode: 0o600});
      if (child.exitCode === null) {
        process.kill(-child.pid, 'SIGTERM');
        await Promise.race([exit, delay(3000)]);
        if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
      }
      await exit;
    }
    } finally {
      upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
      console.log('Retained fixture:', root);
    }
  });
}
