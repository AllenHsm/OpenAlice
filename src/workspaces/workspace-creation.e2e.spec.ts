/**
 * End-to-end check of the create flow, exercising the real moving parts in
 * order: bootstrap.mjs (run on the bundled Node + dugite's bundled git) →
 * launcher context injection → launcher initial commit. Proves the workspace
 * is a fresh-git repo with exactly one clean commit (the "Harness rule"), and
 * — via the PATH-stripped case — that creation needs NO system git or bash.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { templatesPath } from '@/core/paths.js';

import { injectWorkspaceContext } from './context-injector.js';
import type { Logger } from './logger.js';
import { TemplateRegistry, type TemplateMeta } from './template-registry.js';
import { commitInitial } from './workspace-creator.js';

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  event() {},
  child() {
    return noopLogger;
  },
} as unknown as Logger;

const HERE = fileURLToPath(new URL('.', import.meta.url)); // src/workspaces/
const CHAT_DIR = join(HERE, 'templates', 'chat');
const CHAT_FILES = join(CHAT_DIR, 'files');
const CHAT_BOOTSTRAP = join(CHAT_DIR, 'bootstrap.mjs');
const AQ_DIR = join(HERE, 'templates', 'auto-quant');
const AQ_BOOTSTRAP = join(AQ_DIR, 'bootstrap.mjs');
const EQ_DIR = join(HERE, 'templates', 'equity-quant');
const EQ_BOOTSTRAP = join(EQ_DIR, 'bootstrap.mjs');

/**
 * Run a bootstrap.mjs exactly as the launcher's runScript does: on the bundled
 * Node (`process.execPath`) with ELECTRON_RUN_AS_NODE. `strip` removes git/bash
 * from PATH to prove the bare-machine path uses only dugite's embedded git.
 */
function runBootstrap(
  script: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv,
  strip = false,
): Promise<string> {
  const env = strip
    ? { HOME: process.env.HOME, ELECTRON_RUN_AS_NODE: '1', PATH: '', ...extraEnv }
    : { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv };
  return run(process.execPath, [script, ...args], env);
}

function autoQuantMeta(): TemplateMeta {
  return {
    name: 'auto-quant',
    bootstrapScript: AQ_BOOTSTRAP,
    filesDir: join(AQ_DIR, 'files'),
    templateDir: AQ_DIR,
    version: '1.0.0',
    defaultAgents: ['claude', 'codex'],
    injectTools: false,
    injectPersona: false,
    bundledSkills: [],
  };
}

function equityQuantMeta(): TemplateMeta {
  return {
    name: 'equity-quant',
    bootstrapScript: EQ_BOOTSTRAP,
    filesDir: join(EQ_DIR, 'files'),
    templateDir: EQ_DIR,
    version: '1.0.0',
    defaultAgents: ['claude', 'codex'],
    injectTools: false,
    injectPersona: false,
    bundledSkills: [],
  };
}

