# Users, roles and permissions (v0.3 proposal)

Status: **proposal / not implemented**. Scopes the work behind "an instance admin configures
hosts and hands out permissions to other users". Written against the shipped v0.2.1 code
(single shared password, `sub:'admin'` JWT, 61 authenticated routes, one `config.json`).

---

## 1. Where v0.2.1 stands

| Piece | Today |
|---|---|
| Identity | none — one `APP_PASSWORD`, one scrypt hash in `config.auth` |
| Token | JWT cookie `pc_session`, `{sub:'admin', v: tokenVersion}` |
| Authorization | `requireAuth` in `routes/index.ts` — binary: authenticated ⇒ everything |
| Terminals | `authenticateUpgradeRequest()` returns a **boolean**; any cookie holder may attach to any pane of any session |
| Ownership | sessions have no owner; discovery is by `porterclaude.instance` label only |
| Audit | pino lines, no actor |

So the entire authorization surface has to be *added*, not changed — there is no half-built
role system to extend, and no place in the config schema for a second principal.

## 2. The uncomfortable part: what a permission can and cannot contain

Three facts about this product decide the design. They must be settled before any permission
names get written down, because two of the obvious permissions are otherwise **cosmetic**.

**2.1 "Create a session" is "root on the docker host" unless it is constrained.**
A session is a container spec the user controls: image, mounts, ports, env. A user allowed to
create one can ask for `type:'bind', hostPath:'/'`, or a mount of `/var/run/docker.sock`, and
own the engine. `WorkspaceHostPathSchema` + `buildContainerSpec` already keep binds under
`general.workspacesRoot`, which is the right hook — but `mounts[]` is a free-form list today.
⇒ a *session spec policy* (§6) is a prerequisite for the `host.sessions.create` permission,
not a later nicety. Without it, "manage sessions on host X" and "admin of host X" are the
same permission wearing different labels.

**2.2 Agent logins are shared per host.** `porterclaude-auth-<agentId>` is mounted into every
session on the host, so any user with a shell on that host can read
`~/.porterclaude/agents/claude/.credentials.json` and the agent's history. That is the *point*
of the feature in a single-operator install, and a data leak in a multi-user one. Three
options, decided per host (§7): shared (today), per user, per session.

**2.3 Everyone inside one session is the same OS user** (`dev`, uid 1000). Sharing a session
means sharing a shell — there is no in-session isolation and there should not be. The
permission boundary is *which* sessions you can attach to, never what you may do once inside.

## 3. Principals

```jsonc
// config.users[]
{
  "id": "u-9f3c1a2b",             // stable, never reused
  "username": "alice",            // login name, unique, [a-z0-9._-]{1,32}
  "displayName": "Alice",
  "passwordHash": "scrypt:…",     // same scheme as today
  "tokenVersion": 1,              // per-user; a password change logs only that user out
  "disabled": false,              // keep grants, refuse login
  "mustChangePassword": false,
  "createdAt": "…", "createdBy": "u-…", "lastLoginAt": "…"
}
```

JWT becomes `{sub: '<userId>', v: <user.tokenVersion>, r: '<instanceRole>'}`. `config.auth`
keeps a single global `tokenVersion` as the "revoke every session" switch.

Migration v2 → v3: the existing password hash becomes user `admin` with instance role
`admin`; `APP_PASSWORD` keeps seeding *that* user only while no user exists. Every existing
session gets `ownerUserId: '<that admin>'`. Lossless, same shape as the v1 → v2 migration.

## 4. Scopes

Three, and no more — the grant table is a union, there are no deny rules and no inheritance
beyond this list:

| Scope | Key | Covers |
|---|---|---|
| Instance | `instance` | users, credentials, agent definitions, general settings, host create/delete |
| Host | `host:<hostId>` | one docker engine: its config, images, tools, agents, and its sessions |
| Session | `session:<name>` | one session (names are unique across hosts today) |

Effective permission set = union of the permissions of every grant whose scope matches the
request's scope or an enclosing one. `instance` encloses every host; `host:<id>` encloses
every session on that host.

## 5. The permission catalog

Deny by default. Names are `<scope>.<object>.<verb>`; the middleware takes the name plus a
scope resolver, so one route = one line.

