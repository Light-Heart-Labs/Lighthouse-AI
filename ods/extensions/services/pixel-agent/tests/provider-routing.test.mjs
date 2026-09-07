import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProviderRoutingBridge } from '../plugin/provider-routing.mjs';

const context = () => ({agentId: 'pixel', runId: `chatcmpl_${randomUUID()}`, sessionId: randomUUID()});
const lease = () => ({baseUrl: 'http://127.0.0.1:12345/v1', token: 'test-lease',
  contextTokens: 32768, maxOutputTokens: 4096, reasoning: false, supportsVision: false});
const deferred = () => { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; };
function fixture(options = {}) {
  const acquisitions = [], releases = [];
  const bridge = createProviderRoutingBridge({enabled: true,
    acquireLease: ctx => {acquisitions.push(ctx); return lease();},
    releaseLease: ctx => {releases.push(ctx);}, ...options});
  return {...bridge, acquisitions, releases};
}

test('disabled and other-agent hooks do not acquire; malformed selected contexts fail closed', async () => {
  const f = fixture({enabled: false});
  assert.equal(await f.beforeModelResolve({}, context()), undefined);
  assert.equal(f.acquisitions.length, 0);
  const active = fixture();
  assert.equal(await active.beforeModelResolve({}, {...context(), agentId: 'other'}), undefined);
  for (const ctx of [undefined, {}, {...context(), runId: 'bad'}, {...context(), sessionId: ''}]) {
    assert.equal((await active.beforeModelResolve({}, ctx)).modelOverride, 'unavailable');
  }
  assert.equal(active.acquisitions.length, 0);
});

test('concurrent duplicate hooks await one acquisition and freeze returned data', async () => {
  const gate = deferred(); let calls = 0; const value = lease();
  const f = fixture({acquireLease: () => {calls++; return gate.promise;}});
  const ctx = context();
  const a = f.beforeModelResolve({}, ctx), b = f.beforeModelResolve({}, ctx);
  await Promise.resolve(); assert.equal(calls, 1);
  gate.resolve(value);
  const [one, two] = await Promise.all([a, b]); assert.deepEqual(one, two);
  assert.match(one.modelOverride, /^turn-/);
  value.baseUrl = 'https://changed.invalid/v1'; value.token = 'changed';
  const auth = await f.provider.prepareRuntimeAuth({modelId: one.modelOverride});
  assert.deepEqual(auth, {apiKey: 'test-lease', baseUrl: 'http://127.0.0.1:12345/v1'});
});

test('end during acquisition closes before release, cannot revive or replay', async () => {
  const gate = deferred(); const f = fixture({acquireLease: () => gate.promise});
  const ctx = context(); const start = f.beforeModelResolve({}, ctx);
  const end = f.agentEnd({}, ctx); gate.resolve(lease());
  assert.equal((await start).modelOverride, 'unavailable'); await end;
  await f.agentEnd({}, ctx);
  assert.deepEqual(f.releases, [{runId: ctx.runId, sessionId: ctx.sessionId}]);
  assert.equal((await f.beforeModelResolve({}, ctx)).modelOverride, 'unavailable');
});

test('session mismatch cannot reuse or close another session lease', async () => {
  const f = fixture(), ctx = context(); const selected = await f.beforeModelResolve({}, ctx);
  const foreign = {...ctx, sessionId: randomUUID()};
  assert.equal((await f.beforeModelResolve({}, foreign)).modelOverride, 'unavailable');
  await f.agentEnd({}, foreign); assert.equal(f.releases.length, 0);
  assert.equal((await f.beforeModelResolve({}, ctx)).modelOverride, selected.modelOverride);
});

for (const change of [
  {baseUrl: 'https://example.com/v1'}, {baseUrl: 'http://localhost:1234/v1'},
  {baseUrl: 'http://127.0.0.1:65536/v1'}, {baseUrl: 'http://127.0.0.1:1234/v1?x=1'},
  {token: 'bad\r\nkey'}, {contextTokens: 4000}, {maxOutputTokens: 32769},
  {reasoning: 'false'}, {supportsVision: null},
]) test('invalid lease rejected and released: ' + JSON.stringify(change), async () => {
  let calls = 0; const f = fixture({acquireLease: () => {calls++; return {...lease(), ...change};}}), ctx = context();
  assert.equal((await f.beforeModelResolve({}, ctx)).modelOverride, 'unavailable');
  assert.equal((await f.beforeModelResolve({}, ctx)).modelOverride, 'unavailable');
  assert.equal(calls, 1); assert.equal(f.releases.length, 1);
});

