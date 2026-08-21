// OWNER: v0.4 profiles (issue #2). ProfileStore + /api/profiles: CRUD, secret write-only
// semantics (the Portainer-credential contract), delete guards, sanitized projections.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { makeHarness, TEST_PASSWORD } from './helpers.js';
import type { TestHarness } from './helpers.js';
import type { ProfileInput } from '../../src/profiles/model.js';
import { MANAGED_SETTINGS_PATH } from '../../src/profiles/apply.js';
import { pluginMarkerPath } from '../../src/profiles/plugins.js';
import {
  MAX_PROBES,
  MAX_PROBE_OUTPUT,
  REDACTED_OUTPUT,
  parseJsonPluginList,
  parseTextPluginList,
  runVerifyProbes,
  supportsYesFlag,
} from '../../src/profiles/verify.js';
import type { ProbeExec } from '../../src/profiles/verify.js';

const API_KEY = 'sk-live-profile_abcd';

let h: TestHarness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.cleanup();
});

async function login(): Promise<string> {
  const res = await request(h.app).post('/api/auth/login').send({ password: TEST_PASSWORD });
  const cookies = res.headers['set-cookie'] as unknown as string[];
  return (cookies[0] as string).split(';')[0] as string;
}

function sampleInput(over: Partial<ProfileInput> = {}): ProfileInput {
  return {
    name: 'Work',
    description: null,
    agents: {
      claude: {
        loginSet: 'team',
        env: { ANTHROPIC_BASE_URL: 'https://relay.example/v1' },
        envSecrets: { ANTHROPIC_API_KEY: API_KEY },
        settings: { model: 'some-provider-slug' },
        marketplaces: [],
        plugins: [],
      },
    },
    ...over,
  };
}