### 5.1 Instance

| Permission | Guards | Notes |
|---|---|---|
| `instance.users.read` | `GET /api/users` | see the roster |
| `instance.users.write` | create / rename / disable / delete users | |
| `instance.users.password` | reset another user's password | separate: a helpdesk role wants this without `users.write` |
| `instance.grants.write` | assign any grant at any scope | **the escalation permission** — implies everything, only real admins get it |
| `instance.hosts.create` | `POST /api/hosts`, import endpoints | creator gets `host-admin` on the result |
| `instance.hosts.delete` | `DELETE /api/hosts/:id` | |
| `instance.credentials.read` | list Portainer credentials (metadata only; keys are never serialised) | a credential is host-root for every endpoint it reaches |
| `instance.credentials.write` | add / edit / delete / test | |
| `instance.agents.read` | `GET /api/agents` | definitions, not per-host state |
| `instance.agents.write` | add / edit / delete custom agent definitions | a definition is an **install command that runs on every host that syncs** ⇒ admin only |
| `instance.settings.read` / `.write` | `GET/PUT /api/settings/general` | `workspacesRoot`, `volumePrefix`, `containerPrefix`, `containerHome`, `toolsMount` rewrite every container spec ⇒ admin only |
| `instance.audit.read` | `GET /api/audit` | new (§8) |

### 5.2 Host

| Permission | Guards |
|---|---|
| `host.read` | the host appears in `GET /api/hosts`; name / type / status / probe result |
| `host.probe` | `POST /api/hosts/:id/test` (an outbound call on your behalf) |
| `host.update` | rename, connection change, per-host setting overrides |
| `host.delete` | remove the host (see §11 Q3) |
| `host.docker.read` | `/api/hosts/:id/docker/*` — the raw containers/images/volumes/networks panel, i.e. **every** container on the engine, PorterClaude's or not |
| `host.images.read` | recipe list + build state |
| `host.images.build` | `POST …/images/build` — CPU, disk and outbound pulls on the host |
| `host.images.delete` | prune / remove an image |
| `host.tools.sync` | `POST …/tools/sync` — installs/updates agents on the host (network + writes to the shared tools volume; disruptive to everyone on that host) |
| `host.agents.read` | which agents this host has, install state |
| `host.agents.write` | enable/disable agents for the host |
| `host.sessions.list` | see **all** sessions on the host, not just your own |
| `host.sessions.create` | create — **only meaningful together with a spec policy, §6** |
| `host.sessions.admin` | update / recreate / stop / delete **any** session on the host, including other people's |

### 5.3 Session

| Permission | Guards |
|---|---|
| `session.read` | it appears in `GET /api/sessions`; its config (env values redacted unless `session.update`) |
| `session.use` | open a terminal — `bash`/`sh` pane, full stdin |
| `session.use.agent` | open an *agent* pane only (`shell=agent:<id>`). Separable from `session.use` so "may run Claude here, may not have a raw shell" is expressible. It is a **UX boundary, not a security one** — every agent can spawn a shell — and the docs must say so |
| `session.attach.readonly` | attach with stdin dropped server-side (observer / pairing / demo) |
| `session.lifecycle` | start / stop / restart |
| `session.logs` | `GET …/logs` |
| `session.update` | edit the spec (image, mounts, env, ports, limits) ⇒ **inherits the §6 policy**; editing your own session must not be a way around the policy that governed creating it |
| `session.recreate` | recreate the container from the stored spec |
| `session.delete` | destroy container (+ volumes) |
| `session.share` | grant `session.*` on **this** session to another user, bounded by what you hold yourself (no privilege amplification) |

Ownership: `SessionConfig.ownerUserId` plus a `porterclaude.owner=<userId>` container label so
ownership survives losing `/data` (the adoption path in `sessions/service.ts` reads it back;
an unlabelled orphan is adopted as owned by the *adopting admin*, never by "everyone").
The owner implicitly holds every `session.*` on it except `session.share` when the granting
admin withheld it.

### 5.4 Bundled roles (what the UI actually offers)

