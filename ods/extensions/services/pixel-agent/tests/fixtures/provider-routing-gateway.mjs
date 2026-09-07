// Disposable pinned-gateway fixture only. Never installed as the Pixel plugin.
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createProviderRoutingBridge } from '../../plugin/provider-routing.mjs';
import { createLeaseWorkerAdapter } from '../../plugin/provider-lease-worker.mjs';

const file = process.env.ODS_ROUTING_FIXTURE;
const record = (value) => appendFileSync(file + '.events', JSON.stringify(value) + '\n', {mode: 0o600});
const worker = process.env.ODS_LEASE_WORKER_COMMAND ? createLeaseWorkerAdapter({
  command: JSON.parse(process.env.ODS_LEASE_WORKER_COMMAND), directory: process.env.ODS_LEASE_DIRECTORY,
  request: () => ({expectedRevision: JSON.parse(readFileSync(file, 'utf8')).refuse ? 0 : 1,
    confirmed: true, allowCloud: false, timeoutSeconds: 60}),
}) : null;
const bridge = createProviderRoutingBridge({
  enabled: true,
  durableReplayGuard: !!worker,
  async acquireLease(ctx) {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    record({kind: 'acquire', ...ctx, revision: config.revision});
    if (worker) {
      const lease = await worker.acquireLease(ctx);
      record({kind: 'worker-lease', runId: ctx.runId, baseUrl: lease.baseUrl,
        tokenHash: createHash('sha256').update(lease.token).digest('hex')});
      return lease;
    }
    if (config.refuse) throw new Error('fixture refusal');
    return {baseUrl: config.baseUrl, token: 'fixture-lease-' + ctx.runId, contextTokens: 32768,
      maxOutputTokens: 4096, reasoning: false, supportsVision: false};
  },
  async releaseLease(ctx) { if (worker) await worker.releaseLease(ctx); record({kind: 'release', ...ctx}); },
});

export default {
  id: 'ods-routing-fixture',
  name: 'Disposable ODS routing qualification',
  register(api) {
    api.registerProvider(bridge.provider);
    api.on('before_model_resolve', async (event, ctx) => {
      const result = await bridge.beforeModelResolve(event, ctx);
      record({kind: 'selection', runId: ctx.runId, sessionId: ctx.sessionId, ...result});
      return result;
    });
    api.on('agent_end', bridge.agentEnd);
    api.registerTool({name: 'fixture_witness', description: 'Return a fixed qualification witness.',
      parameters: {type: 'object', properties: {}, additionalProperties: false},
      async execute() {
        record({kind: 'tool'});
        return {content: [{type: 'text', text: 'witness-retained-42'}]};
      }});
  },
};
