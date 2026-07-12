/**
 * Bootstrap an Equity-Quant workspace — cross-platform Node port of the old
 * `bootstrap.sh` pattern (see `../auto-quant/bootstrap.mjs`, the template this
 * one mirrors). Runs on the Electron-bundled Node (no bash) and the bundled
 * git via `_common.mjs` (no system git / Git-for-Windows).
 *
 *   argv:  process.argv[2] = tag, process.argv[3] = outDir (absolute)
 *   env:   EQ_TEMPLATE_DIR  — optional power-user override pointing at an
 *                             existing Equity-Quant clone. If unset/invalid we
 *                             manage our own mirror clone of
 *                             EQUITY_QUANT_UPSTREAM under
 *                             $EQ_LAUNCHER_ROOT/equity-quant-mirror.
 *          EQ_LAUNCHER_ROOT — optional; defaults to ~/.openalice/workspaces.
 *
 * Zero-config by default: a fresh install clones the Equity-Quant repo on the
 * first workspace creation; subsequent creations reuse the local mirror via
 * `git clone --local` (fast hardlinks; falls back to copy where the filesystem
 * doesn't support hardlinks). The launcher makes the initial commit after this
 * script. Each workspace owns its own real `user_data/data/` (not a shared
 * symlink) — Equity-Quant's data schema may evolve between releases, so a
 * shared cache would silently mix incompatible files across generations.
 */

import { existsSync, mkdirSync, rmSync, readdirSync, cpSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { setupGitExcludes, git } from '../_common.mjs'

const tag = process.argv[2]
const outDir = process.argv[3]
if (!tag || !outDir) {
  console.error('usage: bootstrap.mjs <tag> <outDir>')
  process.exit(1)
}

if (existsSync(outDir)) {
  console.error(`outDir already exists: ${outDir}`)
  process.exit(2)
}

// ── Resolve Equity-Quant source ─────────────────────────────────────────────
// Published as a PRIVATE repo. A fresh network clone therefore needs the
// user's own git/SSH access to it (works on their machine; fails for anyone
// without access — by design, since it's private). For local development set
// EQ_TEMPLATE_DIR to a working checkout to skip the network clone entirely;
// during bring-up that's /Users/allenhu/Documents/GitHub/equity-quant.
const EQUITY_QUANT_UPSTREAM = 'git@github.com:allenhu-prod/equity-quant.git'
const launcherRoot = process.env.EQ_LAUNCHER_ROOT || join(homedir(), '.openalice', 'workspaces')
const mirror = join(launcherRoot, 'equity-quant-mirror')

let source = ''
const override = process.env.EQ_TEMPLATE_DIR
if (override && existsSync(join(override, '.git'))) {
  // Power-user override: use the user's pre-existing Equity-Quant clone as-is.
  source = override
} else {
  // Default path: maintain our own mirror under the launcher root.
  if (!existsSync(join(mirror, '.git'))) {
    console.error(`[equity-quant] no local mirror at ${mirror}; cloning ${EQUITY_QUANT_UPSTREAM} ...`)
    mkdirSync(dirname(mirror), { recursive: true })
    await git(['clone', '--quiet', EQUITY_QUANT_UPSTREAM, mirror], dirname(mirror))
  }
  source = mirror
}

if (!existsSync(join(source, '.git'))) {
  console.error(`[equity-quant] no Equity-Quant source available at ${source}`)
  process.exit(3)
}

// ── Materialise the workspace ───────────────────────────────────────────────

// 1. local clone — hardlinks .git/objects, fast and disk-cheap. We clone only
//    for the working tree; history + remote are scrubbed below.
await git(['clone', '--local', source, outDir], dirname(outDir))

// 2. Scrub to a fresh local repo (no upstream history, no pushable remote), on
//    the autoresearch branch. A Harness is always a fresh-git workspace with a
//    clean initial commit; carrying Equity-Quant's whole history + an origin
//    pointing at the (future) public GitHub repo violates that. The launcher
//    makes the initial commit after this script returns.
rmSync(join(outDir, '.git'), { recursive: true, force: true })
await git(['init', '-q'], outDir)
await git(['checkout', '-b', `autoresearch/${tag}`], outDir)

// Agent-config excludes — defense-in-depth: keep any later workspace-specific
// AI provider secrets out of a push to upstream Equity-Quant.
setupGitExcludes(outDir)

// 3. user_data/data is a real per-workspace directory. Equity-Quant's
//    .gitignore is expected to exclude user_data/data/ (mirroring Auto-Quant's
//    freqtrade-style layout), so a data-prep step's output stays untracked. If
//    the SOURCE ships pre-fetched data, copy it in so the user need not re-fetch.
const wsData = join(outDir, 'user_data', 'data')
mkdirSync(wsData, { recursive: true })
const srcData = join(source, 'user_data', 'data')
if (existsSync(srcData) && readdirSync(srcData).length > 0) {
  console.error(`[equity-quant] copying pre-fetched data from ${srcData}`)
  cpSync(srcData, wsData, { recursive: true })
}

// 4. results.tsv header — the agent appends rows from here on out. Both
//    is_sharpe (in-sample) and oos_sharpe (out-of-sample) are logged side by
//    side so an overfit iteration is visible directly in the log, not just in
//    the flattering in-sample number; turnover + verdict/note back the
//    honesty-first review this template is meant to encourage.
writeFileSync(
  join(outDir, 'results.tsv'),
  'commit\tevent\tstrategy_name\tis_sharpe\toos_sharpe\tnet_return\tmax_dd\tturnover\tverdict\tnote\n',
)

// NOTE: intentionally no copyReadme here — the workspace IS an Equity-Quant
// clone, so its working tree already carries Equity-Quant's own README.md,
// which is the right one for the agent / user opening the folder.

console.log(`bootstrapped autoresearch/${tag} at ${outDir}`)