| Role | Scope | Expands to |
|---|---|---|
| `admin` | instance | every permission at every scope |
| `auditor` | instance | every `*.read` + `instance.audit.read`, nothing mutating |
| `host-admin` | host | all `host.*` + all `session.*` on that host |
| `host-operator` | host | `host.read`, `host.images.read`, `host.agents.read`, `host.sessions.create`, and full `session.*` on **sessions they own** |
| `host-user` | host | `host.read` only — plus whatever session grants they were given |
| `session-user` | session | `session.read`, `session.use`, `session.use.agent`, `session.lifecycle`, `session.logs` |
| `session-observer` | session | `session.read`, `session.attach.readonly` |

Roles are sugar over the catalog; a grant may also carry a raw permission list, so
`{scope:'host:hetzner-1', perms:['host.read','host.tools.sync']}` is expressible without
inventing a role.

```jsonc
// config.grants[]
{ "userId": "u-9f3c1a2b", "scope": "host:hetzner-1", "role": "host-operator",
  "perms": null, "grantedBy": "u-admin", "grantedAt": "…" }
```

## 6. Session spec policy (the prerequisite from §2.1)

Per host, stored on the host config, enforced in `sessions/model.ts` + `container.ts` for
anyone who does **not** hold `host.sessions.admin`:

```jsonc
"policy": {
  "workspaceTypes": ["volume", "git"],            // "bind" off by default for non-admins
  "bindRoots": ["/srv/porterclaude/workspaces"],  // binds must resolve under one of these
  "extraMounts": "deny",                          // deny | allowlist | any
  "mountAllowlist": [],
  "images": { "recipes": "any", "custom": "deny" },   // or a registry/tag allowlist
  "ports": { "publish": false, "range": [30000, 32767] },
  "limits": { "maxCpus": 4, "maxMemoryMb": 8192, "maxSessions": 5 },
  "forbid": ["privileged", "capAdd", "networkHost", "pidHost", "userns", "deviceMounts"]
}
```

`forbid` is mostly about *keeping* those knobs unreachable — v0.2.1 never exposes them, and
the policy is what stops a future "advanced options" field from silently becoming a host
takeover for everyone holding `host.sessions.create`.

## 7. Agent credential isolation (the prerequisite from §2.2)

Per host: `agentAuthScope: "host" | "user" | "session"`.

* `host` — today's behaviour, `porterclaude-auth-<agentId>`; one login serves everyone. Correct
  for a team on one seat, and documented as *everyone on this host can read this login*.
* `user` — `porterclaude-auth-<agentId>-<userId>`. Note the constraint: volumes are attached at
  container **create**, not at terminal open, so a session carries the auth of its *owner*.
  Honest rule: the volume is picked by session owner; a session shared with others shares the
  owner's login. Anything finer means one session per user, which is cheap and fine.
* `session` — `porterclaude-auth-<agentId>-<session>`; log in per session, no sharing at all.

## 8. Audit log

Gated by `instance.audit.read`. Append-only JSONL under `<DATA_DIR>/audit/YYYY-MM.jsonl`,
rotated monthly, one line per mutating request and per terminal open/close:
`{ts, actor, actorName, ip, action, scope, target, result, detail}`. Cheap once the authorize
middleware exists (it already knows actor + permission + scope), and it is what separates
"multi-user" from *proper* user management when something goes wrong in a shared session.

## 9. Enforcement points — the actual work list

1. `auth/index.ts` — per-user verify, `req.user`, and `authenticateUpgradeRequest` must return
   the **user** instead of a boolean (its signature is marked FROZEN and is called from
   `terminals/ws.ts`).
2. `authorize(permission, scopeOf)` middleware + a `PermissionSet` resolver, applied to all
   **61 routes** across 8 routers.
3. **List filtering, not just route gating** — `GET /api/hosts`, `GET /api/sessions`,
   `GET /api/hosts/:id/docker/containers`, image/tools status: each must return the caller's
   subset, or the gate leaks the whole estate to every logged-in user.
4. `terminals/ws.ts` — resolve session → permission before attach; implement
   `session.attach.readonly` by dropping inbound binary frames; new close code `4403 forbidden`.
