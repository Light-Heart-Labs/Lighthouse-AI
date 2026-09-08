// Disposable pinned-gateway fixture only. Never installed as the Pixel plugin.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createProviderRoutingBridge } from '../../plugin/provider-routing.mjs';
import { createLeaseWorkerAdapter } from '../../plugin/provider-lease-worker.mjs';
import { createHandoffOwnerAdapter } from '../../plugin/handoff-owner-worker.mjs';

const file = process.env.ODS_ROUTING_FIXTURE;
const record = (value) => appendFileSync(file + '.events', JSON.stringify(value) + '\n', {mode: 0o600});
const ownerAdapter = process.env.ODS_HANDOFF_OWNER_COMMAND ? createHandoffOwnerAdapter({
  command: JSON.parse(process.env.ODS_HANDOFF_OWNER_COMMAND), directory: process.env.ODS_LEASE_DIRECTORY,
  timeoutSeconds: process.env.ODS_HANDOFF_BROWSER === '1' ? 120 : 60,
}) : null;
const worker = process.env.ODS_LEASE_WORKER_COMMAND ? createLeaseWorkerAdapter({
  command: JSON.parse(process.env.ODS_LEASE_WORKER_COMMAND), directory: process.env.ODS_LEASE_DIRECTORY,
  request: ctx => {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    record({kind: 'owner-request', ...ctx});
    return {expectedRevision: state.refuse && !state.handoff ? 0 : 1,
      confirmed: true, allowCloud: false, timeoutSeconds: process.env.ODS_HANDOFF_BROWSER === '1' ? 180 : 60,
      ...(state.handoff ? {handoffProviderId: 'stronger'} : {})};
  },
}) : null;
const bridge = createProviderRoutingBridge({
  enabled: true,
  durableReplayGuard: !!worker,
  approvalTimeoutMs: process.env.ODS_HANDOFF_BROWSER === '1' ? 120000 : 60000,
  async authorizeHandoff({checkpoint, checkpointDigest, signal}) {
    if (ownerAdapter) {
      const receipt = await ownerAdapter({checkpoint, checkpointDigest, signal});
      record({kind: 'handoff-owner-receipt', runId: checkpoint.runId, sessionId: checkpoint.sessionId,
        approved: receipt?.approved === true, checkpointDigest});
      return receipt;
    }
    // Test-only owner controller: the independent driver reads the preview and
    // approves its digest out of band. Agent text cannot write this receipt.
    writeFileSync(file + '.preview', JSON.stringify({checkpoint, checkpointDigest}), {mode: 0o600});
    for (let i = 0; i < 200 && !signal.aborted; i++) {
      try {
        const receipt = JSON.parse(readFileSync(file + '.approval', 'utf8'));
        if (receipt.checkpointDigest === checkpointDigest) {
          record({kind: 'handoff-owner-receipt', runId: checkpoint.runId, sessionId: checkpoint.sessionId,
            approved: receipt.approved, checkpointDigest});
          return receipt;
        }
      } catch { /* Wait for the fixture owner's explicit decision. */ }
      await delay(25);
    }
    return null;
  },
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
    api.on('before_agent_run', bridge.beforeAgentRun, bridge.beforeAgentRunOptions);
    api.registerTool({name: 'fixture_witness', description: 'Return a fixed qualification witness.',
      parameters: {type: 'object', properties: {}, additionalProperties: false},
      async execute() {
        record({kind: 'tool'});
        return {content: [{type: 'text', text: 'witness-retained-42'}]};
      }});
    api.registerTool({name: 'fixture_handoff_witness', description: 'Perform new work in the approved handoff run.',
      parameters: {type: 'object', properties: {}, additionalProperties: false},
      async execute() {
        record({kind: 'handoff-tool'});
        return {content: [{type: 'text', text: 'handoff-work-retained-73'}]};
      }});
  },
};
