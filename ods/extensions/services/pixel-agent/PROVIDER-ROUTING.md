# Managed provider adapter: experimental, not activated

`plugin/provider-routing.mjs` implements the supported provider/hook interface
of ODS's pinned OpenClaw 2026.6.33. It is deliberately not registered by the
production plugin entrypoint. Saved Settings remain `not-applied` to normal chat.

The adapter freezes one host-supplied loopback lease per run/session binding.
Duplicate selection hooks await the same acquisition. It uses a unique model
reference for each run so model resolution, runtime-auth preparation and stream
wrapping all select the same lease without a mutable global current provider.
The outgoing wire model is `ods/pixel`; context, tool results and permissions
remain owned by the existing agent. No new agent/session is spawned per call.
Only short-lived loopback credentials enter runtime memory; upstream provider
credentials must remain with the host lease worker.

## Findings from the actual pinned gateway

- HTTP chat run IDs have a `chatcmpl_` prefix; local agent runs may use UUIDs.
- Core catches selection-hook errors and continues. A thrown exception is not
  a routing denial. Managed activation must set `ods-policy/managed` as primary,
  remove native fallback routes, and retain an unavailable default endpoint.
- Setting stream `options.apiKey` alone does not replace prepared runtime auth.
  `prepareRuntimeAuth` must resolve the exact same model-bound lease.
- Non-bundled hooks require explicit conversation-access configuration and tools
  require manifest declarations. These grants are not implied by installing a file.

## Evidence and limits

Unit tests cover binding, duplicate acquisition, invalid leases, pending-release
races, frozen snapshots, cancellation before IO and closed-route refusal.
The opt-in `runtime_provider_routing.integration.mjs` test starts a private
loopback gateway with a synthetic inference server and a harmless fixture tool.
It verifies native session/tool-history continuity, changed revisions on new
turns, denial without inference, overlapping per-run credentials, release counts
and absence of lease credentials in persisted runtime state. It retains evidence
under a unique temporary directory and stops only its own process group.

Run the integration test explicitly on POSIX with the exact installed package:

```sh
OPENCLAW_PACKAGE=/absolute/path/to/openclaw node --test \
  extensions/services/pixel-agent/tests/runtime_provider_routing.integration.mjs
```

This is runtime-protocol evidence, not installed ODS/Pixel acceptance, a real
model qualification, production activation, cloud qualification or Full Access.

## Required before normal-chat activation

1. A private host lease worker must reuse the existing frozen provider policy,
   own durable run claims, deadlines and cancellation, and reap on gateway loss.
   `agent_end` is best-effort cleanup, not authoritative lifetime control.
2. This prototype retains at most 256 run tombstones and then denies new work.
   Do not install it as a long-lived service. Durable replay denial and bounded
   pruning must be implemented together; never evict a live lease to admit work.
3. Activation must bind an approved Settings revision, recipients/data scope,
   concrete execution identity and authoritative idle/admission state. Stage,
   verify and restore configuration transactionally without changing ODS_MODE.
4. Test cancellation, gateway/worker crash, stream interruption, real model
   failover, fresh installation and upgrades through the ordinary ODS chat UI.
   Handoff and Full Access retain their separate acceptance requirements.
