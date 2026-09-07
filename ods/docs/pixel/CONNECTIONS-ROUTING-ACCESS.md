# Pixel connections, provider roles and access modes

Status: development in PR #3818, stacked on ODS PR #3385. The current contracts
and Settings backend do not activate remote inference, cloud failover or Full
Access. The Settings UI and POSIX credential vault are implemented; runtime
activation, sharing/pairing and native-platform storage remain pending.

## Independent settings

- Connections share an inference-only endpoint with another device. Inference
  credentials do not authorize agent execution or model/file administration.
- Provider roles select a leader, ordered availability backups, and explicit
  advisory/handoff escalation. The same provider can serve different roles.
- Access mode governs tools on a named execution host. A remote inference model
  does not move tools to its server or gain additional permissions.

The existing `ods/current`, `local` and `default` aliases, global `ODS_MODE`,
owner model/memory choices and existing installations must remain unchanged
until the owner explicitly activates a compatible Pixel-scoped configuration.
Missing configuration preserves existing behavior; corrupt configuration is an
error, not permission to silently reset to defaults.

## Contracts under development

`bin/pixel_provider/` contains shared Python domain contracts for profile/role
validation, private revisioned persistence and fail-closed activity assessment.
These are host-side building blocks, not an alternate agent or work-provider
authority system. Inference route policy grants no tool or operating-system
privilege. Credentials are represented only by opaque server-side references;
public projections expose credential presence, not references or values.

## Implemented Settings form and backend (not activation)

The owner-authenticated dashboard routes are `GET /api/pixel/providers` and
`POST /api/pixel/providers/save`. Saves accept the exact envelope
`{ "expectedRevision": 0, "document": <complete public configuration>,
"credentialChanges": { <provider id>: { "action": "set", "value": <key> } } }`
and use a
compare-and-swap revision; stale edits return 409. Malformed requests return
400, oversized requests 413, unavailable storage 503. The host-agent paths are
fixed and require its separate owner control credential.

The public document is the same shape returned by GET: providers contain
`hasCredential`, never `credentialRef`. `credentialChanges` is optional; omitted
entries retain keys by the same provider ID under the same revision lock.
`{"action":"remove"}` explicitly detaches a key. Unknown provider IDs and
client-supplied references are rejected. Presence hints never grant or remove
keys. Changing a keyed provider's endpoint or kind requires explicit replacement
or removal; an ID change is a new identity, not an inferred credential transfer.

The Settings form supports profiles, ordered backups, leader/advisor/handoff,
capability/token limits and cloud opt-in. Keys are write-only and cleared at
submission, including on failure. Conflicts and ambiguous write outcomes require
an explicit reload; writes are never automatically retried. System Refresh keeps
unsaved provider edits mounted. No key is put in a URL or browser storage.

Responses distinguish the desired configuration from effective runtime:
`runtime.status` is currently `not-applied`, with reason
`provider-runtime-not-integrated`. No save restarts a model or service, edits
`ODS_MODE`, updates the Pixel pin, or grants filesystem/administrative access.

Host state lives below `ODS_DATA_DIR/pixel-providers/` in an owner-only 0700
directory, with 0600 files. POSIX uses a permanent flock inode, revision checks,
bounded strict JSON, descriptor-relative operations, and fsync/atomic replace.
Unsafe or corrupt existing state fails closed. A post-rename durability failure
is reported as uncertain; it is not falsely described as a successful rollback.
This protects cooperating writers, not against a malicious same-UID process.
Windows returns unsupported until a native ACL/locking adapter is implemented;
the optional module must not prevent the rest of the host agent from starting.

Keys are stored separately as immutable, owner-only files. New key files and
their directory entries are fsynced before the configuration commit. Failures
before commit remove only files created by that transaction; an uncertain
post-commit failure retains them. Old key files remain for recovery after
replacement/deletion until explicit reference-aware collection is implemented.
Detaching a local key does not revoke it at its provider.

`hasCredential` means a reference is configured, not that its key is valid or
passed a provider handshake. Host-only credential resolution checks the exact
revision, custody, size and key contents. Connection verification remains
pending. Do not provision real cloud keys into this draft for runtime use yet.

Activity proof distinguishes busy, idle and unknown and binds observations to
a runtime epoch and freshness interval. Every chat, API, cron and background
run counts. Unknown activity blocks access transitions in either direction.
Live transition integration must prevent new admissions while draining and
must verify effective permissions before showing a confirmed mode.

## Delivery gates

- [ ] Inference-only sharing, pairing, revocation and a real laptop-to-tower task.
- [ ] Authenticated provider Settings and durable migration/rollback.
- [ ] Pixel-scoped runtime route with bounded failure/cancellation handling.
- [ ] Backup after partial progress without repeating completed tool effects.
- [ ] Explicit advisory and leader-handoff escalation with approved data scope.
- [ ] Coordinated Full Access configuration/service/guard transition and restore.
- [ ] Explicit administrative privilege and native-platform adapters.
- [ ] Current-source fresh installs, upgrades and independently verified live
      user journeys on the applicable native OS/backend/client combinations.

Full Access permits whatever the selected OS account can do. Restoring sandbox
policy does not undo host changes, transmitted data or persistence. WSL access
is not proof of Windows Administrator or native desktop control.

## Development validation

Run the focused, service-independent contract tests from `ods/`:

```sh
python3 -m unittest discover -s tests -p 'test_pixel_*.py' -v
```

Dashboard tests use the API's existing runtime and test requirements:

```sh
cd extensions/services/dashboard-api
python3 -m pytest tests/test_pixel_providers.py tests/test_pixel.py tests/test_host_agent_client.py tests/test_settings_env.py tests/test_model_routes.py -q
```

The host tests start only a disposable loopback HTTP fixture, use temporary
private state, and do not install Pixel or change a running fleet service.

Frontend validation uses `npm ci`, `npm test` and `npm run build` in
`extensions/services/dashboard`. The local preview was also exercised against
the actual dashboard router and host-agent in an isolated Linux fixture:
add a provider, select a leader, save, reload and retain the selection. This
proves configuration persistence, not inference or Full Access operation.

These tests are necessary but are not installed-runtime or release acceptance.
