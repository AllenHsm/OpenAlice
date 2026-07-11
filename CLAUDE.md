# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# OpenAlice

File-driven AI trading agent. All state (sessions, config, logs) stored as files — no database.

This is a **pnpm + Turborepo monorepo**: the backend lives in `src/` (composition root: `src/main.ts`), the React frontend in `ui/` (Vite, separate `package.json`), and shared TypeScript packages in `packages/` (`@traderalice/ibkr`, `@traderalice/opentypebb`). The `predev` and `prebuild` scripts use Turbo to build the workspace packages before backend startup — adding a new package means adding it to the `predev` filter in `package.json`.

## Quick Start

```bash
pnpm install
pnpm dev              # Dev mode (tsx watch src/main.ts, port 3002)
pnpm dev:ui           # UI dev server (pnpm --filter open-alice-ui dev)
pnpm build            # Production build (turbo run build + tsup bundle)
pnpm test             # Vitest unit tests
pnpm test:watch       # Vitest in watch mode
pnpm test:e2e         # End-to-end (vitest.e2e.config.ts)
pnpm test:bbProvider  # OpenBB provider integration tests (vitest.bbProvider.config.ts)
```

Run a single test file: `pnpm vitest run path/to/file.spec.ts` (or `... -t "test name"` to filter).

### Pre-commit Verification

Always run these checks before committing:

```bash
npx tsc --noEmit   # Type check (catches errors pnpm build misses)
pnpm test           # Unit tests
```

`pnpm build` uses tsup which is lenient — `tsc --noEmit` catches strict type errors that tsup ignores.

### Cross-platform note

Workspace bootstrap scripts (`src/workspaces/templates/*/bootstrap.sh`) are bash-based. On Windows they require `bash` from Git for Windows (default install) or WSL2. `workspace-creator.ts` already platform-branches the spawn so the same script paths work on win32 — when adding a new template, write bash as usual, but **don't** add POSIX-only commands without checking they ship with Git for Windows's bundled MSYS env (sed/cp/mkdir/basename/printf/source/[[ ]] all work; obscure tools like `jq` do not). See README's *Windows* section for the user-facing story.

## Subsystem guides

Some parts of this codebase are structured in ways that aren't obvious from
the code alone — easy to touch superficially, easy to miss load-bearing
wiring. When working on one of these, read its guide first:

- **Event / Listener / Producer system** — [docs/event-system.md](docs/event-system.md).
  Read before adding a new event type, Listener, or Producer, or before
  opening an event to HTTP via the webhook ingest. Has recipes + the full
  list of files to touch for each kind of change, plus a "common pitfalls"
  section for the kinds of things AI sessions have historically half-done.

## Working with TODO.md

`TODO.md` at the repo root is the running backlog — deferred work, known
bugs, security gaps, and design items sitting in the on-deck circle.
Unfinished items there compound over time if they're forgotten.

- **Before starting non-trivial work**, scan `TODO.md` for related entries.
  If there's one, either (a) handle it as part of the current change, or
  (b) confirm with the user why you're skipping it so it doesn't drift.
- **When finishing a change**, if it resolves a TODO entry, delete that
  entry in the same commit (git log is the history — the file is a
  future-looking list, not an audit trail).
- **When a new item surfaces mid-work** — a known-broken behaviour you
  don't have scope to fix, a security concern, a half-done UI surface —
  add it with enough context (symptom + suspected location) that the
  next person can start without re-derivation.

## Working with README.md

`README.md` is the public-facing positioning artifact. It accumulates
debt fast because day-to-day changes rarely feel "README-worthy"
individually — but a quarter's worth of small shifts can leave the
README narrating an obsolete mental model. The right time to audit is
**right after** a large-scale change ships, while context is fresh.

- **After finishing a large-scale change**, scan the README for sections
  that still describe the pre-change state. "Large-scale" means: a new
  top-level concept landed (e.g. Workspace, Inbox); a module was
  retired (e.g. Brain); an existing layer's responsibilities reshaped
  (e.g. Automation split into scheduling + execution); a generation
  version bump. Bug fixes, refactors that don't change user-facing
  surface, and internal renames do **not** trigger an audit.
