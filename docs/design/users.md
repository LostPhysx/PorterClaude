# Users and permissions (v0.3 proposal)

Status: **proposal / not implemented**. Written against shipped v0.2.2 (single shared
password, `sub:'admin'` JWT, 54 authenticated routes, one `config.json`).

The model is deliberately small: **one admin flag, two kinds of grant, no verbs.**

---

## 0. Vocabulary

v0.2 uses "session" for three unrelated things: the long-lived container, the shell you
open inside it, and the login cookie. v0.3 fixes that first, because every sentence below
depends on it (§7 has the mechanics).

| Word | Means | Lifetime | Was called |
|---|---|---|---|
| **host** | a docker engine PorterClaude talks to | permanent | host |
| **container** | one project's box: image, workspace, mounts, agents | long-lived — spun up per project, left running until the project ends | *session* |
| **session** | one connection to a shell inside a container | a working stretch — a day's work, closed at clock-out; survives a browser reload, dies when the pane is closed | *terminal* / *pane* |
| **login** | the authenticated browser, i.e. the cookie | until logout or expiry | *session* (cookie) |

A container is identified by `<hostId>.<container>` (§1); a session, when it ever needs a
full name, is `<hostId>.<container>.<session>`.

## 1. The model

| Principal | Can do |
|---|---|
| **Instance admin** | everything: hosts, credentials, agent definitions, general settings, users, grants, and every container on every host |
| **User** | **nothing** — until granted |

Two grants, both boolean. A user may hold any number of each.

| Grant | Points at | Means |
|---|---|---|
| **Host** | one `hostId` | everything about that host's containers — **create, define, delete** — plus everything a container grant gives, on **every** container there; see the host and its recipes/images; build an image and sync the tools volume |
| **Container** | one `<hostId>.<container>` | **operate and use** that one container: start, stop, restart, reset; read its definition, status and logs; open sessions in it |

The dividing line: **everything *about* a container is host scope; everything *inside* one is
container scope.** Existence (create, delete) and definition (image, workspace, mounts,
ports, limits, which agents and tools are attached) belong to the host grant. A container
grant runs the thing and works in it.

* **Reset** is delete-and-recreate of the docker container from the stored definition. The
  workspace and history volumes survive it, which is why it is safe to hand out: it is the
  "turn it off and on again properly" button, not a destructive one.
* **Configuring an attached agent** — logging Claude in, editing its settings — happens
  *inside* the container, so a session already covers it. **Attaching** a new agent or tool
  changes the definition, so it is host scope. (Tools are a host-level shared volume today;
  there is no per-container tool attachment to scope in the first place.)

Rules:

* Effective rights = the **union** of the grants. No deny rules, and no inheritance beyond
  "a host grant covers every container on that host".
* **A user without a host grant never creates a container** — not even the one they are
  permitted to use. It follows that a **grant cannot exist without its target**: a container
  grant may only be issued for a container that exists, and it is dropped when that container
  is deleted (§5.4). No grant ever waits for something to be created.
* A user with no grant sees an empty app: no hosts, no containers, nothing in Settings but
  their own password and layout.
* Only an admin creates users and hands out grants. A user can never grant anything — not
  even on a container they hold.

### The container identifier

A container name is unique **per host**, so the fully qualified identifier is
`<hostId>.<container>` — `hetzner-1.web`. Both halves are `[a-z0-9-]` only (`HostIdSchema`,
`SLUG_RE`), so a single dot separates them unambiguously. A container grant is exactly that
identifier:

```jsonc
{ "userId": "u-9f3c1a2b", "type": "container", "hostId": "hetzner-1", "container": "web" }
```

`canContainer(user, hostId, name)` is therefore a lookup, not a search. The UI shows the
bare `web` inside a single host's list and the qualified `hetzner-1.web` everywhere else —
grant editor, flat lists, search, toasts, session tab titles.

> **Prerequisite, and its own phase (§8).** v0.2.2 enforces names unique *across* hosts, and
> that invariant is what lets the terminal websocket route name → host with nothing else.
> Per-host names touch: the store's helpers (its public API is marked FROZEN), the flat
> `/api/sessions/:name` route shape, the websocket URL and the web client, and everywhere the
> UI keys a row or a pane by name. Docker-level names (`<prefix><container>`,
> `<prefix>ws-<container>`) stay unqualified — they only have to be unique per **engine** —
> and where one is already taken it gets a numeric suffix (§5.7).

