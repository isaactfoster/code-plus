# Muse

T3 Code drives Meta Muse Code over its native MSP protocol (`muse serve`).
One T3 Muse instance owns one long-lived `muse serve` process; each T3
thread maps to one Muse session, so conversations persist across turns and
resume after server restarts.

Muse only needs to be installed on the T3 server machine. Remote clients —
web, desktop, and mobile — never execute Muse locally.

## Install and authenticate

1. Install the Muse CLI on the machine that runs the T3 server.
2. Authenticate with Muse's own login (Muse uses its installed CLI/account
   state; T3 invents no `META_*` API variables).
3. In T3, open **Settings > Providers**, add a **Muse** instance (off by
   default; opt in), and leave **Binary path** as `muse` unless the binary
   lives elsewhere.

Extra CLI flags go in **Launch arguments** (space-separated, no shell).
Custom environment for the `muse serve` process goes in the instance's
**Environment variables**, like other providers.

## Models

Models come from Muse's native `model/list` — there is no hard-coded list.
Switch models mid-thread; T3 sends `session/setModel` and tracks Muse's
`session/modelChanged` updates.

Where Muse advertises reasoning-effort variants, they appear as the
**Reasoning** option and map to `session/setReasoningEffort`.

## Rate limits

Muse reports subscription usage natively (`usage/read` plus live
`usage/changed` events). T3 shows two generic windows that also render on
stock remote clients:

- **5-hour** — the rolling window (`window.usedPercent`)
- **Weekly** — the weekly window (`weekly.usedPercent`)

Muse allows values above 100%; T3 clamps them at the display boundary so
the contract never breaks. The subscription tier appears in the provider
message when reported.

## Skills

Skills come from Muse's `skill/list` for the active workspace and appear in
T3's slash autocomplete. Selecting one sends a native MSP `skill` turn
input part (including plugin-qualified selectors such as `acme:deploy`),
not plain `/command` text. The list refreshes on `skill/changed`,
workspace changes, and session resume.

## Approvals and input

Muse approval requests (`approval/requested`) and user-input prompts
(`userInput/request`) appear in T3's normal runtime-request UI. Answering
sends `approval/decide` / `userInput/answer` back with the original request
IDs. Nothing is auto-approved unless your T3 policy says so.

Subagents surface through T3's subagent UI; forking uses native
`session/fork`; compaction uses `session/compact`.

## Text generation

Commit messages, PR content, branch names, and thread titles run through a
short-lived isolated Muse helper session on the same host — never through
per-prompt CLI spawns — and the helper session is deleted afterwards.

## Known limitations

- No rollback/rewind: MSP exposes no equivalent, so T3 reports it as
  unsupported rather than faking it.
- Historical token/cost charts (`UsageProviderKind`) do not include Muse
  yet; subscription bars are the supported usage surface. Muse exposes no
  monetary cost figures, so T3 never fabricates them.
- Stock remote clients operate Muse and see rate limits generically; a
  Muse-specific icon or richer presentation may be absent until clients
  update.
