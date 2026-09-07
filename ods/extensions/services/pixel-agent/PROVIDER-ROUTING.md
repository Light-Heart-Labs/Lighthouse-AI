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

`provider-lease-worker.mjs` now supplies that private pipe transport. Its trusted
command launches `ods-pixel-route-lease`, which verifies the explicitly prepared
runtime's source/tree/interpreter identity and execs the private Python worker.
No credential enters argv or the environment. This launcher is internal transport,
not an owner-approval or activation endpoint. Never populate its command, directory
or request callback from untrusted chat content or incoming headers.

Each worker holds a random loopback listener and one of two OS-lock slots.
Exclusive, fsynced run-claim directories prevent replay independently of those
live slots. Even a capacity refusal consumes its valid run identity; incomplete
claims after a crash remain denied. Claims are not automatically deleted.
The worker has a bounded initial frame, lifetime deadline and parent-EOF/extra-byte
watchdog. It spawns no tools or child commands, so process death closes its sockets
and releases its locks. Parent transport has redundant bounded termination.

The optional private runtime now includes uvicorn in the same version range as
the sharing service. Existing prepared runtimes with different source identity
require the existing explicitly confirmed repair flow; no global install or
automatic service restart is performed.

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

Set `ODS_PROVIDER_WORKER_PYTHON` to an absolute test Python with the provider
dependencies to additionally exercise actual per-turn Python workers and stored
provider credentials. On the qualified Linux fixture, setting
`ODS_PREPARE_LEASE_RUNTIME=1` explicitly allows a fresh private dependency download
and runs the same journey through the custody-checked launcher. This fixture uses
`/usr/bin/python3.12`; it is not native-platform qualification elsewhere.

Real process tests cover duplicate workers, incomplete claims, unsafe lock files,
capacity denial, supervisor/worker SIGKILL, EOF, extra input, deadlines and
in-flight upstream disconnect followed by replay denial. The bridge's bounded
cache can prune only successfully released entries when its host adapter provides
durable replay protection. Without that adapter, the 256-entry fail-closed bound
remains. Failed/unknown cleanup is never eligible for eviction.

Run the integration test explicitly on POSIX with the exact installed package:

```sh
OPENCLAW_PACKAGE=/absolute/path/to/openclaw node --test \
  extensions/services/pixel-agent/tests/runtime_provider_routing.integration.mjs
```

This is runtime-protocol evidence, not installed ODS/Pixel acceptance, a real
model qualification, production activation, cloud qualification or Full Access.

## Required before normal-chat activation

1. Wire the qualified host worker into installed lifecycle/source custody.
   `agent_end` is best-effort cleanup, not authoritative lifetime control.
   Preserve the independent watchdog and durable claims across gateway restarts.
2. Activation must bind an approved Settings revision, recipients/data scope,
   concrete execution identity and authoritative idle/admission state. Stage,
   verify and restore configuration transactionally without changing ODS_MODE.
3. Test cancellation, gateway/worker crash, stream interruption, real model
   failover, fresh installation and upgrades through the ordinary ODS chat UI.
   Handoff and Full Access retain their separate acceptance requirements.