## 2. Route map

The 54 gated routes fall into four buckets (`GET /api/health` and the `/api/auth/*` routes
stay public). Paths below are the post-rename ones (§7).

| Bucket | Routes | n |
|---|---|---|
| **Admin only** | host writes (`POST /api/hosts`, `PUT`/`DELETE /:hostId`, `POST /:hostId/default`, `POST /test` + `/:hostId/test`) · `/api/credentials/*` · `/api/hosts/:id/docker/*` · agent-definition writes (`POST /api/agents`, `PUT`/`DELETE /:id`) · `PUT /api/hosts/:id/agents` · `PUT /api/settings/general` — plus the new `/api/users/*`, admin-only by construction | 23 |
| **Host grant** on `:hostId` | `GET /api/hosts` (filtered, see below) · `GET /api/hosts/:hostId` + `/info` · `/api/hosts/:hostId/images/*` (recipes, build, jobs, job cancel, tools, tools/sync, pull, custom/validate, image list) · `GET /api/hosts/:hostId/agents` — **plus the container-meta routes**: `POST /api/containers` (create), `PUT /:name` (definition), `DELETE /:name`, `POST /api/containers/reconcile?hostId=` (without `hostId`, i.e. every host, it is admin only) | 18 |
| **Host grant on the container's host, or a container grant** | the operate-and-use routes: `GET /api/containers` (filtered) · `GET /:name` · `POST /:name/start` · `/stop` · `/restart` · `/recreate` (reset) · `GET /:name/logs` — and the session websocket | 7 |
| **Any logged-in user** | `GET /api/settings` + `/vendor` · `GET /api/agents` + `/:id` (needed to render the container form) · `POST /api/settings/password` (your own) · `PUT /api/settings/ui` (your own layout and theme, §5.1) | 6 |

Two consequences worth stating out loud, because they are where a route gate is not enough:

1. **Lists must be filtered, not just gated.** `GET /api/hosts` returns the hosts the caller
   has a grant on — plus, for a container-grantee, the one host their container lives on (id
   and name only, so the UI can render the row). The cross-host container list returns
   `containers on host-granted hosts ∪ granted <hostId>.<container> pairs`. Without this, the
   gate leaks the whole estate to everyone who can log in.
2. **`GET /api/hosts/:id/images/jobs/:jobId` is in the host bucket, but a container-grantee
   needs it** — since v0.2.2 a container prepares its host on create and hands the job id
   back in `preparing.jobs`, and an edit can trigger the same. Rule: you may read a job
   referenced by a container you hold. That is the one cross-bucket read, and it is a log
   stream, not a control.

`POST …/images/recipes/:name/build` and `POST …/tools/sync` stay in the host bucket even
though a container-grantee's **Start** or **Reset** can trigger them implicitly (v0.2.2
prepares the host for a container that needs it). That is intended and worth keeping
straight: doing the work because a container you may run needs it is fine; ordering it for
the host is not.

## 3. Data model

```jsonc
// config.users[]
{
  "id": "u-9f3c1a2b",          // stable, never reused
  "username": "alice",         // unique, [a-z0-9._-]{1,32}
  "displayName": "Alice",
  "admin": false,              // true = instance admin, ignores grants
  "passwordHash": "scrypt:…",  // same scheme as today
  "tokenVersion": 1,           // per user; a password change logs only that user out
  "disabled": false,           // keep grants, refuse login (and bump tokenVersion, §5.3)
  "ui": { "layout": null, "theme": "auto" },   // moved off config.ui — see §5.1
  "createdAt": "…", "lastLoginAt": "…"
}

// config.grants[]
{ "userId": "u-9f3c1a2b", "type": "host",      "hostId": "hetzner-1" }
{ "userId": "u-9f3c1a2b", "type": "container", "hostId": "hetzner-1", "container": "web" }
//                                             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                          together: the fully qualified id `hetzner-1.web` (§1)
```

That is the whole authorization state: a flag on the user and a flat list of grants. Every
grant references something that exists, and dies with it.

JWT becomes `{ sub: '<userId>', v: <user.tokenVersion> }` — same lifetime, cookie renamed
(§7). `config.auth.tokenVersion` stays as the global "log everyone out" switch.

