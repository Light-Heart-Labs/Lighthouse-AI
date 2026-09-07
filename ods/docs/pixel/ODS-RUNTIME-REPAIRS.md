# ODS runtime compatibility repairs

ODS retains the pinned Pixel release and records its own runtime adaptations
separately. These adaptations do not change the upstream release identity.

## OpenClaw 2026.6.33 tool discovery recovery

Two unsuccessful `tool_call` requests could poison later valid requests. The
runtime parsed `Unknown tool id: tool_describe` as a missing tool named `id`,
then checked the prior failure streak without comparing the next target.

The reviewed `openclaw-tool-recovery.json` transformation fixes both behaviors:
it preserves the actual missing ID, including namespace separators, and applies
the missing-tool veto only when that same target is requested again. General
no-progress, polling, and other loop detectors retain their existing limits.

The installer applies this repair after upstream release verification, before
the final gateway restart. It requires the exact original or patched module
SHA-256. A differing 2026.6.33 module is left untouched and reported as an error;
other runtime versions are left untouched as not applicable. Qualification of
other versions remains separate.

Original bytes and a receipt live in the Pixel owner's private directory:
`.openclaw/ods-runtime-patches/tool-recovery`. The helper's `--restore` option
restores the reviewed original and refuses to overwrite unrelated later edits.
Runtime changes take effect on the next gateway restart. A regular ODS reinstall
reapplies the reviewed compatibility repair.

The transformation includes small portions of OpenClaw's MIT-licensed
`src/agents/tool-loop-detection.ts`, distributed in its compiled runtime.
Copyright (c) 2026 OpenClaw Foundation. The complete upstream MIT notice is
retained in [Pixel third-party notices](upstream/THIRD_PARTY_NOTICES.md).

Validation includes execution against the real installed runtime's exported
record/outcome/detect functions, preserving the other detectors, plus separate
backup, idempotence, restore, interrupted-write, and changed-package tests.
These tests do not replace live ODS recovery and fresh-install qualification.