5. `sessions/service.ts` (1 996 lines, the largest file) — actor-aware `list`/`get`/`create`/
   `update`/`delete`, owner stamping, owner label, adoption rules, `reconcile` scoping.
6. `config/{schema,store}.ts` — `users[]`, `grants[]`, `SessionConfig.ownerUserId`, host
   `policy` + `agentAuthScope`; `CONFIG_VERSION` 3 + a v2→v3 migration writing `.v2.bak`.
7. New `server/src/users/{model,service,routes}.ts` and
   `server/src/authz/{catalog,roles,middleware}.ts`.
8. `GET /api/me` → `{user, instanceRole, permissions:{instance:[…], hosts:{…}, sessions:{…}}}`
   so the UI gates from the server's answer instead of re-implementing the rules.
9. Login by username + password; per-username rate limit and lockout on top of the current
   per-IP limiter.
10. Web: username field on login; a **Users** sub-tab (6th); permission-driven hiding/disabling
    in `sessions.js` (1 392), `hosts.js` (1 410), `agents.js` (685), `images.js` (566),
    `settings.js`; a share dialog; read-only affordance in `terminal.js` (903).
11. Tests: the context helpers in `server/test/*/helpers.ts` build an authenticated app, and
    all 474 existing tests route through them — the helper change ripples wide (mechanical),
    plus a new authz matrix suite.
12. Docs: promote this file to a design doc, update `docs/DEPLOYMENT.md` (first-admin
    bootstrap, upgrade note), `docs/AGENTS.md` (credential scope), `CHANGELOG.md`.

## 10. Effort

Assumes the same delivery pattern as v0.2 (planner → coders per topic → QA) and *includes*
migration, tests and docs.

| Phase | Contents | New/changed LOC | Human | This setup |
|---|---|---|---|---|
| **A — Identity** | users in config v3 + migration, per-user auth/JWT, login by username, `GET /api/me`, user CRUD API, Users panel | ~1 200–1 500 | 1–1.5 d | 2–3 h |
| **B — Authorization** | catalog + roles + grants, `authorize()` on 61 routes, list filtering, WS check, session ownership + label, grant editors in the UI | ~1 500–2 000 | 2–3 d | 3–5 h |
| **C — Containment** | session spec policy (§6), read-only attach, agent credential scope (§7), per-host quotas | ~800–1 200 | 1.5–2 d | 2–3 h |
| **D — Audit, hardening, docs, QA** | audit log, lockout, docs, full QA pass on the live host | ~500–800 | 1–2 d | 2–3 h |
| | | **~4 000–5 500** | **6–9 d** | **9–14 h** |

Cut-down variants:

* **Minimal (A + B without per-session grants)** — users, instance `admin`/`user`, per-host
  roles, sessions filtered by owner. ~2–3 human-days / 4–6 h here. Honest label: *multi-user
  convenience*. It is **not** a security boundary while §6 is missing: any user who can create
  a session on a host can reach that host's filesystem.
* **A + B + C** — the first combination that can be described as a security boundary between
  users. ~5–7 human-days / 7–11 h here.
* **Plus SSO (OIDC) or API tokens** — deliberately out of scope; ~1–2 days *after* §3 exists,
  because a second identity source is then only a new way to fill `req.user`.

Risk hotspots, in order: the v2→v3 migration (it touches `sessions[]`, which people have live
containers for); the adoption paths in `sessions/service.ts`; the FROZEN
`authenticateUpgradeRequest` signature; the test helpers; and frontend gating drift — which is
why §9.8 puts the answer on the server.

## 11. Open questions for the operator

1. Is the target *teammates who trust each other* (then Minimal + shared agent logins is right
   and §6 can follow later) or *users who must not reach each other's data or the host* (then
   C is mandatory and `bind` workspaces default to off)?
2. May several users attach to one session at once? Sharing a tmux pane means seeing each
   other's keystrokes — useful for pairing, surprising otherwise. Proposal: allowed, with a
   "2 viewers" badge on the pane.
3. Fold `host.delete` into `instance.hosts.delete`, or let a host-admin remove their own host?
4. Session names are globally unique today, which is what makes `session:<name>` usable as a
   scope key. Keep that, or move to `host:<id>/session:<name>` now, before grants make the
   change expensive?