describe('ProfileStore (service level)', () => {
  it('encrypts typed secrets at rest and never returns them', async () => {
    await h.ctx.profiles.create(sampleInput());

    const raw = await readFile(`${h.dataDir}/config.json`, 'utf8');
    expect(raw).not.toContain(API_KEY);
    expect(JSON.parse(raw).profiles[0].agents.claude.envSecretsEnc.ANTHROPIC_API_KEY).toMatch(/^enc:v1:/);

    const sanitized = h.ctx.profiles.get('work');
    expect(JSON.stringify(sanitized)).not.toContain(API_KEY);
    expect(sanitized?.agents.claude?.envSecrets).toEqual({
      ANTHROPIC_API_KEY: { set: true, hint: 'abcd' },
    });
    // the decrypted value is available to the container machinery only
    const stored = h.ctx.profiles.stored('work');
    expect(h.ctx.profiles.secretEnvFor(stored!.agents.claude!)).toEqual({ ANTHROPIC_API_KEY: API_KEY });
  });

  it('derives the id from the name and de-conflicts', async () => {
    const a = await h.ctx.profiles.create(sampleInput({ name: 'Work' }));
    const b = await h.ctx.profiles.create(sampleInput({ name: 'Work' }));
    expect(a.id).toBe('work');
    expect(b.id).toBe('work-2');
  });

  it('keeps an omitted secret, clears a nulled secret, sets a typed secret on update', async () => {
    await h.ctx.profiles.create(sampleInput());
    const keep = await h.ctx.profiles.update('work', sampleInput({
      agents: {
        claude: { ...sampleInput().agents.claude!, envSecrets: {} },
      },
    }));
    expect(keep.agents.claude?.envSecrets.ANTHROPIC_API_KEY).toEqual({ set: true, hint: 'abcd' });

    const cleared = await h.ctx.profiles.update('work', sampleInput({
      agents: {
        claude: { ...sampleInput().agents.claude!, envSecrets: { ANTHROPIC_API_KEY: null } },
      },
    }));
    expect(cleared.agents.claude?.envSecrets).toEqual({});

    const rotated = await h.ctx.profiles.update('work', sampleInput({
      agents: {
        claude: { ...sampleInput().agents.claude!, envSecrets: { ANTHROPIC_API_KEY: 'sk-new_k3y' } },
      },
    }));
    expect(rotated.agents.claude?.envSecrets.ANTHROPIC_API_KEY).toEqual({ set: true, hint: '_k3y' });
  });

  it('refuses server-owned settings keys and pasted-back ciphertext', async () => {
    await expect(
      h.ctx.profiles.create(sampleInput({
        agents: {
          claude: {
            ...sampleInput().agents.claude!,
            settings: { env: { X: 'y' } },
          },
        },
      })),
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      h.ctx.profiles.create(sampleInput({
        agents: {
          claude: {
            ...sampleInput().agents.claude!,
            envSecrets: { ANTHROPIC_API_KEY: 'enc:v1:should-not-be-pasted' },
          },
        },
      })),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('blocks deletion while a container uses the profile; force strips the assignment', async () => {
    await h.ctx.profiles.create(sampleInput());
    await h.ctx.config.putContainer({
      name: 'alpha',
      hostId: 'default',
      agents: null,
      profileId: 'work',
      image: { type: 'recipe', recipe: 'node' },
      workspace: { type: 'volume' },
      env: {},
      ports: [],
      extraMounts: [],
      limits: {},
      shareHistory: true,
      autoStart: true,
      network: null,
      user: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(h.ctx.profiles.get('work')?.inUse).toEqual(['alpha']);

    await expect(h.ctx.profiles.remove('work')).rejects.toMatchObject({ status: 409 });

    await h.ctx.profiles.remove('work', { force: true });
    expect(h.ctx.profiles.get('work')).toBeNull();
    expect(h.ctx.config.getContainer('alpha')?.profileId).toBeNull();
  });
});

// Regression block: every case here is a bug an adversarial review found in the first cut.
describe('ProfileStore hardening (review findings)', () => {
  it("refuses 'default' as a profile id — it names the host-wide login set", async () => {
    // A profile with no explicit loginSet uses a set NAMED AFTER ITS ID. With the id
    // 'default' that is the v0.2 volume every unprofiled container mounts, so the profile
    // would silently adopt (and ?removeVolumes=1 would destroy) everyone else's login.
    await expect(
      h.ctx.profiles.create(sampleInput({ id: 'default', name: 'Default' })),
    ).rejects.toMatchObject({ status: 422 });

    // ...and the derived id must dodge it too, rather than producing it from the name
    const derived = await h.ctx.profiles.create(sampleInput({ name: 'Default' }));
    expect(derived.id).not.toBe('default');
  });

  it('reports a stored-but-undecryptable secret as set, with an empty hint', async () => {
    await h.ctx.profiles.create(sampleInput());
    // simulate a rotated APP_SECRET: the blob stays, nothing can read it any more
    await h.ctx.config.update((draft) => {
      draft.profiles[0]!.agents.claude!.envSecretsEnc.ANTHROPIC_API_KEY = 'enc:v1:not-decryptable';
    });
    const sanitized = h.ctx.profiles.get('work');
    // set:false would render an empty field, the user would leave it empty, and an omitted
    // key means KEEP — the dead blob would survive forever
    expect(sanitized?.agents.claude?.envSecrets.ANTHROPIC_API_KEY).toEqual({ set: true, hint: '' });
  });

  it('detaches containers and deletes the profile in one write', async () => {
    await h.ctx.profiles.create(sampleInput());
    await h.ctx.config.putContainer({
      name: 'alpha',
      hostId: 'default',
      agents: null,
      profileId: 'work',
      image: { type: 'recipe', recipe: 'node' },
      workspace: { type: 'volume' },
      env: {},
      ports: [],
      extraMounts: [],
      limits: {},
      shareHistory: true,
      autoStart: true,
      network: null,
      user: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let sawDetachedButPresent = false;
    h.ctx.config.on('change', (cfg) => {
      const stillThere = cfg.profiles.some((p) => p.id === 'work');
      const detached = cfg.containers.every((c) => c.profileId !== 'work');
      if (stillThere && detached) sawDetachedButPresent = true;
    });

    await h.ctx.profiles.remove('work', { force: true });
    // no observer may ever see the half state (containers stripped, profile still stored)
    expect(sawDetachedButPresent).toBe(false);
    expect(h.ctx.config.getContainer('alpha')?.profileId).toBeNull();
    expect(h.ctx.profiles.get('work')).toBeNull();
  });

  it('derives a unique id without chopping the counter off a long name', async () => {
    const long = 'a'.repeat(40);
    const first = await h.ctx.profiles.create(sampleInput({ name: long }));
    const second = await h.ctx.profiles.create(sampleInput({ name: long }));
    expect(first.id).not.toBe(second.id);
    for (const id of [first.id, second.id]) {
      expect(id.length).toBeLessThanOrEqual(32);
      expect(id.endsWith('-')).toBe(false);
    }
  });

  it('answers 422, not 500, for a name with nothing slug-able', async () => {
    await expect(h.ctx.profiles.create(sampleInput({ name: '???' }))).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe('GET/POST/PUT/DELETE /api/profiles', () => {
  it('sits behind the auth gate', async () => {
    const res = await request(h.app).get('/api/profiles');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('round-trips a profile with sanitized secrets', async () => {
    const cookie = await login();
    const created = await request(h.app).post('/api/profiles').set('Cookie', cookie).send(sampleInput());
    expect(created.status).toBe(201);
    expect(created.body.profile).toMatchObject({ id: 'work', name: 'Work' });
    expect(JSON.stringify(created.body)).not.toContain(API_KEY);

    const listed = await request(h.app).get('/api/profiles').set('Cookie', cookie);
    expect(listed.body.profiles).toHaveLength(1);
    expect(listed.body.profiles[0].agents.claude.loginSet).toBe('team');

    const one = await request(h.app).get('/api/profiles/work').set('Cookie', cookie);
    expect(one.status).toBe(200);
    expect(one.body.profile.agents.claude.env.ANTHROPIC_BASE_URL).toBe('https://relay.example/v1');

    const missing = await request(h.app).get('/api/profiles/nope').set('Cookie', cookie);
    expect(missing.status).toBe(404);

    const removed = await request(h.app).delete('/api/profiles/work').set('Cookie', cookie);
    expect(removed.status).toBe(204);
    expect((await request(h.app).get('/api/profiles').set('Cookie', cookie)).body.profiles).toHaveLength(0);
  });

  it('reads force/removeVolumes from the QUERY STRING, and only when truthy', async () => {
    const cookie = await login();
    await request(h.app).post('/api/profiles').set('Cookie', cookie).send(sampleInput());
    await h.ctx.config.putContainer({
      name: 'alpha',
      hostId: 'default',
      agents: null,
      profileId: 'work',
      image: { type: 'recipe', recipe: 'node' },
      workspace: { type: 'volume' },
      env: {},
      ports: [],
      extraMounts: [],
      limits: {},
      shareHistory: true,
      autoStart: true,
      network: null,
      user: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // in use -> 409, and the envelope names the containers
    const blocked = await request(h.app).delete('/api/profiles/work').set('Cookie', cookie);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.containers).toEqual(['alpha']);

    // ?force=0 must NOT force (truthy-string coercion would have made this a delete)
    const notForced = await request(h.app).delete('/api/profiles/work?force=0').set('Cookie', cookie);
    expect(notForced.status).toBe(409);
    expect(h.ctx.profiles.get('work')).not.toBeNull();

    // ?force=1 strips the assignment and deletes
    const forced = await request(h.app).delete('/api/profiles/work?force=1').set('Cookie', cookie);
    expect(forced.status).toBe(204);
    expect(h.ctx.profiles.get('work')).toBeNull();
    expect(h.ctx.config.getContainer('alpha')?.profileId).toBeNull();
  });

  it('answers 422 with the zod envelope on a bad body and 409 on a duplicate id', async () => {
    const cookie = await login();
    const bad = await request(h.app).post('/api/profiles').set('Cookie', cookie).send({ name: '' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('validation_error');

    await request(h.app).post('/api/profiles').set('Cookie', cookie).send(sampleInput());
    const dup = await request(h.app)
      .post('/api/profiles')
      .set('Cookie', cookie)
      .send(sampleInput({ id: 'work', name: 'Other' }));
    expect(dup.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// v0.4 (#4): the profile verify probe. The derivation is pure and tested directly;
// `runVerifyProbes` is driven by a scripted exec, so none of this needs docker.
// ---------------------------------------------------------------------------
describe('profile verify probe (v0.4 #4)', () => {
  const PLANTED_SECRET = 'sk-ant-planted-secret-do-not-leak';

  const HELP_WITH_YES = [
    'Usage: claude plugin install <ref> [options]',
    '',
    'Options:',
    '  -y, --yes    skip the confirmation prompt',
    '  -h, --help   display help for command',
  ].join('\n');

  const HELP_WITHOUT_YES = [
    'Usage: claude plugin install <ref> [options]',
    '',
    'Options:',
    '  -h, --help   display help for command',
  ].join('\n');

  interface ScriptedExec {
    version?: { exitCode: number; stdout: string };
    help?: { exitCode: number; stdout: string };
    jsonList?: { exitCode: number; stdout: string };
    textList?: { exitCode: number; stdout: string };
    settings?: { exitCode: number; stdout: string };
    marker?: string;
  }

  /** an exec that answers each of the five probe commands from a script */
  function scriptedExec(s: ScriptedExec): { exec: ProbeExec; cmds: string[][] } {
    const cmds: string[][] = [];
    const exec: ProbeExec = async (cmd) => {
      cmds.push(cmd);
      const ok = (r?: { exitCode: number; stdout: string }) => ({
        exitCode: r?.exitCode ?? 0,
        stdout: r?.stdout ?? '',
        stderr: '',
      });
      if (cmd[1] === '--version') return ok(s.version ?? { exitCode: 0, stdout: '1.2.3 (Claude Code)' });
      if (cmd[2] === '--help') return ok(s.help ?? { exitCode: 0, stdout: HELP_WITH_YES });
      if (cmd[3] === '--json') return ok(s.jsonList ?? { exitCode: 1, stdout: 'unknown option --json' });
      if (cmd[2] === 'list') return ok(s.textList ?? { exitCode: 0, stdout: '' });
      if (String(cmd[2]).includes(MANAGED_SETTINGS_PATH)) return ok(s.settings ?? { exitCode: 3, stdout: '' });
      return ok({ exitCode: 0, stdout: s.marker ?? '' });
    };
    return { exec, cmds };
  }

  it('reads -y/--yes out of the plugin help, and says no when it is absent', () => {
    expect(supportsYesFlag(HELP_WITH_YES)).toBe(true);
    expect(supportsYesFlag('  --yes')).toBe(true);
    expect(supportsYesFlag(HELP_WITHOUT_YES)).toBe(false);
    // an English "yes" and a longer flag must not be mistaken for the option
    expect(supportsYesFlag('answer yes when prompted')).toBe(false);
    expect(supportsYesFlag('  --yes-really  do a thing')).toBe(false);
  });

  it('parses the installed plugins from --json, from plain text, and gives up on garbage', () => {
    expect(parseJsonPluginList('{"plugins":[{"name":"fmt","marketplace":"acme"},"lint@corp"]}')).toEqual([
      'fmt@acme',
      'lint@corp',
    ]);
    expect(parseJsonPluginList('["fmt@acme"]')).toEqual(['fmt@acme']);
    // not JSON at all, and JSON that is not a list of anything: null = "could not read it"
    expect(parseJsonPluginList('Installed plugins: fmt@acme')).toBeNull();
    expect(parseJsonPluginList('42')).toBeNull();

    expect(parseTextPluginList('Installed plugins:\n  - fmt@acme\n  - lint@corp\n')).toEqual(['fmt@acme', 'lint@corp']);
    // prose and error text must never become a phantom "installed" entry
    expect(parseTextPluginList('No plugins installed')).toEqual([]);
    expect(parseTextPluginList('error: unknown command "plugin"\n???\n')).toEqual([]);
  });

  it('reports only the TOP-LEVEL KEYS of the managed settings and never a value', async () => {
    const settings = {
      env: { ANTHROPIC_API_KEY: PLANTED_SECRET, ANTHROPIC_BASE_URL: 'https://relay.example/v1' },
      enabledPlugins: { 'fmt@acme': true },
      model: 'some-provider-slug',
    };
    const { exec } = scriptedExec({
      jsonList: { exitCode: 0, stdout: '["fmt@acme"]' },
      settings: { exitCode: 0, stdout: JSON.stringify(settings) },
      marker: JSON.stringify({ syncedAt: 'x', installed: ['fmt@acme'] }),
    });

    const report = await runVerifyProbes({ exec, home: '/home/dev', desiredPlugins: ['fmt@acme'] });

    expect(report.managedSettings).toEqual({
      present: true,
      valid: true,
      keys: ['enabledPlugins', 'env', 'model'],
    });
    // THE leak test: neither the value nor the file body may appear anywhere in the report
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(PLANTED_SECRET);
    expect(serialized).not.toContain('relay.example');
    expect(serialized).not.toContain('some-provider-slug');
    expect(report.probes.some((p) => p.output === REDACTED_OUTPUT)).toBe(true);
    expect(report.marker).toEqual({ present: true, installed: ['fmt@acme'] });
    expect(report.ok).toBe(true);
  });

  it('runs read-only probes only, and caps every recorded output', async () => {
    const { exec, cmds } = scriptedExec({
      help: { exitCode: 0, stdout: 'x'.repeat(5_000) },
      jsonList: { exitCode: 0, stdout: '[]' },
    });
    const report = await runVerifyProbes({ exec, home: '/home/dev', desiredPlugins: [] });

    expect(cmds).toEqual([
      ['claude', '--version'],
      ['claude', 'plugin', '--help'],
      // the -y flag is advertised by the SUBCOMMAND, not by the group containing it
      ['claude', 'plugin', 'install', '--help'],
      ['claude', 'plugin', 'list', '--json'],
      ['sh', '-c', `[ -f '${MANAGED_SETTINGS_PATH}' ] || exit 3\ncat '${MANAGED_SETTINGS_PATH}'`],
      ['sh', '-c', `cat '${pluginMarkerPath('/home/dev')}' 2>/dev/null || true`],
    ]);
    // nothing may install, uninstall, write or remove. `plugin install --help` is the one
    // probe naming a mutating verb without performing it, so it is asserted to be a help
    // invocation rather than pattern-matched away.
    for (const cmd of cmds) {
      const joined = cmd.join(' ');
      if (/\b(install|uninstall)\b/.test(joined)) {
        expect(cmd).toContain('--help');
      } else {
        expect(joined).not.toMatch(/\brm\b|chmod|chown|mkdir|tee|base64 -d/);
      }
    }
    expect(report.probes.length).toBeLessThanOrEqual(MAX_PROBES);
    for (const probe of report.probes) expect(probe.output.length).toBeLessThanOrEqual(MAX_PROBE_OUTPUT + 1);
  });

  it('is not ok when a desired plugin is missing, and never throws on a failing exec', async () => {
    const missing = await runVerifyProbes({
      exec: scriptedExec({ jsonList: { exitCode: 0, stdout: '["other@acme"]' } }).exec,
      home: '/home/dev',
      desiredPlugins: ['fmt@acme'],
    });
    expect(missing.pluginCommand.installed).toEqual(['other@acme']);
    expect(missing.missingPlugins).toEqual(['fmt@acme']);
    expect(missing.ok).toBe(false);

    // an unreadable list is "unknown", not "everything is missing"
    const unknown = await runVerifyProbes({
      exec: scriptedExec({ textList: { exitCode: 1, stdout: '' } }).exec,
      home: '/home/dev',
      desiredPlugins: ['fmt@acme'],
    });
    expect(unknown.pluginCommand.listWorks).toBe(false);
    expect(unknown.missingPlugins).toEqual([]);

    // a dead engine: every probe throws, and the report still comes back
    const dead = await runVerifyProbes({
      exec: async () => {
        throw new Error('exec failed: container is gone');
      },
      home: '/home/dev',
      desiredPlugins: ['fmt@acme'],
    });
    expect(dead.cli.available).toBe(false);
    expect(dead.ok).toBe(false);
    expect(dead.warnings.join(' ')).toContain('container is gone');
  });

  it('answers 404 for an unknown profile and 422 for a body without a container', async () => {
    const cookie = await login();
    await request(h.app).post('/api/profiles').set('Cookie', cookie).send(sampleInput());

    const unknown = await request(h.app)
      .post('/api/profiles/nope/verify')
      .set('Cookie', cookie)
      .send({ container: 'web' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('not_found');

    const noBody = await request(h.app).post('/api/profiles/work/verify').set('Cookie', cookie).send({});
    expect(noBody.status).toBe(422);
    expect(noBody.body.error.code).toBe('validation_error');
  });
});
