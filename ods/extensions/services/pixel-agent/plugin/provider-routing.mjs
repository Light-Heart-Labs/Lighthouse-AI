// Dormant transport adapter for the pinned OpenClaw provider plugin API.
// Not registered by index.js: activation must supply an owner-approved lease
// adapter and set the agent's default to ods-policy/managed with no fallbacks.
// Hook errors are swallowed by core, so legacy provider defaults are NOT safe.
import { randomUUID } from 'node:crypto';

const PROVIDER = 'ods-policy';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RUN = new RegExp(`^(?:chatcmpl_)?${UUID}$`, 'i');
const UNAVAILABLE = Object.freeze({providerOverride: PROVIDER, modelOverride: 'unavailable'});
const unavailable = () => { throw new Error('ODS provider lease unavailable'); };

function leaseSnapshot(value) {
  const match = typeof value?.baseUrl === 'string' && value.baseUrl.match(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/v1$/);
  if (!match || Number(match[1]) > 65535 || typeof value.token !== 'string' ||
      !/^[\x21-\x7e]{1,4096}$/.test(value.token) ||
      !Number.isSafeInteger(value.contextTokens) || value.contextTokens < 4096 ||
      !Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens < 1 ||
      value.maxOutputTokens > value.contextTokens || typeof value.reasoning !== 'boolean' ||
      typeof value.supportsVision !== 'boolean') throw new Error('Invalid lease');
  return Object.freeze({baseUrl: value.baseUrl, token: value.token,
    contextTokens: value.contextTokens, maxOutputTokens: value.maxOutputTokens,
    reasoning: value.reasoning, supportsVision: value.supportsVision});
}

export function createProviderRoutingBridge({agentId = 'pixel', acquireLease, releaseLease, enabled = false} = {}) {
  const runs = new Map();
  const models = new Map();
  // Prototype bound, no active eviction or replay after release. Installation
  // needs durable lease admission before a long-lived bridge can prune tombstones.
  const MAX_RUNS = 256;
  const binding = ctx => ctx?.agentId === agentId && typeof ctx.runId === 'string' &&
    RUN.test(ctx.runId) && typeof ctx.sessionId === 'string' &&
    ctx.sessionId.length > 0 && ctx.sessionId.length <= 256;
  const live = entry => entry?.state === 'active' && !entry.closed;
  function release(entry) {
    if (!entry.releasePromise) entry.releasePromise = Promise.resolve()
      .then(() => releaseLease({runId: entry.runId, sessionId: entry.sessionId}))
      .catch(() => { /* Keep a closed tombstone; never retry a release implicitly. */ });
    return entry.releasePromise;
  }
  async function beforeModelResolve(_event, ctx) {
    if (enabled !== true) return undefined;
    if (ctx?.agentId && ctx.agentId !== agentId) return undefined;
    try {
      if (!binding(ctx) || typeof acquireLease !== 'function' || typeof releaseLease !== 'function') return UNAVAILABLE;
      let entry = runs.get(ctx.runId);
      if (entry && entry.sessionId !== ctx.sessionId) return UNAVAILABLE;
      if (!entry) {
        if (runs.size >= MAX_RUNS) return UNAVAILABLE;
        entry = {runId: ctx.runId, sessionId: ctx.sessionId, modelId: `turn-${randomUUID()}`,
          state: 'pending', closed: false};
        runs.set(ctx.runId, entry);
        models.set(entry.modelId, entry);
        entry.pending = Promise.resolve()
          .then(() => acquireLease({runId: entry.runId, sessionId: entry.sessionId}))
          .then(async value => {
            const snapshot = leaseSnapshot(value);
            if (entry.closed) { await release(entry); return; }
            entry.lease = snapshot;
            entry.state = 'active';
          }).catch(async () => {
            entry.state = 'failed'; entry.closed = true;
            await release(entry);
          });
      }
      await entry.pending;
      return live(entry) ? {providerOverride: PROVIDER, modelOverride: entry.modelId} : UNAVAILABLE;
    } catch { return UNAVAILABLE; }
  }
  async function agentEnd(_event, ctx) {
    if (enabled !== true || !binding(ctx)) return;
    const entry = runs.get(ctx.runId);
    if (!entry || entry.sessionId !== ctx.sessionId) return;
    entry.closed = true;
    await entry.pending;
    await release(entry);
    entry.lease = undefined;
  }
  const provider = {
    id: PROVIDER, label: 'ODS routing', auth: [],
    resolveSyntheticAuth: () => ({apiKey: 'ods-policy-placeholder', source: 'ods-policy', mode: 'api-key'}),
    async prepareRuntimeAuth(ctx) {
      const entry = models.get(ctx?.modelId);
      if (!live(entry)) return {apiKey: 'ods-policy-unavailable', baseUrl: 'http://127.0.0.1:1/v1'};
      return {apiKey: entry.lease.token, baseUrl: entry.lease.baseUrl};
    },
    resolveDynamicModel(ctx) {
      const entry = models.get(ctx?.modelId);
      const lease = live(entry) ? entry.lease : undefined;
      return {id: ctx?.modelId || 'unavailable', provider: PROVIDER, api: 'openai-completions',
        name: lease ? 'ODS managed turn' : 'ODS unavailable',
        baseUrl: lease?.baseUrl ?? 'http://127.0.0.1:1/v1', reasoning: lease?.reasoning ?? false,
        input: lease?.supportsVision ? ['text', 'image'] : ['text'],
        // Required SDK placeholders, not a displayed estimate of provider prices.
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        contextWindow: lease?.contextTokens ?? 4096, maxTokens: lease?.maxOutputTokens ?? 1};
    },
    wrapStreamFn(ctx) {
      return (model, context, options) => {
        const entry = models.get(ctx?.modelId);
        if (!live(entry) || typeof ctx?.streamFn !== 'function' || options?.signal?.aborted ||
            model?.provider !== PROVIDER || model?.id !== ctx.modelId) return unavailable();
        return ctx.streamFn({...model, id: 'ods/pixel', baseUrl: entry.lease.baseUrl}, context,
          {...options, apiKey: entry.lease.token});
      };
    },
  };
  return {provider, beforeModelResolve, agentEnd};
}