**Migration v2 → v3**: the existing password hash becomes user `admin` with `admin: true`;
`APP_PASSWORD` keeps seeding that one user while no user exists (it only ever seeds when no
password is set, so this is unchanged behaviour). Stored containers are not touched beyond
the key rename — no owner field, because the model has no owner. Same shape as the v1 → v2
migration, and it writes `config.v2.bak`.

## 4. What the model cannot hide

None of these is a reason to build more machinery. They are facts an admin has to be told,
in the grant dialog and in `docs/DEPLOYMENT.md`.

**4.1 Writing a container definition reaches the host — so a host grant is a trust
decision.** Image, workspace and mounts are the author's to pick: `workspace:
{type:'bind', hostPath:'…'}` or an `extraMounts` entry aimed at `/` or the docker socket is
host takeover. Binds are already confined to `general.workspacesRoot`; `extraMounts` is
free-form. Minimal fixed rule, ~30 lines, no configuration:

> A non-admin may only create or edit a container whose `workspace.type` is `volume` or
> `git`, with an empty `extraMounts`. Admins keep both. A container that needs a bind is
> written by an admin and then granted.

Since definitions are host scope (§1), this rule only ever binds **host**-grantees and
admins — a container grant cannot reach it at all. Even with the rule, a host grant means
the grantee runs arbitrary code on that engine, publishes ports and can fill its disk. That
is what a host grant *is*; a container grant is not that.

**4.2 Agent logins are shared per host.** `porterclaude-auth-<agentId>` is mounted into
every container on the host, so anyone with a session on that host reads
`~/.porterclaude/agents/claude/.credentials.json` and the agent's conversation history —
including a user who holds a single container grant there. That is the *point* of the
feature on a single-operator install and a leak on a shared one. Unchecking "share history"
does **not** change it: that flag splits `~/.claude/projects`, never the login. The fix, if
it is ever wanted, is one line of naming (`…-auth-<agentId>-<userId>`, chosen at container
create) — out of scope here, on record so the trade-off is visible.

**4.3 Everyone inside one container is the same OS user** (`dev`, uid 1000). Sharing a
container means sharing a machine. The boundary is *which* containers you reach, never what
you may do once inside.

**4.4 A container's `env` is readable by everyone who can read the container**, so a host
grant exposes every env value on that host — including an API key someone pasted into the
form.

**4.5 No quota.** A host grant means unlimited containers, volumes and images on that
engine. "Manage containers on this host" reads milder than "fill this disk"; they are the
same sentence.

**4.6 A grantless user still sees a little metadata.** `GET /api/settings` carries the
general defaults plus host count, `defaultHostId` and `socketHostId`. It is configuration,
not secrets, and it stays readable — recorded so it is a decision and not an oversight.

## 5. Decisions the model forces

Consequences of "one admin, two grants", each already settled. Listed because they are work
items that are not obvious from §1, not because anything is undecided.

**5.1 UI state moves into the user record.** `config.ui` is one `{ layout, theme }` for the
whole install (`config/schema.ts:68`) — one GoldenLayout blob shared by everybody. Two users
would overwrite each other's workspace, and a stored layout can hold panes for containers
the next viewer may not open. So `ui` becomes a field on the user, `PUT /api/settings/ui`
moves to the any-logged-in bucket and writes to `req.user`, and `GET /api/settings` answers
with the caller's. Lands in phase A — a shared layout is visible on day one of the second
user.

**5.2 Internal callers act as the system.** Since v0.2.2 the preparation chain runs *after*
the request is over (build an image, sync tools, then create and start the container), and
`reconcile()` runs at startup with nobody logged in. Both call the same methods a user's
request does, so both would be refused by a check that assumes a logged-in caller. The check
takes an actor that is either a user or the system, and only the HTTP and websocket entry
points ever supply a real user.

**5.3 Revoking access closes open sessions.** A websocket is authorised once, at connect;
without this a pane stays live after the grant is taken away, until the server restarts.
Each connection is tagged with its user (`terminals/ws.ts` already walks its client list on
shutdown), and removing a grant, disabling or deleting a user closes the matching panes with
`4403`. Disabling also bumps that user's `tokenVersion`, which invalidates their cookie.

**5.4 Grants live and die with their target.** A container grant can only be issued for an
existing container, and deleting a host or a container removes every grant pointing at it —
the confirm dialog says how many. There is no such thing as a grant waiting for something to
be created, so a name can never be re-used into somebody's old permissions.

Deleting is host scope, so this is always someone else acting: a container-grantee cannot
delete themselves out of their own access, and cannot be surprised by their own click. What
they *can* do is **Reset**, which keeps the definition, the grant and the volumes.

**5.5 The last admin is protected.** Disabling, deleting or clearing `admin` is refused when
it would leave zero enabled admins.

**5.6 There is no default host for a container.** `create()` currently falls back to
`config.defaultHostId` when the request omits `hostId`, which would let a user granted one
host aim at another by leaving a field out. A container always states its host explicitly;
`defaultHostId` survives only as what the New Container form preselects, and the API rejects
a create without a host.

**5.7 A docker name that is already taken gets a numeric suffix.** Background, because the
terms are ours:

* The container on the engine is named `<prefix><container>` — derived, not stored. An
  **orphan** is such a container with no matching entry in `config.json`: the config was lost
  or restored from a backup, the entry was deleted while the container survived, or a second
  PorterClaude install shares that engine. **Adoption** is `reconcile()` writing an entry back
  for it, so it becomes a normal container again.
* Today `create()` refuses outright when `porterclaude-web` already exists on the target
  engine, and adoption is a host-level action.

So: the entry keeps the name it was granted, and the docker object becomes
`porterclaude-web-2` (then `-3`, …) when the plain name is occupied — same for the
per-container volumes. That means storing the resolved docker names on the entry instead of
deriving them, and looking containers up by their `porterclaude.container` +
`porterclaude.host` + `porterclaude.instance` labels, which are written on every container
already. It also removes an older sharp edge: two configured hosts pointing at the *same*
docker daemon can now hold same-named containers. Adoption stays a host-level action; it is
a repair, not a create.

**5.8 Two people in one session share one shell — and the UI says so.** Every pane runs
`tmux new-session -A -s pc_<name>`; the `-A` means *attach if it exists*, which is what makes
a browser reload drop back into the running shell. Two connections to the same pane therefore
land in the same tmux session: both see the same screen including the other's typing, either
can answer an agent's prompt, `Ctrl-C` from either ends it for both, and tmux sizes the
window to the **smallest** attached client — a laptop shrinks the 4K user's view while
attached. This is already reachable today with two browser tabs; grants only make the second
client a different person. It stays as it is, plus a **viewer count on the pane**: silent
mirroring is the problem, not mirroring.

## 6. Work list

1. `config/{schema,store}.ts` — `users[]`, `grants[]`, `CONFIG_VERSION` 3 + v2→v3 migration.
2. New `server/src/users/{model,service,routes}.ts` — user CRUD, grant add/remove, both
   admin-only. ~7 routes.
3. `auth/index.ts` — verify against `users[]`, put `req.user` on the request. The FROZEN
   `authenticateUpgradeRequest(req, ctx): boolean` must return the **user** instead of a
   boolean (called from the session websocket).
4. `authz.ts` — three predicates: `isAdmin(u)`, `canHost(u, hostId)`,
   `canContainer(u, hostId, name)`. That is the entire engine.
5. Apply them: `requireAdmin` on the admin bucket (one middleware, no arguments),
   `requireHost` on the host bucket, and per-call checks inside the container service
   (2 212 lines — actor-aware `list`/`get`/`create`/`update`/`remove`/lifecycle/`logs`).
6. **List filtering** in the host and container list paths, plus the job-read exception
   (both from §2).
7. The session websocket — the URL must carry the **host id** (today the container name
   alone is enough to route, which is exactly the invariant per-host names give up); then
   `canContainer` before attach, close code `4403` when it says no; viewer count broadcast
   (5.8).
8. The §4.1 spec rule in the container service, on create **and** update.
9. `GET /api/me` → `{ user, admin, hosts: [...], containers: [...] }` so the UI hides what
   the server would refuse instead of re-deriving the rules. This also replaces
   `GET /api/auth/session`, which frees that word (§7).
10. Login by username + password; keep the per-IP limiter, add a per-username lockout.
11. Web: username field on login; a **Users** sub-tab in Settings (list, add, password reset,
    disable, and a grant editor that is two pickers); gating driven by `/api/me`.
12. The §5 decisions: per-user `ui` (5.1), the system actor (5.2), revoke-closes-panes (5.3),
    grants dropped with their target (5.4), last-admin guard (5.5), `hostId` required on
    create (5.6), the docker-name suffix (5.7 — lands with phase 0, same naming code), the
    viewer count (5.8).
13. Tests: `server/test/*/helpers.ts` builds the authenticated app for all 480 existing tests
    — that helper change ripples wide but is mechanical — plus a matrix suite (admin /
    host-granted / container-granted / no-grant × the four buckets).
14. Docs: `docs/DEPLOYMENT.md` (first-admin bootstrap, upgrade note), `docs/design/api.md`,
    `CHANGELOG.md`, and the six facts from §4.

## 7. The rename (phase R)

`session` currently means the container (`sessions/` module, `/api/sessions`, `config.sessions[]`,
`porterclaude.session`), the shell connection (`terminals/`, tmux `pc_<name>`) and the login
cookie (`pc_session`, `GET /api/auth/session`). v0.3 gives each its own word (§0):

| From | To |
|---|---|
| `server/src/sessions/**` | `server/src/containers/**` |
| `server/src/terminals/**` | `server/src/sessions/**` |
| `/api/sessions` | `/api/containers` |
| `/api/terminals?session=&name=` | `/api/sessions?container=&session=` |
| `config.sessions[]` | `config.containers[]` (v2→v3 migration, same pass as §3) |
| `porterclaude.session` label | `porterclaude.container` |
| `pc_session` cookie | `pc_auth` |
| `GET /api/auth/session` | folded into `GET /api/me` (§6.9) |
| `web/public/js/sessions.js` | `containers.js`; terminal pane code keeps its file, renamed to `session.js` |

Two things stop this from being a blind find-and-replace:

* **The three meanings are interleaved in the same files.** Of ~2 690 occurrences of
  "session" in the repo, ~63 are the auth cookie and ~43 are tmux's own vocabulary
  (`tmux new-session`, `has-session`, `kill-session` — those stay). Only the remainder become
  `container`. The 672 occurrences of "terminal" become `session`, except where they mean the
  xterm.js widget, which is genuinely a terminal.
* **Live containers carry the old label.** Discovery matches on `porterclaude.session`, so a
  rename strands every running container. Rule: **write the new label, read either**, and drop
  the compatibility read in v0.4. The migration note in `CHANGELOG.md` says containers are
  relabelled on their next recreate.

Do this **first**, as its own commit, with no behaviour change in it — every later phase
references these names, and a rename mixed into a behaviour change is unreviewable.

## 8. Effort

Same delivery pattern as v0.2 (planner → coders per topic → QA), including migration, tests
and docs.

| Phase | Contents | New/changed LOC | Human | This setup |
|---|---|---|---|---|
| **R — Vocabulary** | the §7 rename, file moves, config key migration, label compatibility, docs sweep | ~3 300 touched, nearly all mechanical | 1–1.5 d | 2–3 h |
| **0 — Per-host names** | `<hostId>.<container>` everywhere: store helpers, service, route shape, websocket URL, web keying, existing tests — plus the docker-name suffix and lookup-by-label (§5.7) | ~600–900 | 1–1.5 d | 2–3 h |
| **A — Identity** | users in config v3 + migration, per-user auth/JWT, login by username, `GET /api/me`, user CRUD, Users panel, per-user `ui`, last-admin guard | ~1 000–1 300 | 1–1.5 d | 2–3 h |
| **B — Grants** | grant store + the three predicates, the four route buckets, list filtering, WS check, §4.1 spec rule, grant editor UI, the rest of §5 | ~1 000–1 400 | 1.5–2 d | 3–4 h |
| **C — Tests, docs, QA** | authz matrix suite, helper migration, docs, live pass on claude.example.com | ~300–500 | 0.5–1 d | 1–2 h |
| | | | **5–7.5 d** | **10–15 h** |

Phase B stays small because of what the model leaves out: no permission catalog, no roles,
no per-route permission names, no ownership, no audit log, no per-host policy object. Each
of those would land back in B if it were added later.

Risk hotspots, in order: **R** (it touches every file, and the three meanings of the word are
interleaved — the label compatibility read is what keeps live containers alive); **0** (it
re-keys what every other layer refers to, and `config.json` holds live entries); the v2→v3
migration; the FROZEN `authenticateUpgradeRequest` signature; the test helper change; and UI
gating drift — which is why §6.9 puts the answer on the server.

## 9. Open questions

None. The identifier is qualified everywhere except inside a single host's list (§1),
sessions mirror with a viewer count (§5.8), and grants cannot outlive or precede their
target (§5.4).
