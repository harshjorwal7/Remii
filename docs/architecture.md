# Architecture

Remii combines a React app, a Hono API server, PostgreSQL, AG-UI Bot endpoints, and governed browser computers.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/architecture-dark.svg">
  <img src="../assets/architecture-light.svg" alt="A turn goes from the app to the server, which sends it to a Bot over AG-UI. Every tool call the Bot makes returns through the gateway, which resolves the target, decides it against the configured policy, records an audit row, and only then acts, or refuses and names the rule. Allowed actions reach that person's own computer, one E2B sandbox holding its own desktop, Chromium, logins and workspace. Every decision lands in PostgreSQL, and so do threads.">
</picture>

Regenerate it with `bun run diagram` after changing anything it shows.

## Services and ports

| Component                | Port                       | Responsibility                                                                                                                              |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`                    | 3010                       | React/Vite interface for channels, Bot chat, live screen, and settings.                                                                     |
| `server`                 | 3001                       | API, the local agent runtime, auth, tenant package, coworkers, channels, policy, audit, credentials, plugins, components, and connectors.        |
| `agent-bot`              | 4200                       | Proof-of-concept AG-UI Bot.                                                                                                                     |
| `agent-langgraph`        | 4201                       | LangGraph AG-UI Bot.                                                                                                                        |
| `agent-harness`          | 4202                       | The Bot framework harness chosen during setup, one of the `agent-<framework>` images, behind the `harness` compose profile.                 |
| PostgreSQL with pgvector | 5432                       | Product data, audit rows, credentials, policy, grants, channels, threads, and components.                                                   |
| **A person's computer**  | none — over the E2B API | One E2B sandbox per person: XFCE, x11vnc, noVNC and Chromium, reached through E2B's Computer Use and process APIs rather than over a port of ours. |

`scripts/start.sh` starts PostgreSQL, `agent-bot` and `agent-langgraph` through Docker Compose, then starts `server` and `app` on the host.

### The computer, and why it has no port

There is no computer service in this deployment and no port to reach one on. Each person gets one
**E2B sandbox**, created the first time they need it and stopped by an idle sweep after a few
minutes of not being used. The API server drives it through E2B's own API — Computer Use for the
screen, mouse and keyboard, its process API for `computer_shell`, its filesystem API for file tools —
and the screenshots that reach the app are sampled from that rather than proxied from a browser.

Two things follow, and both are easy to get wrong when reading the rest of this document:

- **Existence is not running.** A stopped sandbox is still a sandbox, and `getInfo` answers for
  it happily. The provisioner therefore confirms `state === "started"` and wakes the machine if it is
  not, and it is that check — not the id in the database — which decides whether a command is safe to
  send. Skipping it does not fail loudly; every `computerUse`, process and file call comes back
  "failed to resolve container IP", which names the consequence and not the cause.
- **Nothing here needs a Docker socket.** There used to be a `supervisor` service whose whole job was
  holding that socket to spawn a Chromium container per Bot, and a matching `agent-computer` beside
  it. Both are gone, and neither was replaced by anything running on this host.

The compose file also defines optional SPIRE services. `start.sh` does not start them.

## Runtime flow

1. The app opens a channel or direct Bot session.
2. The server resolves the signed-in actor and selected coworker.
3. The local runtime sends the turn to the configured AG-UI endpoint.
4. The surface registers available frontend tools: browser tools, MCP tools, and components granted to that Bot.
5. Acting browser/file/MCP calls return to the server for authorization and audit.
6. The server streams results back to the app and persists the turn to the thread.

## Browser action governance

The computer itself does not decide policy. The server gateway is the action boundary:

1. resolve the target from the server-held snapshot or request subject;
2. evaluate the current action policy;
3. write an audit row for the decision;
4. call the computer only when the decision forwards;
5. write a second audit row if a forwarded action fails.

Policy rules can inspect:

- `tool.name`
- `intent`
- `bot.id`
- `actor.id`
- `page.url`, `page.host`
- `element.ref`, `element.role`, `element.name`, `element.type`
- `key`
- `command`
- `file.path`, `file.name`, `file.extension`
- `mcp.server`, `mcp.tool`, `mcp.effect`
- `initiator.kind`, `initiator.id` — what started the run, as distinct from whose
  authority it carries. `person`, `deployment`, `routine` or `handoff`, with the
  routine or Bot id where there is one. `actor.id` is the routine's owner on a
  scheduled run, so this is the only field that can tell an unattended run from
  somebody typing.

Rules use CEL expressions plus case-insensitive `contains()` and `matches()`.
Deny rules are evaluated before allow rules. The policy engine fails closed: a
missing or empty policy permits nothing, a broken deny rule denies, and a broken
allow rule does not permit. Remii's shipped startup default is explicit:
`deny: []` and `allow: ["true"]`, unless `AGENT_COMPUTER_POLICY` or a saved
policy replaces it. A malformed configured policy stops server startup.

## Computers

`COMPUTER_TOKEN` is required for an E2B deployment and the server refuses to boot without it: every
sandbox receives it as its service secret, so a missing one means every computer unreachable and no
explanation at the point of failure.

**One computer per person, not per Bot.** `COMPUTER_SUPERVISOR_URL` used to switch between one shared
browser and one container per Bot. There is no longer a shared browser to fall back to, and the
one-per-person sandbox is the only shape: every Bot belonging to a person works against that person's
machine and that person's files, and the `control` mechanism arbitrates when two of them would
otherwise move the same mouse at once.

Compose keeps PostgreSQL on a `data` network carrying only itself and `migrate`. A Bot has a shell,
and a shell reaches whatever its container reaches.

A command on the computer inherits PATH, locale and terminal names, and the proxy variables, not the rest of the process environment. Userinfo is stripped from a proxy URL. `COMPUTER_SHELL_ENV` names anything else a deployment wants passed.

There is no supervisor and no Docker socket in this deployment. It existed to spawn a container per
Bot, which needed a socket that no serverless platform permits; E2B gives each person a sandbox
instead and needs nothing from us.

## What started a run

Every audit row records on whose authority an action was taken. A routine asserts its owner, and a
hop between Bots asserts the person who began the conversation, so that column alone cannot say
whether anybody was there when it happened. An interactive run has somebody watching who will notice
a wrong tool call; an unattended one does not, which is the case worth being able to find.

Each row therefore also names what caused it:

| `initiator_kind` | `initiator_id`         | What it means                                          |
| ---------------- | ---------------------- | ------------------------------------------------------ |
| `person`         | none                   | Somebody was in the room. The default.                  |
| `deployment`     | none                   | The deployment itself, at start-up or refusing a caller it could not identify. |
| `routine`        | the routine's id       | A schedule fired it, as its owner, with nobody there.   |
| `handoff`        | the Bot that handed on | Another Bot asked for this, on the person's behalf.     |

The Audit screen filters on it, and **Nobody watching** is `routine` and `handoff` together, which is
the question of what ran on somebody's authority while they were away. `deployment` is deliberately
outside that filter: a boundary held at start-up is not work done on anybody's behalf.

`deployment` exists so the column never overclaims. A row that says `person` is a row a person caused,
and the two places that have no person at all, the start-up rows and the two unauthenticated boundary
refusals, say so rather than borrowing the default. A deployment that has never run a routine or a hop
sees `A person` on every row a person made, which is what it was before this existed.

The value travels inside the signed run assertion, beside `depth`, for the reason `depth` does: a hop
is one run on one pod handing to another run on another, and the process that knows a routine began
it is the one that claimed the routine, not the one writing the row. Anything holding the assertion
holds the answer, so a tool call, a hop offered or refused at the desk, a Bot stopping to ask its
person, and a stream that stalls all say the same thing without each being told separately. A Bot
cannot relabel its own run, because the assertion is signed by the deployment, and a kind this
deployment does not write is read as a person rather than kept.

Computer actions are the one family that carries no initiator, and correctly so: the computer tools
are browser actions, executed by the person's own session, so a headless run has no way to drive the
computer at all today. A row there is a person's because a person's browser wrote it.

## Human control and secrets

Handovers are audited as control events:

- `computer.help_requested`
- `computer.control_taken`
- `computer.control_released`

While a person controls the browser, Bot actions are refused rather than queued.

Secret entry is separate from chat content. The audit trail records that a secret was requested or supplied and the character count, not the secret value.

## Watching a Bot work

Two surfaces beside the conversation. The screen is the live browser, proxied over a websocket and gated on the same question as every other route about that Bot. The Activity tab is what the Bot did away from the browser: every command with its output and exit code, every file read, write and listing, newest first.

Activity is held in the browser for the open conversation and is gone on reload. It is a window rather than a record; the record is the audit trail, which is server-side, survives restarts, and is what an investigation reads. A saved file contributes its path and size and never its contents, matching the write route, which declines to echo them because a Bot may be saving something it was told in confidence.

## Coworkers and channels

A coworker is a durable Bot profile:

- `agents` stores runtime identity and endpoint/key reference.
- `agent_profiles` stores name, title, role, owner, visibility, and deletion state.
- `agent_preferences` stores per-user roster state.

A channel is a conversation with one coworker and a thread mapping. Starting a new channel creates a new thread.

Who may reach one is decided by membership: every channel route resolves the caller in
`channel_memberships` and refuses without a row. `channels.allowed_groups` is declared in the
tenant package and stored, and is not part of that decision — `users.groups` is never populated by
any sign-in path, so a group-based rule has nothing to evaluate. Treat it as a declaration waiting
on group membership from the identity provider, not as a control that is running.

See [coworkers.md](coworkers.md).

## Memory

Each person's memory lives in `memories`: durable facts with vector + full-text hybrid search,
scoped `global` / `persona` (theirs, every coworker may read), `chat` (one coworker's), or
`task` (one job's episode, visible only to agents on it). Nothing crosses users, and no agent
reads another agent's `chat` rows.

- **Recall gate**: before a run, a cheap pass decides whether the message needs memory and
  with which queries; hits are injected with citation ids. Greetings skip it entirely.
- **Write paths**: explicit `memory_save`, background extraction after turns (budgeted per
  day), handoff debriefs, and episode closes. Near-duplicates are skipped.
- **Consolidation** (nightly worker): merges duplicates, supersedes contradictions
  (user-stated beats inferred, newer beats older within a tier), sweeps forgotten rows
  (old, unimportant, never recalled, never pinned or safety), and closes stale task
  episodes into conclusions. Dry-run until `MEMORY_CONSOLIDATE_DRY_RUN=false`.
- **Entities**: `memory_entities` + links let recall resolve "everything about Project Y"
  by name instead of vector luck.
- **Observability**: `memory_events` records saved/recalled/cited per memory; the Memory
  settings page shows a person's facts, search, stats, and morning briefs.

## Routines

A routine is a standing instruction, created by asking a Bot in a channel rather than through a form,
that fires on a schedule and posts its reply into that channel as the person who created it.

The sweep that notices a routine is due sits beside the computer culler on one shared mechanism: both
write to `work_items`, one PostgreSQL table claimed with `select ... for update skip locked`, leases
timed on the database's own clock, and an attempt cap. Neither runs as a timer inside the API, because
a timer fires in every replica and each would decide independently that the same firing or the same
suspension is due; the queue is what lets exactly one claim it while every other replica's attempt
collides harmlessly with the same row. See [routines.md](routines.md).

## Components

Components are frontend tools a Bot can call instead of answering only in prose.

Sources:

- compiled React components in `app/src/components/gallery/`;
- components a Bot wrote itself, rendered from published sandboxed source and listed in the Components gallery under Settings (`/settings/components-gallery`).

Governance:

- compiled components are published when first seen by the app catalogue sync;
- sandboxed components are saved as drafts and become usable only after publish;
- every call asks the server whether the component exists, is published, and is not withheld from the Bot;
- component data functions require a separate per-component grant.

The shipped component data functions read the audit trail: `botActivity` and `recentRefusals`.

## One Bot handing work to another

A Bot can address another Bot, and the addressed one answers for itself rather than the first
relaying text on its behalf.

`message_bot` is offered beside a Bot's granted tools, so which Bots may reach which is an ordinary
grant: `plugin_grants` with a `bot` kind. A Bot granted nobody is offered nothing.

What it takes is typed. The asking model names the task, anything that bounds it and what a good
answer looks like, rather than writing a paragraph. Free text is the commonest way a handoff goes
quietly wrong: the receiving Bot infers the intent, guesses the constraints, and when it guesses
wrong it does not fail, it answers something else confidently.

Four things are decided by the deployment and never by the model:

- **Who is being addressed**, resolved against the roster the asking person may see. A Bot must not
  reach a Bot its person cannot, or this is a way around agent visibility. A Bot that does not exist
  and one that is not theirs to see are refused in the same words, so this cannot enumerate the
  roster.
- **Where the answer lands**, from the signed run assertion. Otherwise a Bot could drop a turn into a
  conversation it was never part of.
- **Who is asking**, stamped from the row this deployment wrote. A Bot able to write its own
  attribution could claim to be another one.
- **How deep the chain is**, also from the assertion, which is what stops A asking B asking C asking
  A for ever.

The second Bot runs as the same person, with its own role and its own grants, so it sees what that
person may see and no more.

**The answer lands in that Bot's own conversation with the person.** Not the conversation that asked,
and this is a property of the store rather than a choice: a thread is owned by
exactly one agent. So the conversation that asked says where the work went, and the one that answers
moves to the top of the roster with an unread mark. The person gets both halves.

What the answering conversation keeps is one line saying who asked and what for, not the envelope.
Those are two texts with two readers: the model needs the task, the constraints and the shape of a
good answer, while a person scrolling needs to know why that Bot suddenly spoke. The asking
conversation's history is read by the addressed Bot as context and is not repeated into the
transcript.

**A hop that fails for good is said out loud.** When one runs out of attempts, the asking Bot is sent
back into the conversation the person is watching to say plainly that nothing came back. Otherwise a
question handed on and never answered is indistinguishable from a slow one, and the conversation just
stops.

**A hop is claimed work, not a callback.** It is a row on the same queue the idle-computer culler
uses: the Bot being addressed is very unlikely to be on the pod that addressed it, and a hop held in
memory is lost the moment either is rescheduled. Every replica sweeps for hops and the queue decides
which gets which. The lease is renewed for as long as the run takes, because a run is minutes and a
lapsed lease hands the same hop to a second replica.

`BOT_HANDOFF_MAX_DEPTH` and `BOT_HANDOFF_MAX_PER_RUN` are the ceilings, and both refuse rather than
truncate. They are not polish: a hop is a whole agent turn at the other end, several Bots asked in one
turn cost several full runs, and where each Bot has its own computer a fan-out wakes a machine per
Bot. `BOT_HANDOFF_MAX_DEPTH=0` switches the capability off, and then no Bot is offered the tool and
the delivery loop does not run.

Every outcome is in the audit trail: offered, refused with which cap or missing grant stopped it,
delivered, failed, and retried. The refused row is the one that matters most, because a hop that
happened is visible in the transcript and one that was refused is invisible everywhere else.

### Asking a person

`ask_person` sits beside `message_bot` and competes with it for the same decision. A Bot that needs
judgement it does not have should stop and ask rather than guess or hand the question sideways to a
Bot that cannot settle it either; a model with no named way to stop takes one of the two it has.

It is offered to every run this deployment builds, whether or not that Bot has been granted anybody.
Reaching a second Bot spends a model call, may wake a computer and can fan out; asking the person
already in the conversation costs nothing and cannot be aimed anywhere they cannot see. A deployment
able to switch off the safe exit and keep the expensive one would be backwards.

Both tools are for Bots that run here. A Bot at its own endpoint runs its own loop and is handed
descriptions of the tools it may call back for, and the callback path executes MCP refs only, so
neither `message_bot` nor `ask_person` can reach it.

It is the Bot **doing the asking** that has to run here. Being handed work is not the same as being
able to hand it on, so the target of a grant may perfectly well live at its own endpoint. A grant
whose *grantee* is remote is refused rather than stored, so the refusal arrives at the point of
granting rather than from a Bot that never hands anything on.

That is a real limit rather than a detail, and it is worth being plain about which Bots it leaves
out: **a Bot created through the UI is a remote one**, because creating a coworker here means
pointing it at an AG-UI endpoint. Only Bots a tenant package declares as built-in run in this
process. So on a deployment with no package, nothing can be granted `message_bot` at all, and the
screens say nothing about why.

Who "a person" is, is a seam. This template answers the person in the conversation, which is the only
answer a template can give honestly; a company has an on-call rota or a duty desk, and that is a
route the deployment hands in rather than a channel post written into the tool. `agent.escalated`
records the question and why it needed a person; `agent.escalation_failed` records one that reached
nobody, which is the row worth finding later.

## MCP and skills

MCP servers and skills share the plugin grant table, but they have different ownership rules.

- MCP tools can reach external systems with stored credentials, so adding an app and granting its tools to a Bot are two separate acts, both made by the person whose Bot it is.
- Skills are reusable instructions. A person creates their own and attaches them only to Bots they own; a skill the tenant package ships is seeded on boot and visible to everyone, but still goes only onto Bots the grant names.
- A skill may also point at a public GitHub repository, which is content the skill carries rather than a capability it adds — see [A skill that points at a repository](#a-skill-that-points-at-a-repository).

The curated MCP catalogue contains Google Drive and Notion. Custom MCP servers must pass URL checks; unknown tools and custom-server tools are treated as writes unless positively classified as reads.

A catalogue entry says whose credential a Bot reaches it with, which is a different question from whether it is reachable at all. A deployment-wide token answers the same for everybody; Google Drive and Notion are both `user-oauth`, so a Bot reaches them as the person asking and sees only what that person can see. Adding the app under Settings → App connections and consenting to it with your own account are two decisions, and neither can be made for the other — there is no endpoint anywhere that completes a consent on somebody's behalf. See [Google Drive](plugins/google-drive.md) and [Notion](plugins/notion.md).

Every MCP call checks the grant first, then evaluates the same action policy engine with MCP context, then audits the result.

### A skill that points at a repository

A skill may name a public GitHub repository: an address, and optionally a branch and a folder inside it. A Bot holding that skill is offered three tools — an overview of the repository, a search, and one file at a time — bound to that repository and to nothing else. That is the whole of the feature, and it is what lets somebody write "answer from how this project actually does it" without transcribing the project into the skill.

**It is content, not a capability, and that is the only reason it needs no administrator.** A skill is writable by anybody signed in precisely because it can only ask a Bot for what that Bot was already granted. A public repository read at run time adds no tool, stores no credential and reaches no system this deployment does not already reach — it is code published to be read. That argument does not survive a private repository, so `repo-index.ts` accepts only a `github.com` address, builds every request against a constant host, and stores no token. There is no configuration that could point this at a company intranet.

**The grant is the gate, and the gate is on the server.** A repository is not reachable by knowing its address: every read checks that the named Bot carries the skill, so granting a skill to a Bot — which already requires owning both the skill and the Bot — is the only thing that makes its repository readable by that Bot. The browser resolves which repositories a run may read from the skills it already holds and passes them as an enum; the server checks the grant again on every call, and a slug the Bot does not hold is a 404 rather than a 403, because a 403 would confirm the slug exists and has a repository.

**The tools are registered in the browser**, beside the four `skill-creator` tools, for the reason those four are: a skill is invoked by the composer, and the browser is the only place that knows which skill is in play for a given run. They are the app's own rather than a connector's, so they are not `serverId/toolName` refs and appear in no `skill_tools` declaration — a skill with a repository and no declared tools narrows nothing and loads nothing, which is correct.

**Reading is bounded, and every bound says so.** A repository is unbounded and a context window is not. A cached index holds up to 5,000 file paths and up to 40 files whole — the README, the docs and the manifests, which is what search covers. Search is therefore a search of the file list and the documentation, and the tool description says so, because a tool that quietly under-reports lets a model state a negative it never established. A file read is cut at 2,000 lines and the reply says what it left out and how to ask for the rest. An oversized tree is marked `truncated` rather than failing, because a truncated file list is still useful and a hard failure on a monorepo would just be a dead skill.

**One request per save at most, and a day between refreshes.** GitHub allows sixty requests an hour to an unauthenticated caller, and this deployment shares that ceiling across every person using it, so a cached index is reused until it is a day old, and the Skills page shows when it was read with a button to read it again. `GITHUB_API_TOKEN` is optional and raises the ceiling to five thousand; unset, the refusal from GitHub is answered with the time the limit comes back and the name of the setting.

### Writing a skill in a conversation

A skill can be written from the composer as well as from `/skills`. The deployment ships a skill called `skill-creator` whose instruction is how to interview somebody about the skill they want; a Bot holding it is also offered four tools the app registers — `list_skills`, `read_skill`, `list_skill_tools`, and `save_skill`, which suspends the run on a card showing the command, the title and the whole instruction. Nothing is written until the person presses the button.

The grant is the gate. Those four tools are offered only while the Bot holds `skill-creator`, because four extra tools on every run costs the narrowing above what it exists to buy, and a Bot for looking up transactions has no business drafting skills.

They run in the browser as the signed-in person, through the same `POST /api/plugins/skills` the Skills page uses, so the ownership rules and the audit row are the endpoint's rather than a second copy of them: your own slug, the deployment's for a seeded one, and a refusal naming the slug for anybody else's. Written server-side, the tool would have to carry an actor into runs that do not have one — a routine, a Slack thread, a schedule — and the first way that goes wrong is a skill written under the wrong name. Nothing is lost by the restriction, because authoring is an interview and there is nobody to interview where there is no browser.

A saved skill is on no Bot yet. Granting it is the remaining step, and it stays on the Skills page, where a skill somebody wrote can go only on Bots they own.

### Which tools a run is offered

A model picks the right tool reliably out of about ten, and unreliably out of thirty. A deployment that connects two vendors passes that point on its first afternoon, so a Bot holding more than a handful of tools is offered, per run, only the tools of the skills that match the message.

Skills come from two places: a person writes one, or the tenant package ships one in `skills.yaml`. Package skills are seeded on boot as deployment skills, carrying the tool refs they need, which is what lets narrowing work on a fresh clone instead of waiting for somebody to map tools to skills by hand. A slug a person already took stays theirs and the package loses that skill rather than the deployment refusing to start.

A skill declares the tools it needs (`skill_tools`). Before the run starts, the deployment asks its own model which skills the message needs, and the Bot is built with those skills' tools plus every granted tool no skill claims. A declaration grants nothing: the offer is always intersected with what the Bot was already granted, so writing a skill can never hand anybody a tool.

This narrows the offer. It is not a boundary, and it never substitutes for one. The grant, the policy and the audit row decide what may happen; this decides only what the model can see. Every way it can fail — no skills declared, a model that cannot answer, a message that matches nothing, twelve tools or fewer — leaves the whole catalogue offered, because a narrowing that failed closed would remove capability somebody was granted, silently. `mcp.tools_discovered` records what was offered, out of how much, and why.

## Tenant package and knowledge

`TENANT_PACKAGE_DIR` points at the tenant package. The default is `../examples/fintech`.

Required package files:

- `brand.yaml`
- `agents.yaml`
- `channels.yaml`
- `model.yaml`
- `knowledge.yaml`

Optional: `skills.yaml`, `theme.css`, and an `agents/` directory holding a coworker per file, read
alongside `agents.yaml`. See [configuration.md](configuration.md#agents).

The server validates the package at startup. Channel agent IDs must match declared agents. Knowledge sources currently support Google Drive and Microsoft OneDrive declarations.

Connector credentials are stored through the credential vault and referenced by id, not stored inline in YAML.

## Security boundaries

- There are no roles and no administrators. Every signed-in person is a user, sovereign over their own data, and every query carries their id, so one user can never reach another's. `AuthenticatedActor.role` is typed `"user"` and cannot be anything else, which makes every admin bypass in the codebase dead by construction rather than merely unused; `INITIAL_ADMIN_EMAILS` is retired, and a value left in the environment stops the deployment starting rather than being ignored.
- Authorization is therefore per-row rather than per-role. A request that touches a Bot, a channel, a skill, a component or a credential resolves the caller's ownership first and refuses without it, and the same question is never answered twice in two places that could disagree. The one resolver answers both things a run asks about a person — whose threads these are, and which Bots they may run — so the two cannot drift apart.
- Sign-in is [Neon Auth](https://neon.com/docs/auth/overview), a hosted Managed Better Auth service, reached at one configured address. Its providers are Google, GitHub and Vercel: Microsoft, Okta, SAML and generic OpenID Connect are not reachable, because this product serves individuals directly rather than companies behind a directory, and the provider offers no route to any of them. `GOOGLE_OAUTH_*`, `MICROSOFT_OAUTH_*`, `OKTA_OAUTH_*`, `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` are no longer read.
- `/api/auth/*` is **proxied** to the provider by this server, rather than the browser reaching it directly. The provider's cookie is scoped to its own host, so a direct call would mean a cross-origin credential on every request and a session this API server cannot see — and `/api/me`, which every page loads, is answered here. The proxy renames the provider's `__Secure-neon-auth.session_token` to a `__Host-` prefixed cookie of this origin, so the browser holds a first-party cookie, the existing fetch layer needs no change, and `requireUser` keeps reading a cookie out of the request headers exactly as before.
- Which buttons the sign-in screen draws is **the provider's answer**, read at start-up from the branch's `neon_auth.project_config` rather than configured here — a list written in the environment would be a second thing to keep in step with the provider, and the drift would show up as a button that fails on somebody's first attempt.
- **A social sign-in does not finish through the proxy, and this is structural rather than a missing feature.** The OAuth callback lands on the *provider's* host, so the provider sets its cookie there and this origin never receives it; the cookie is `HttpOnly` and host-scoped, so it cannot be handed over either. `NEON_AUTH_PROVIDERS=none` therefore exists, and a deployment that has not settled this ships email and password alone rather than a Google button that returns a person to the screen they just left. [deployment.md](deployment.md#neon) says what would have to change.
- `public.users` stays this product's own table and 39 foreign keys keep pointing at it. A person who signs in is matched by `neon_auth_user_id` and, failing that, by email, so an account that predates the switch keeps its conversations rather than coming back as a stranger with an empty set of foreign keys.
- Signing in writes an audit row. There is nobody to refuse and nobody to revoke: every account that can authenticate may sign in, and its own data is the only thing it can reach.
- With no identity provider configured, the deployment refuses to start unless `REMII_SINGLE_USER=true` says every request may be one fixed local user. That flag is the only thing that permits it; `NODE_ENV` does not.
- `KEY_ENCRYPTION_KEY` must be a base64-encoded 32-byte value. The example key is refused with `NODE_ENV=production`.
- Credential plaintext is encrypted at rest, never returned by APIs, and redacted from audit events.
- Browser navigation allows `http` and `https`; cloud metadata addresses are refused under every configuration.
- `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true` is for local development only, and a deployment running with `NODE_ENV=production` refuses to start while it is set.
- `COMPUTER_TOKEN` must be a long random value outside local development. It is the only secret a
  computer holds, and every sandbox receives it as its service secret.
