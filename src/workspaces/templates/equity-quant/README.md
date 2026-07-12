---
version: 1.0.0
---

# Equity-Quant

An autoresearch coworker that clones the Equity-Quant repo and iterates on US-equity backtesting strategies inside its own branch — honesty-first: it reports Sharpe, drawdown, and overfitting signals straight (in-sample **and** out-of-sample), not just the flattering run.

## What this workspace does

Spawns a workspace as a local Equity-Quant clone on its own `autoresearch/<tag>` branch. The agent runs the prepare / backtest / optimize pipeline against US-equity data, edits strategies in the cloned repo, logs every iteration to `results.tsv` (in-sample Sharpe, out-of-sample Sharpe, net return, max drawdown, turnover, verdict, note), and commits as it goes — so every iteration leaves an auditable git trail.

**Research-only.** This template does not enable OpenAlice's trading CLI/skill (`alice-uta`) — the agent is not taught how to place, modify, or cancel real orders, close a position, or drive the trading-approval flow. Its job is backtesting and strategy iteration against historical/simulated data, never live trading.

## When to spawn this

- You want to test a new US-equity strategy idea (factor, mean-reversion, momentum) and let the agent iterate on parameters.
- You want an honest read on how a strategy would have performed out-of-sample, not just how well it fits the window it was tuned on.
- You want a backtest loop that runs alongside other workspaces without sharing data directories.

Each workspace gets its own `user_data/data/`. This isolation is deliberate: different runs may want different timeframes, universes, or vendors, and a shared cache would silently mix incompatible files across workspace generations.

## What you'll see in Inbox

- Backtest result summaries (in-sample vs. out-of-sample Sharpe, drawdown, key periods, verdict) as the agent finishes runs.
- Strategy diff notes when the agent commits a meaningful iteration.
- A flag when an iteration looks overfit (a wide is_sharpe / oos_sharpe gap) — the agent is expected to report this rather than quietly keep the flattering number.

## Parameters

- **Tag** — becomes the branch name (`autoresearch/<tag>`).

All available CLI runtimes are enabled (Claude, Codex, shell). The `+` new-session button defaults to Claude.

Power-user override: set `EQ_TEMPLATE_DIR` in the launcher env to point at a pre-existing Equity-Quant clone (e.g. one you've already populated with data). Recommended for local dev — it skips the network clone. The upstream is a **private** repo, so a fresh clone needs your git SSH access; `EQ_TEMPLATE_DIR` sidesteps that entirely.

## Safety note

The agent isn't taught the `alice-uta` trading CLI, so it won't proactively reach for order placement. It may still be able to read your linked brokerage accounts' portfolio/positions for backtest-framing context (e.g. sizing a hypothetical trade against real buying power) if it discovers the CLI on its own — OpenAlice's current workspace architecture does not yet enforce a hard technical boundary between "read account" and "place order" at the CLI level for any template. Avoid pointing this workspace at a live-trading credential if you need a hard guarantee it can never touch a real broker.