function run(cmd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err}`))));
  });
}

function chatMeta(): TemplateMeta {
  return {
    name: 'chat',
    bootstrapScript: CHAT_BOOTSTRAP,
    filesDir: CHAT_FILES,
    templateDir: CHAT_DIR,
    version: '1.0.0',
    defaultAgents: ['claude', 'codex'],
    injectTools: true,
    injectPersona: true,
    bundledSkills: ['scan-value-chain'],
  };
}

let parent: string;
let dir: string;
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'ws-e2e-'));
  dir = join(parent, 'workspace');
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

describe('chat workspace create: bootstrap → inject → commit', () => {
  it('yields a fresh-git workspace with one clean launcher commit', async () => {
    // 1. real bootstrap.mjs — git init + README + excludes, NO commit. PATH
    //    stripped: proves a bare machine (no system git, no bash) still works
    //    via dugite's bundled git.
    await runBootstrap(CHAT_BOOTSTRAP, ['testtag', dir], { AQ_TEMPLATE_ROOT: CHAT_DIR }, true);
    // 2. launcher-owned injection
    await injectWorkspaceContext({ template: chatMeta(), wsId: 'ws-e2e-1', dir });
    // 3. launcher-owned initial commit
    await commitInitial(dir, 'chat: testtag');

    // injected files all present
    for (const rel of [
      'CLAUDE.md', 'AGENTS.md', 'README.md',
      '.claude/skills/scan-value-chain/SKILL.md',
      '.agents/skills/scan-value-chain/SKILL.md',
      // per-CLI playbooks injected for every tool-bearing template
      '.claude/skills/alice/SKILL.md',
      '.claude/skills/alice-analysis/SKILL.md',
      '.claude/skills/alice-uta/SKILL.md',
      '.claude/skills/alice-workspace/SKILL.md',
      '.claude/skills/traderhub/SKILL.md',
    ]) {
      expect(existsSync(join(dir, rel)), rel).toBe(true);
    }

    // CLI-only injection: no MCP files are written at all
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
    expect(existsSync(join(dir, '.pi/extensions/openalice-bridge.ts'))).toBe(false);

    // exactly one commit, launcher author, right message
    const log = await run('git', ['-C', dir, 'log', '--pretty=%an <%ae>%n%s']);
    expect(log.trim()).toBe('launcher <launcher@local>\nchat: testtag');

    // working tree is clean (injected files were committed, not left dangling)
    const status = await run('git', ['-C', dir, 'status', '--porcelain']);
    expect(status.trim()).toBe('');
  });
});

describe('auto-quant workspace create: clone → scrub → commit', () => {
  it('scrubs cloned history + remote into a fresh-git workspace with one launcher commit', async () => {
    // fake upstream: history + an origin pointing at the public repo
    const src = join(parent, 'fake-auto-quant');
    await run('git', ['init', '-q', '-b', 'main', src]);
    await writeFile(join(src, 'strategy.py'), 'print("hi")\n');
    await run('git', ['-C', src, 'add', '.']);
    await run('git', ['-C', src, '-c', 'user.email=u@x', '-c', 'user.name=u', 'commit', '-q', '-m', 'upstream history']);
    await run('git', ['-C', src, 'remote', 'add', 'origin', 'https://github.com/TraderAlice/Auto-Quant.git']);

    const aqDir = join(parent, 'aq-workspace');
    await runBootstrap(AQ_BOOTSTRAP, ['aqtag', aqDir], { AQ_TEMPLATE_DIR: src });
    // auto-quant injects nothing (all flags false); launcher still commits.
    await injectWorkspaceContext({ template: autoQuantMeta(), wsId: 'ws-aq-1', dir: aqDir });
    await commitInitial(aqDir, 'auto-quant: aqtag');

    // working tree carries the upstream content + the results scaffold...
    expect(existsSync(join(aqDir, 'strategy.py'))).toBe(true);
    expect(existsSync(join(aqDir, 'results.tsv'))).toBe(true);
    // ...but history + remote are scrubbed (the Harness rule)
    expect((await run('git', ['-C', aqDir, 'remote', '-v'])).trim()).toBe('');
    expect((await run('git', ['-C', aqDir, 'log', '--pretty=%s'])).trim()).toBe('auto-quant: aqtag');
    expect((await run('git', ['-C', aqDir, 'status', '--porcelain'])).trim()).toBe('');
    expect((await run('git', ['-C', aqDir, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('autoresearch/aqtag');
  });
});

describe('equity-quant workspace create: clone → scrub → commit', () => {
  it('scrubs cloned history + remote into a fresh-git workspace with one launcher commit', async () => {
    // fake upstream: history + an origin pointing at the (placeholder) public repo
    const src = join(parent, 'fake-equity-quant');
    await run('git', ['init', '-q', '-b', 'main', src]);
    await writeFile(join(src, 'strategy.py'), 'print("hi")\n');
    await run('git', ['-C', src, 'add', '.']);
    await run('git', ['-C', src, '-c', 'user.email=u@x', '-c', 'user.name=u', 'commit', '-q', '-m', 'upstream history']);
    await run('git', ['-C', src, 'remote', 'add', 'origin', 'https://github.com/allenhu/equity-quant.git']);

    const eqDir = join(parent, 'eq-workspace');
    await runBootstrap(EQ_BOOTSTRAP, ['eqtag', eqDir], { EQ_TEMPLATE_DIR: src });
    // equity-quant injects nothing (all flags false); launcher still commits.
    await injectWorkspaceContext({ template: equityQuantMeta(), wsId: 'ws-eq-1', dir: eqDir });
    await commitInitial(eqDir, 'equity-quant: eqtag');

    // working tree carries the upstream content + the results scaffold...
    expect(existsSync(join(eqDir, 'strategy.py'))).toBe(true);
    expect(existsSync(join(eqDir, 'results.tsv'))).toBe(true);
    expect(await readFile(join(eqDir, 'results.tsv'), 'utf8')).toBe(
      'commit\tevent\tstrategy_name\tis_sharpe\toos_sharpe\tnet_return\tmax_dd\tturnover\tverdict\tnote\n',
    );
    // ...but history + remote are scrubbed (the Harness rule)
    expect((await run('git', ['-C', eqDir, 'remote', '-v'])).trim()).toBe('');
    expect((await run('git', ['-C', eqDir, 'log', '--pretty=%s'])).trim()).toBe('equity-quant: eqtag');
    expect((await run('git', ['-C', eqDir, 'status', '--porcelain'])).trim()).toBe('');
    expect((await run('git', ['-C', eqDir, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('autoresearch/eqtag');
  });
});

describe('template registry — real filesystem discovery', () => {
  it('discovers equity-quant alongside the other built-in templates', async () => {
    const registry = await TemplateRegistry.load(templatesPath(), noopLogger);

    const names = registry.list().map((t) => t.name);
    expect(names).toContain('equity-quant');
    expect(names).toContain('auto-quant');
    expect(names).toContain('chat');

    const eq = registry.get('equity-quant');
    expect(eq).toBeDefined();
    expect(eq?.displayName).toBe('Equity-Quant');
    expect(eq?.groupOrder).toBe(21);
    expect(eq?.defaultAgents).toEqual(['claude', 'codex']);
    // Research-only posture: no CLI playbooks (incl. the alice-uta trading
    // skill), no persona composition, no extra bundled skills.
    expect(eq?.injectTools).toBe(false);
    expect(eq?.injectPersona).toBe(false);
    expect(eq?.bundledSkills).toEqual([]);
    expect(eq?.version).toBe('1.0.0'); // from README frontmatter
    expect(eq?.bootstrapScript).toBe(EQ_BOOTSTRAP);
  });
});

describe('chat workspace create — CLI-only injection (no MCP)', () => {
  it('injects the per-CLI alice*/traderhub skills and writes no MCP files', async () => {
    await runBootstrap(CHAT_BOOTSTRAP, ['clitag', dir], { AQ_TEMPLATE_ROOT: CHAT_DIR });
    await injectWorkspaceContext({ template: chatMeta(), wsId: 'ws-cli-1', dir });
    await commitInitial(dir, 'chat: clitag');

    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);                          // no MCP injected
    expect(existsSync(join(dir, '.pi/extensions/openalice-bridge.ts'))).toBe(false); // no Pi bridge
    expect(existsSync(join(dir, '.claude/skills/alice-uta/SKILL.md'))).toBe(true);   // trading skill discoverable
    expect(existsSync(join(dir, '.claude/skills/traderhub/SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude/skills/scan-value-chain/SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.agents/skills/alice-uta/SKILL.md'))).toBe(true); // Pi shares .agents/skills
    expect(existsSync(join(dir, '.pi/skills'))).toBe(false);                       // avoid duplicate discovery
    expect((await run('git', ['-C', dir, 'status', '--porcelain'])).trim()).toBe('');
  });
});
