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

## OpenClaw 2026.6.33 embedded completion recovery

The shared transcript persistence path also fills gaps in embedded agent
transcripts. It incorrectly ran the CLI post-turn compactor on those embedded
results. In live ODS testing, the model completed its task and published a
verified preview, then this redundant compactor timed out and caused the
OpenAI-compatible endpoint to discard the completed response.

The reviewed `openclaw-completion-recovery.json` transformation limits that
CLI lifecycle call to actual CLI runners. Embedded transcript persistence and
the embedded runner's own context management remain intact; this does not
increase context, output or timeout limits. CLI compaction is unchanged.

This repair has the same exact-byte, version, backup and restore requirements
as the discovery repair. Its separate custody directory is
`.openclaw/ods-runtime-patches/completion-recovery`; pass
`--completion-recovery --restore` to the helper to restore its original bytes.
The transformation includes a small portion of OpenClaw's MIT-licensed agent
command runtime, Copyright (c) 2026 OpenClaw Foundation; see the same complete
[upstream MIT notice](upstream/THIRD_PARTY_NOTICES.md).

## OpenClaw 2026.6.33 Tool Search image results

Tool Search wrapped native screenshot content inside a JSON text block. Large
base64 strings then consumed the model's text context before the normal image
adapter could handle them. The `openclaw-image-envelope.json` transformation
keeps supported text and image blocks in their original order, retains text
and annotations without truncation, and preserves errors and the complete
framework-owned `{tool,result}` payload in `details` for ODS receipts.

Only compact tool identity is added to model-visible text. Unsupported or
malformed content retains the existing serializer; it is not silently dropped.
Model image capabilities and context/output budgets are unchanged. Text-only
models still use the runtime's existing image filtering, while image-capable
models can receive the native image blocks.

The installer applies the exact-byte repair after upstream verification. Its
private backup and receipt use `.openclaw/ods-runtime-patches/image-envelope`;
`--image-envelope --restore` restores the reviewed original without replacing
independent changes. Validation executes code extracted from the reviewed
runtime module and checks byte custody, content preservation and error behavior.
Live browser and model qualification is also required.

The transformation includes a small portion of OpenClaw's MIT-licensed Tool
Search runtime, Copyright (c) 2026 OpenClaw Foundation; the complete license is
retained in the [upstream MIT notice](upstream/THIRD_PARTY_NOTICES.md).
