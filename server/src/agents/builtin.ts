// FROZEN (planner-authored, fully implemented data, v0.2). The built-in coding agents.
//
// These definitions are DATA, not code: they describe how the tools image installs an agent
// into the shared tools volume (docker/tools, ORCHESTRATION topic) and which paths must be
// shared between every session on a host (agents/model.ts explains the layout).
//
// Rules
//  * ids are stable and part of the API (`shell=agent:<id>`, volume `…-auth-<id>`), so they
//    are never renamed. A custom agent may not reuse one of them.
//  * `command` must be what the tools volume puts on PATH (`<toolsMount>/bin/<command>`).
//  * `sharedPaths` are what a *fresh* login writes; when in doubt share the whole directory
//    rather than a single file (a file path costs one symlink either way, but a missed one
//    silently breaks "log in once per host").
//  * verified against the upstream docs as of 2026-08; the tools installer treats a failed
//    agent install as a warning, never a failed sync, so a moved installer URL degrades to
//    "agent not installed" in the Images/Tools panel instead of breaking the host.
import type { AgentDefinition } from './model.js';

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    description: "Anthropic's terminal coding agent (native installer, no runtime needed).",
    command: 'claude',
    args: [],
    versionCommand: ['claude', '--version'],
    install: {
      kind: 'script',
      url: 'https://claude.ai/install.sh',
      binPath: 'bin/claude',
    },
    sharedPaths: [
      { path: '~/.claude', kind: 'dir', note: 'credentials, settings, plugins, history' },
      { path: '~/.claude.json', kind: 'file', note: 'account + onboarding state' },
    ],
    historyPath: '~/.claude/projects',
    env: {},
    loginHint: 'Open an agent terminal and run /login once per host.',
    homepage: 'https://claude.com/claude-code',
  },
  {
    id: 'opencode',
    name: 'opencode',
    description: 'Open-source terminal agent, provider agnostic (native installer).',
    command: 'opencode',
    args: [],
    versionCommand: ['opencode', '--version'],
    install: {
      kind: 'script',
      url: 'https://opencode.ai/install',
      binPath: 'bin/opencode',
    },
    sharedPaths: [
      { path: '~/.local/share/opencode', kind: 'dir', note: 'auth.json, state, logs' },
      { path: '~/.config/opencode', kind: 'dir', note: 'opencode.json, agents, themes' },
    ],
    historyPath: null,
    env: {},
    loginHint: 'Run `opencode auth login` once per host.',
    homepage: 'https://opencode.ai',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    description: "Google's open-source terminal agent (npm, needs the bundled Node runtime).",
    command: 'gemini',
    args: [],
    versionCommand: ['gemini', '--version'],
    install: { kind: 'npm', package: '@google/gemini-cli', version: 'latest', bin: 'gemini' },
    sharedPaths: [
      { path: '~/.gemini', kind: 'dir', note: 'oauth_creds.json, settings.json, sessions' },
    ],
    historyPath: null,
    env: {},
    loginHint: 'Run `gemini` and pick "Login with Google", or set GEMINI_API_KEY in the session env.',
    homepage: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    description: "OpenAI's terminal coding agent (npm, needs the bundled Node runtime).",
    command: 'codex',
    args: [],
    versionCommand: ['codex', '--version'],
    install: { kind: 'npm', package: '@openai/codex', version: 'latest', bin: 'codex' },
    sharedPaths: [
      { path: '~/.codex', kind: 'dir', note: 'auth.json, config.toml, sessions' },
    ],
    historyPath: '~/.codex/sessions',
    env: {},
    loginHint: 'Run `codex` and sign in with ChatGPT, or set OPENAI_API_KEY in the session env.',
    homepage: 'https://github.com/openai/codex',
  },
  {
    id: 'aider',
    name: 'Aider',
    description: 'AI pair programming in the terminal (python, installed with uv/pipx).',
    command: 'aider',
    args: [],
    versionCommand: ['aider', '--version'],
    install: { kind: 'pip', package: 'aider-chat', bin: 'aider', preferUv: true },
    sharedPaths: [
      { path: '~/.aider.conf.yml', kind: 'file', note: 'model + api key configuration' },
      { path: '~/.aider.model.settings.yml', kind: 'file', note: 'per-model overrides' },
      { path: '~/.aider', kind: 'dir', note: 'caches and analytics state' },
    ],
    historyPath: null,
    env: {},
    loginHint: 'Aider uses API keys: put them into ~/.aider.conf.yml or the session env.',
    homepage: 'https://aider.chat',
  },
];

/** Ids of the agents a NEW host enables by default (kept small: every agent costs sync time). */
export const DEFAULT_ENABLED_AGENT_IDS = ['claude'];

/** The agent a v0.1 config migrates to (its auth volume receives the legacy claude login). */
export const LEGACY_AGENT_ID = 'claude';

export function getBuiltinAgent(id: string): AgentDefinition | null {
  return BUILTIN_AGENTS.find((a) => a.id === id) ?? null;
}

export function isBuiltinAgentId(id: string): boolean {
  return BUILTIN_AGENTS.some((a) => a.id === id);
}