test('sync acquire/release exceptions do not escape swallowed-hook boundary', async () => {
  let calls = 0;
  const f = fixture({acquireLease: () => {calls++; throw new Error('secret');},
    releaseLease: () => {throw new Error('secret');}}), ctx = context();
  assert.equal((await f.beforeModelResolve({}, ctx)).modelOverride, 'unavailable');
  await f.agentEnd({}, ctx);
  assert.equal((await f.beforeModelResolve({}, ctx)).modelOverride, 'unavailable');
  assert.equal(calls, 1);
});

test('stream wrapper preserves context/tools/options and runtime EventStream identity', async () => {
  const f = fixture(), ctx = context(); const selected = await f.beforeModelResolve({}, ctx);
  const model = f.provider.resolveDynamicModel({modelId: selected.modelOverride});
  const payload = {messages: [{role: 'tool', content: 'completed'}], tools: [{name: 'witness'}]};
  const options = {signal: new AbortController().signal, apiKey: 'placeholder', temperature: 0.4};
  const stream = {}; let count = 0;
  const wrapped = f.provider.wrapStreamFn({modelId: selected.modelOverride, streamFn: (m, c, o) => {
    count++; assert.equal(c, payload); assert.equal(o.signal, options.signal);
    assert.equal(o.temperature, 0.4); assert.equal(o.apiKey, 'test-lease');
    assert.equal(m.id, 'ods/pixel'); assert.equal(m.baseUrl, lease().baseUrl); return stream;
  }});
  assert.equal(wrapped(model, payload, options), stream);
  assert.equal(model.id, selected.modelOverride); assert.equal(options.apiKey, 'placeholder');
  assert.throws(() => wrapped({...model, id: 'foreign'}, payload, options), /unavailable/);
  assert.throws(() => wrapped(model, payload, {...options, signal: AbortSignal.abort()}), /unavailable/);
  await f.agentEnd({}, ctx); assert.throws(() => wrapped(model, payload, options), /unavailable/);
  assert.equal(count, 1);
  assert.deepEqual(await f.provider.prepareRuntimeAuth({modelId: selected.modelOverride}),
    {apiKey: 'ods-policy-unavailable', baseUrl: 'http://127.0.0.1:1/v1'});
});

test('unknown models and capacity pressure cannot evict active leases', async () => {
  const f = fixture(); let first;
  for (let i = 0; i < 256; i++) {
    const selected = await f.beforeModelResolve({}, context());
    assert.notEqual(selected.modelOverride, 'unavailable'); first ??= selected;
  }
  assert.equal((await f.beforeModelResolve({}, context())).modelOverride, 'unavailable');
  assert.equal(f.acquisitions.length, 256);
  assert.equal(f.provider.resolveDynamicModel({modelId: first.modelOverride}).maxTokens, 4096);
  const wrapped = f.provider.wrapStreamFn({modelId: 'unknown', streamFn: () => assert.fail('unexpected IO')});
  assert.throws(() => wrapped({}, {}, {}), /unavailable/);
});

test('durable host claims allow closed-entry pruning but still deny replay', async () => {
  const claims = new Set();
  const f = fixture({durableReplayGuard: true, acquireLease: ({runId}) => {
    if (claims.has(runId)) throw new Error('durable replay denial');
    claims.add(runId); return lease();
  }});
  const first = context();
  for (let i = 0; i < 270; i++) {
    const ctx = i === 0 ? first : context();
    assert.notEqual((await f.beforeModelResolve({}, ctx)).modelOverride, 'unavailable');
    await f.agentEnd({}, ctx);
  }
  assert.equal(claims.size, 270);
  assert.equal((await f.beforeModelResolve({}, first)).modelOverride, 'unavailable');
  assert.equal(claims.size, 270);
});

test('failed release is never eligible for eviction even with durable admission', async () => {
  const f = fixture({durableReplayGuard: true, releaseLease: () => {throw new Error('cleanup unknown');}});
  for (let i = 0; i < 256; i++) {
    const ctx = context(); await f.beforeModelResolve({}, ctx); await f.agentEnd({}, ctx);
  }
  assert.equal((await f.beforeModelResolve({}, context())).modelOverride, 'unavailable');
});
