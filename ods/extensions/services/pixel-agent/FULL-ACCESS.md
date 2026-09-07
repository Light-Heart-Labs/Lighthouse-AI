# Full Access integration status

Pixel's Full Access setting is still under development. This change provides a
POSIX host-side transition controller; it does not add a Settings switch, expose
an endpoint, or enable unsandboxed execution on an installed system.

`host/pixel_access_mode.py` wraps the existing pure configuration helper. Enabling
requires explicit confirmation, a live activity check, configuration validation,
and a caller-supplied service restart with health verification. Restoring the
baseline also requires activity and restart checks. Both operations preserve
unrelated configuration fields. Failed transitions retain recovery evidence or
restore the prior bytes; replaced rollback files and concurrent configuration
changes are detected. These checks do not provide an atomic compare-and-swap
against another process running as the same OS user.

`get_status()` reports configuration and managed state. Its
`runtime_verified: false` field is intentional: configuration and receipts do not
prove what an already running agent is using. The Settings integration must
authenticate the owner, coordinate ingress with transitions, bind the requested
change to the inspected revision, and establish the effective runtime state
before displaying a confirmed mode. It must also wire the matching execution
and cancellation configuration; changing the sandbox field alone is insufficient.

Qualification so far: 51 controller tests passed on the Linux owner account,
including the real installed OpenClaw configuration validator. New tests reproduce
replacement of rollback files, activity races, configuration changes during
restart, and accidental disclosure through CLI diagnostics. Live enable/restore,
Settings UX, installer lifecycle, and other platform qualification remain open.