- **Before making any README edits, ask the user how to frame the
  changes** — the README is product positioning, not just docs.
  Framing decisions ("is Automation legacy or is it reframed into two
  layers?", "is Brain retired or trimmed?") belong to the user, not to
  the AI. Present what you'd propose to change, get direction, then
  edit.
- **Don't churn marketing copy** — the three pillars, the tagline,
  the hero — leave alone unless the user explicitly opens that
  conversation. Frequent reframing of top-of-funnel copy is worse
  than slightly-stale-but-consistent copy.

## Migrations

`data/config/` and other persisted user state evolve across releases.
Any upgrade-time transformation of user data — schema changes, file
renames, orphan cleanup, value backfills — MUST go through the
migration framework at `src/migrations/`, not ad-hoc startup code.

- New migrations live at `src/migrations/NNNN_short_name/index.ts` with
  a sibling spec. Append to `src/migrations/registry.ts`, then
  `pnpm build:migration-index` regenerates `src/migrations/INDEX.md`.
- Idempotency is enforced at two layers: the journal in
  `data/config/_meta.json` and the in-body self-check. Each migration
  body must no-op when data is already at the target shape.
- For files outside `data/config/` (e.g. `data/cron/jobs.json`,
  `data/sessions/`), the migration body uses raw `fs/promises` — the
  `ctx` helpers are config-scoped. Declare the affected paths in
  `affects` for `INDEX.md` surfacing.
- Past failure to avoid: inline one-time cleanup loops in `src/main.ts`
  or subsystem bootstrap. They are easy to call against unloaded state
  and silently no-op forever — a real incident left the cron engine
  firing orphan `__snapshot__` / `__heartbeat__` jobs every 15 min for
  weeks before anyone noticed.

## Project Structure

For a fuller per-file breakdown, see [docs/project-structure.md](docs/project-structure.md). The high-level layout:

```
packages/                  # Workspace packages (built by turbo before backend start)
├── ibkr/                  # @traderalice/ibkr — IBKR TWS API TypeScript port
└── opentypebb/            # @traderalice/opentypebb — OpenBB platform TS port

ui/                        # React frontend (Vite, separate package.json)

src/
├── main.ts                # Composition root
├── core/                  # AgentCenter, ai-provider-manager, ToolCenter, session,
│                          # compaction, config, connector-center, media,
│                          # event-bus + listener/producer/pump (the event system),
│                          # agent-work / agent-work-listener, inbox-store,
│                          # notifications-store, tool-call-log, mcp-export
├── ai-providers/
│   ├── vercel-ai-sdk/     # Vercel AI SDK ToolLoopAgent
│   ├── agent-sdk/         # Claude backend (@anthropic-ai/claude-agent-sdk, OAuth + API key)
│   ├── codex/             # OpenAI Codex backend
│   └── mock/              # Test provider
├── domain/
│   ├── trading/           # Unified multi-account trading, guards, git-like commits
│   │   └── brokers/       # registry.ts + alpaca / ccxt / ibkr / mock
│   ├── market-data/       # equity / crypto / currency / commodity / economy + client/
│   ├── analysis/          # Indicators, technical analysis
│   ├── news/              # RSS collector + archive search
│   └── thinking/          # Safe expression evaluator
├── tool/                  # AI tool definitions — thin bridge from domain to ToolCenter
│                          # (trading, equity, market, analysis, news, thinking,
│                          #  session, economy, inbox-push, notify-user)
├── server/                # mcp.ts (MCP protocol server) + opentypebb.ts (embedded HTTP API)
├── connectors/            # web / telegram / mcp-ask / mock (push channels)
├── webui/                 # Hono routes serving the React UI + workspaces WS bridge
├── workspaces/            # Long-running agent workspaces — session pool, pty adapters,
│                          # template registry, git/file services, scrollback store,
│                          # transcript watcher, bash-based templates/
├── task/                  # cron / heartbeat / metrics
└── migrations/            # Numbered NNNN_short_name/ directories + registry.ts
```

Note: `src/domain/brain/` has been retired (migration `0006_retire_brain`). MCP server lives at `src/server/mcp.ts` (was `src/plugins/mcp.ts`).

## Key Architecture

### AgentCenter → GenerateRouter → GenerateProvider

Two layers (Engine was removed):

1. **AgentCenter** (`core/agent-center.ts`) — top-level orchestration. Manages sessions, compaction, and routes calls through GenerateRouter. Exposes `ask()` (stateless) and `askWithSession()` (with history).

2. **GenerateRouter** (`core/ai-provider-manager.ts`) — reads `ai-provider.json` on each call, resolves to active provider. Two backends:
   - Agent SDK (`inputKind: 'text'`) — Claude via @anthropic-ai/claude-agent-sdk, tools via in-process MCP
   - Vercel AI SDK (`inputKind: 'messages'`) — direct API calls, tools via Vercel tool system

**AIProvider interface**: `ask(prompt)` for one-shot, `generate(input, opts)` for streaming `ProviderEvent` (tool_use / tool_result / text / done). Optional `compact()` for provider-native compaction.

**StreamableResult**: dual interface — `PromiseLike` (await for result) + `AsyncIterable` (for-await for streaming). Multiple consumers each get independent cursors.

Per-request provider and model overrides via `AskOptions.provider` and `AskOptions.vercelAiSdk` / `AskOptions.agentSdk`.

### ConnectorCenter

`connector-center.ts` manages push channels (Web, Telegram, MCP Ask). Tracks last-interacted channel for delivery routing.

### ToolCenter

Centralized registry. `tool/` files register tools via `ToolCenter.register()`, exports in Vercel and MCP formats. Decoupled from AgentCenter.

### Event system (Listener / Producer / Pump)

`core/event-bus.ts` + `core/listener.ts` + `core/producer.ts` + `core/pump.ts` + `core/listener-registry.ts` form an in-process pub/sub. **Always read [docs/event-system.md](docs/event-system.md) before touching any of those files or adding a new event type, Listener, or Producer** — the wiring requires touching multiple registries and has a documented set of pitfalls.

### Workspaces subsystem

`src/workspaces/` runs long-lived agent sandboxes (each its own pty + git working tree + scrollback). The session pool, registries, pty adapters, and bash templates all live here. The `webui/workspaces-ws.ts` WebSocket bridges browser UI to live workspace sessions. Templates under `src/workspaces/templates/*/bootstrap.sh` are cross-platform-bash (see the *Cross-platform note* at the top).

## Conventions

- ESM only (`.js` extensions in imports), path alias `@/*` → `./src/*`
- Strict TypeScript, ES2023 target
- Zod for config, TypeBox for tool parameter schemas
- `decimal.js` for financial math
- Pino logger → `logs/engine.log`

## Git Workflow

- `origin` = `TraderAlice/OpenAlice` (production)
- `dev` branch for all development, `master` only via PR
- **Never** force push master, **never** push `archive/dev` (contains old API keys)
- CLAUDE.md is **committed to the repo and publicly visible** — never put API keys, personal paths, or sensitive information in it

### Branch Safety Rules

- **NEVER delete `dev` or `master` branches** — both are protected on GitHub (`allow_deletions: false`, `allow_force_pushes: false`)
- When merging PRs, **NEVER use `--delete-branch`** — it deletes the source branch and destroys commit history
- When merging PRs, **prefer `--merge` over `--squash`** — squash destroys individual commit history. If the PR has clean, meaningful commits, merge them as-is
- If squash is needed (messy history), do it — but never combine with `--delete-branch`
- `archive/dev-pre-beta6` is a historical snapshot — do not modify or delete
- **After merging a PR**, always `git pull origin master` to sync local master. Stale local master causes confusion about what's merged and what's not.
- **Before creating a PR**, always `git fetch origin master` to check what's already merged. Use `git log --oneline origin/master..HEAD` to verify only the intended commits are ahead. Stale local refs cause PRs with wrong diff.

### Rolling dev → master PR convention

Multiple Claude sessions hit `dev` in parallel; GitHub allows only **one
open PR per (head, base) pair** anyway. So we keep a single rolling PR
from `dev → master` and **append** to its body each session instead of
opening fresh — otherwise each new PR loses the context of what other
sessions did.

**Before opening a new PR, always check first:**

```bash
gh pr list --base master --head dev --state open --json number,title,body
```

- **If a PR exists** → append your section to its body with
  `gh pr edit <num> --body-file <(...)`. Don't open a new one.
- **If none exists** → open with `gh pr create` using the template below.

**PR body template:**

```markdown
## Summary
<rolling thematic summary — latest session may rewrite this when new
work meaningfully shifts the PR's framing>

## Per-session contributions
### YYYY-MM-DD — <session theme, e.g. "Market workbench tradeable card">
- What changed (1–3 bullets)
- Why
- Key commits: `<sha-short>`, `<sha-short>`

### YYYY-MM-DD — <prior session theme>
…(append on top, keep prior sessions verbatim — never edit other sessions' entries)…

## Full commit log
<output of: git log --oneline origin/master..HEAD>
(regenerate from scratch on each body update)

## Test plan
- [ ] tsc --noEmit clean
- [ ] pnpm test passes
- [ ] (session-specific manual verifications)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**When you append:**

1. Refresh the "Full commit log" section from `git log --oneline origin/master..HEAD`.
2. Add your "Per-session contributions" entry on top of the list, with today's date.
3. Don't edit other sessions' entries — that's their record.
4. Update "Summary" only if your work actually changes the PR's framing
   (e.g., what was a "frontend tweak" PR becomes a "frontend + new domain
   service" PR after your work).

This keeps the PR description as a faithful audit trail across sessions,
and lets reviewers see who-did-what without trawling the commit log alone.

### Default vs. isolated branch — when to deviate from `dev`

The default for any session is **work on `dev`** and let the rolling
PR carry it to master. The exception is **invasive, long-running work
that shouldn't share a branch with parallel sessions** — typically a
refactor of shared types / cross-cutting infrastructure that, while
in-flight, would force every other session to rebase against churn
they don't have context for.

Examples worth isolating: changing a base interface every broker
implements; renaming or restructuring a module everyone imports from;
multi-day schema migrations.
Examples that stay on `dev`: any feature, any local fix, anything
scoped to one subsystem.

When isolation is the right call:

```bash
# Branch from master (clean baseline, dev's churn won't bleed in)
git fetch origin
git checkout master
git pull origin master
git checkout -b refactor/<short-name>

# During the refactor, periodically rebase against master so the
# eventual merge stays small. Skip dev — its session-by-session
# churn is intentionally not part of the baseline you're testing
# against.
git fetch origin
git rebase origin/master

# When done, PR straight to master (NOT dev). The refactor is its own
# coherent unit, reviewed end-to-end.
git push -u origin refactor/<short-name>
gh pr create --base master --head refactor/<short-name> ...
```

**After the refactor merges**, dev needs to absorb the new master so
in-flight sessions land on the new baseline:

```bash
git checkout dev
git pull origin dev
git fetch origin
git merge origin/master
git push origin dev
```

In-flight rolling-PR work then sees the refactor in their next pull
and rebases naturally. Their diffs against the refreshed `dev` may
need real fix-ups (that's the cost of an invasive refactor — and
the reason you isolated it in the first place).

**Decision rule for the next session that starts work:** if `master`
is currently ahead of `dev`, do `git checkout dev && git merge origin/master`
*before* starting any new feature work. Otherwise your new commits
will land on a stale baseline.

Common reasons `master` would be ahead of `dev`:
- An invasive refactor branch just landed (above flow).
- A Claude Code cloud session opened a `claude/<short-desc>-XXXXX`
  branch and merged it straight to master without going through `dev`
  — typically for a time-sensitive fix the cloud agent shipped while
  the human wasn't around (see next subsection).

When the side-channel was content-bearing (not just a refactor) **dev
is genuinely behind master in code**, not just in merge-commit objects.
Skipping the sync lands new dev commits on stale code.

One quirk to recognize: a single `git merge origin/master` into dev
often surfaces a Discord/webhook notification like *"N new commits on
dev"* where N is much larger than what the side branch actually added.
Most of those N are **historical PR-merge commits** that have been
accumulating on master for weeks (each dev → master PR creates a
merge commit that exists only on master). The sync drags them onto
dev in one go. The webhook reports commit-object count, not
content-delta. Expected, not a sign anything's broken.

### Emergency hotfix via cloud `claude/*` side branch

A Claude Code cloud session can open a branch named
`claude/<short-desc>-XXXXX`, PR straight to master, and merge it
without touching `dev`. This is the right move for **genuine
emergencies** the user isn't around to handle on dev (a runtime
error blocking users, a CORS misconfiguration, a hotfix that can't
wait for the next dev → master cycle). The cloud session uses it
because:

- Cloud sessions don't see in-flight local dev state and shouldn't
  destabilize it
- The fix is small and reviewable in isolation
- Waiting for the user to bounce dev for a hotfix is silly when the
  cloud agent already has a working tree

**What this means for the next local session:**

1. `git fetch origin && git log --oneline origin/dev..origin/master`
   shows commits master has that dev doesn't — if there's anything
   from a `claude/*` branch, dev needs the sync.
2. `git checkout dev && git merge origin/master && git push origin dev`
   (clean FF in typical case).
3. Resume normal work on dev.

**What this means for the cloud session deciding whether to side-branch:**
default to opening a dev → master PR like everyone else. Only branch
straight to master for fixes that meet *both*: (a) production-impacting
or user-blocking, and (b) sub-100-line scope reviewable end-to-end in
one sitting. Anything bigger or speculative goes through dev.

**Parallel work happens in the cloud, not in local worktrees.** For a
project this size, spinning up multiple local worktrees costs more
in `pnpm install` / `data/` copying / port juggling than it saves.
Hand parallel tracks off to cloud Claude sessions instead — each
gets its own sandbox, returns a PR, and doesn't touch the local
working tree.
