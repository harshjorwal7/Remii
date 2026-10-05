# Configuration

Remii is configured with environment variables and a tenant package. The API server validates both at startup.

## Environment setup

```sh
cp .env.example .env
```

Fill the required values, then run:

```sh
bash scripts/start.sh
```

## Required API server variables

| Variable               | Meaning                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | PostgreSQL connection string. Threads, messages, runs and locks live here; nothing cloud is needed.  |
| `KEY_ENCRYPTION_KEY`   | Base64-encoded 32-byte key for encrypted stored credentials. Generate with `openssl rand -base64 32`. |

Both above stop server startup if missing. Legacy `INTELLIGENCE_*` variables are ignored when present.

`MANAGED_AGENT_AG_UI_URL` names the Bot in the box: the default endpoint for coworkers created in
the product. It needs `MANAGED_AGENT_TOKEN` beside it, or the server refuses to start. Unset, the
server starts without a managed Bot, the shipped Risk Analyst coworker is omitted, and creating a
coworker without its own endpoint is refused. A leftover token with no URL is ignored. The
one-container image has no Bot process, so leave the URL unset there. `scripts/start.sh` points it
at `agent-langgraph` on a laptop.

## General variables

| Variable             | Default                            | Meaning                                                             |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `PORT`               | `3001`                             | API server port.                                                    |
| `NODE_ENV`           | unset                              | `production` refuses the example `KEY_ENCRYPTION_KEY`. It does not decide whether sign-in is required; see `REMII_SINGLE_USER`. |
| `TENANT_PACKAGE_DIR` | `../examples/fintech`              | Tenant package directory, resolved from `server/`.                  |
| `DEPLOYMENT_ID`      | the tenant package's id            | Names this deployment inside a shared Intelligence project.          |
| `OPENAI_API_KEY`     | unset                              | Default model key for built-in agents and both shipped Bots.        |
| `OPENAI_BASE_URL`    | unset                              | OpenAI-compatible endpoint that key is spent against. See below.    |
| `BOT_PROVIDER`       | `openai`                           | Provider for `agent-langgraph`: `openai`, `anthropic`, or `google`. |
| `ANTHROPIC_API_KEY`  | unset                              | Anthropic key when `BOT_PROVIDER=anthropic`.                        |
| `ANTHROPIC_BASE_URL` | unset                              | Anthropic-compatible endpoint that key is spent against.            |
| `GOOGLE_API_KEY`     | unset                              | Google key when `BOT_PROVIDER=google`.                              |
| `GOOGLE_GENERATIVE_AI_BASE_URL` | unset                   | Google-compatible endpoint that key is spent against.               |
| `BOT_MODEL`          | provider default from Bot code/env | Model for the framework Bot (`agent-langgraph`). Provider defaults are `gpt-5.5`, `claude-sonnet-4-5`, and `gemini-2.5-flash`. |
| `AGENT_BOT_MODEL`    | `gpt-5.5`                          | Model for the proof-of-concept Bot (`agent-bot`), kept separate because it speaks `/v1/chat/completions` directly and refuses a model it cannot use. |
| `BOT_RESPONSES_API`  | `false`                            | Makes `agent-langgraph` use the OpenAI Responses API.               |
| `BOT_REASONING_EFFORT` | unset (provider default)         | OpenAI and the Responses API only: one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `agent-langgraph` refuses to start on any other value, on a non-`openai` provider, or without the Responses API. |
| `AGENT_STALL_TIMEOUT_MS` | unset (off)                    | How long a Bot's stream may produce nothing before the turn is ended for it. |
| `AGENT_TOOL_TOKEN`   | unset; `start.sh` generates one    | The secret a framework Bot presents when it calls a granted tool back through this server. |
| `APP_DIST_DIR`       | unset                              | Where the built app is, when this process serves it. Set inside the container image; unset in development, where Vite serves the app. |
| `AUDIT_RETENTION_DAYS` | unset                            | Whole number of days to keep audit rows; older ones are removed. Unset keeps the trail forever. |
| `WORKER_SHARED_SECRET` | unset; `start.sh` uses a fixed local default | The secret the routines worker presents to fire a due routine. Without it the server refuses every handoff, whether or not a worker exists to send one. |
| `REMII_GENERATIVE_UI` | unset (capability on)               | Set `false` or `0` to stop Bots from answering with generated interfaces. |
| `COMPOSIO_API_KEY`   | unset                              | One key for the whole deployment, for the broker that holds people's accounts for a few hundred apps. Unset, there is nothing to connect, nothing to grant and no Composio tool for a Bot to call, and the directory under Settings → App connections is not drawn at all. See [Composio](plugins/composio.md). |

**`REMII_GENERATIVE_UI`** enables generated interfaces by default: streamed HTML/CSS/JavaScript
in a sandboxed iframe, and A2UI interfaces built from the SDK's declarative components. A2UI buttons
send their named action and selected values back to the current conversation's Bot.
Set `REMII_GENERATIVE_UI=false` or `0` to disable both. `true`, `1`, an empty value, or an unset
value leave the capability on. The server configures both runtime renderers and reports the same
setting through `/api/capabilities` to the browser.

The component catalogue has separate per-Bot grants. Its sortable data table (`showTable`),
interactive form (`askForm`), and other compiled or generated components remain governed
by those grants. A component written in the browser is saved as a draft and becomes usable only
after publish; only published code renders in conversations, and the Components gallery under
Settings lists what is published and nothing else.

Generated HTML runs without the app's session or same-origin access to its data. It can load
libraries from a CDN; deployments that prohibit that browser traffic can disable generated UI.

**`AGENT_STALL_TIMEOUT_MS`** watches for the failure a Bot has that nothing else in the trail can
show: a stream that stops producing anything. Every other audit row is something that happened, and
this one is the absence of anything happening, which leaves no trace of its own. Ending the turn
writes `agent.stream_stalled`. Unset or `0` switches it off and nothing is watched. `.env.example`
ships `60000`, so a new clone has it on and an upgraded deployment does not acquire it unasked.

**`AGENT_TOOL_TOKEN`** exists because a framework Bot runs its own loop in its own process and still
may not reach a vendor directly. It calls the deployment that granted the tool, which is where the
grant, the policy and the audit row live. Absent, no Bot may call tools back, and it is told so
rather than quietly allowed.

That default is right for a deployment and wrong for a laptop, where it meant every granted MCP tool
was refused before it reached the grant, the boundary or the trail — and a refusal at that point is
not visible in the transcript, so a Bot reported no results rather than an error. `scripts/start.sh`
therefore generates one and writes it to `.env`, as it already does for `MANAGED_AGENT_TOKEN`. A
value already set is kept.

It is one of a pair, and they are not interchangeable: `MANAGED_AGENT_TOKEN` is the server proving
itself to a Bot, this is a Bot proving itself to the server. Rotating either means the process
holding the old one refuses every call, which is why `start.sh` restarts the server and recreates the
Bot containers on a run that mints one.

**`WORKER_SHARED_SECRET`** is the same shape of secret for a different pair: it is what the routines
worker presents to `/internal/routines/run` to prove a routine's dispatch actually came from it. The
API server refuses a handoff without one configured, and the worker refuses to start without one at
all. See [routines.md](routines.md) for what a deployment with no worker at all looks like — the
Routines page says so when nothing has swept.

Unlike `AGENT_TOOL_TOKEN`, `start.sh` does not generate and persist this one. It supplies a fixed
local default, `remii-dev-worker-secret`, the same value every clone of this repository gets. That
is fine here not because of where the server listens — it binds no hostname, so the port itself is
reachable like any other — but because this is a dev-only default on a machine's own dev stack, and
the endpoint it guards accepts nothing but an unguessable `routine_run_<uuid>` id: the server
re-reads the routine, the owner and the channel from its own tables rather than trusting anything
else the caller says, so a well-known value from a public repository gates nothing sensitive here.
`AGENT_TOOL_TOKEN` is generated fresh and written to `.env` precisely because it is not that: it is
copied into every Bot container, and a framework Bot holding it may be running on a machine of its
own, so a fixed default there would be no boundary at all. Production deployments must set a real
`WORKER_SHARED_SECRET`.

**`SERVER_INTERNAL_URL`** is read by the worker, not by the API server, so it is not in the table
above: it says where the worker's own process can reach this deployment's API, which is a fact about
where the worker runs rather than a fact about the deployment `loadConfig` describes. `start.sh` points
it at the server's own port on a laptop; the Helm chart's routines CronJob points it at the server's
in-cluster Service address.

## OpenAI-compatible endpoints

`OPENAI_BASE_URL` decides where an OpenAI-shaped request is answered. Unset, that is OpenAI. Set, it is any endpoint speaking the same API: a gateway in front of several providers, a proxy, or a model on hardware you control.

It moves the whole deployment rather than one Bot. The API server reads it for package built-in agents, `agent-bot` reads it for the client it constructs, and `agent-langgraph` reads it for `BOT_PROVIDER=openai`.

`OPENAI_CONTAINER_BASE_URL` overrides that value inside the Bot containers only, for an endpoint the containers reach by a different route than the host does. Unset, the containers use `OPENAI_BASE_URL` like everything else.

The other two providers work the same way under their own names, because they are different APIs rather than different URLs for this one: `ANTHROPIC_BASE_URL` and `GOOGLE_GENERATIVE_AI_BASE_URL`. All three are the names the API server already reads, so one line moves the built-in agents and the Bots together and a deployment cannot end up with half of itself pointed somewhere else.

Model names travel verbatim, so use whatever the endpoint publishes. An endpoint that namespaces its catalogue wants both halves of the name, in `BOT_MODEL` and in the tenant package's `default_model` alike.

A gateway that fronts several providers behind one key is addressed the usual way:

```sh
OPENAI_BASE_URL=https://gateway.internal/v1
OPENAI_API_KEY=...
BOT_MODEL=openai/gpt-5.6-terra
```

and in the tenant package, where the name is namespaced the same way:

```yaml
model:
  provider: openai
  credential_secret_ref: openai-api-key
  default_model: openai/gpt-5.6-terra
```

Most gateways publish a model list, which is the way to check a name before configuring it.

Two things are worth knowing before pointing a deployment at any gateway. Not every catalogue entry accepts tools, and a Bot without tool calling cannot drive its computer; the model list says which do. And `BOT_RESPONSES_API=true` needs an endpoint that implements the Responses API, not only chat completions.

## Authentication

Sign-in is [Neon Auth](https://neon.com/docs/auth/overview), a hosted identity provider reached over
HTTPS. It holds the OAuth clients, the session secret and the trusted-origin list on its own side,
per branch, so the configuration here is an address rather than a set of credentials.

| Variable              | Meaning                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `REMII_SINGLE_USER`   | One fixed local user and no sign-in. **Required** when `NEON_AUTH_BASE_URL` is unset, or the deployment refuses to start. Ignored when it is set. |
| `NEON_AUTH_BASE_URL`  | The provider's address, `https://…neonauth…/neondb/auth`. Required for sign-in. Written into `.env` by `neon deploy`. Must be `https://`. |
| `AUTH_EMAIL_PASSWORD` | `true` draws the email-and-password form. Whether the provider *accepts* one is its own setting, read at start-up from `neon_auth.project_config`, and overrides this. |
| `NEON_AUTH_PROVIDERS` | Comma-separated provider ids for the buttons on the sign-in screen. Normally unset: the server reads the branch's own configuration at start-up. **`none` draws no social buttons** — see the note below, because a social sign-in does not currently finish. |
| `TRUSTED_ORIGINS`     | Comma-separated app origins this deployment serves.                                     |
| `REMII_PUBLIC_URL`    | This deployment's own address. Sent as `Origin` on every call to the provider, which checks it against the branch's trusted-origin list. |
| `REMII_APP_URL`       | Where the browser app is served. Defaults to the first `TRUSTED_ORIGINS` entry, then `REMII_PUBLIC_URL`. |
| `INITIAL_ADMIN_EMAILS`| Retired, and **refused**. No administrators exist, so a value left in the environment stops the deployment starting. |

**Provisioning.** With `auth: true` in `neon.ts` at the repository root:

```bash
neon link --project-id <project-id> --branch production
neon deploy
```

`neon deploy` provisions the provider on the linked branch and pulls `DATABASE_URL` and the
`NEON_AUTH_*` variables into `.env`.

**Why `https://` is required.** The provider's session cookie is `__Secure-` prefixed, and a browser
refuses a `__Secure-` cookie that did not arrive over TLS. An `http://` address therefore produces a
sign-in that appears to succeed and leaves no session.

**A social sign-in does not finish, and `NEON_AUTH_PROVIDERS=none` is how a deployment ships without
one.** Google redirects to the *provider's* host, the provider sets its session cookie there, and the
browser returns to this application holding nothing for this origin — so a proxy of `/api/auth/*` is not
enough and the person appears to have been refused by Google. Nothing errors; they simply arrive back
at the sign-in screen.

The cookie cannot be handed over to fix it. It is `HttpOnly`, so no script can read it, and it is
scoped to the provider's host, so a page here cannot send it here either. The provider also refuses a
bare `session.token`: `GET /get-session` reports the first half of a two-part signed value, and posting
that is answered `null`. Both verified rather than assumed, because the shape of that endpoint suggests
it should work and it does not.

So set `NEON_AUTH_PROVIDERS=none` with `AUTH_EMAIL_PASSWORD=true` and this deployment offers a way in
that works. [deployment.md](deployment.md#neon) writes down what would have to change to restore
Google.

**The providers available are `google`, `github` and `vercel`.** Microsoft, Okta and company SAML or
OIDC are not reachable: the provider offers no route to any of them. `GOOGLE_OAUTH_*`,
`MICROSOFT_OAUTH_*`, `OKTA_OAUTH_*`, `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` are no longer read,
and setting them has no effect rather than a partial one. This product serves individuals directly
rather than companies behind a directory.

**Where the Google callback is registered.** `<NEON_AUTH_BASE_URL>/callback/google`, and no trailing
slash before `/callback`. The OAuth consent screen shows Neon rather than this product while the
provider is on its shared development credentials, so a deployment that needs its own name there
supplies its own Google client through `neon neon-auth oauth-provider add`.

**`REMII_PUBLIC_URL` and `REMII_APP_URL` matter only for a connector each person connects their own account to**, such as Google Drive.

`REMII_PUBLIC_URL` builds the redirect URI the vendor sends somebody back to after they consent, which has to match what you registered with that vendor character for character — so it comes from configuration rather than from the incoming request. Most deployments never set it, because `NEON_AUTH_BASE_URL` is already on the same public address. With neither, the app's own page says the deployment cannot complete a consent flow, and no account can be connected.

`REMII_APP_URL` is where the callback sends the person afterwards. It is a separate setting because the app and the API can be separate addresses: locally the app is Vite on `3010` and the API is `3001`, so a relative redirect would land on the API, which serves no pages. A deployment serving both from one origin can leave it unset.

A [Composio](plugins/composio.md) app needs `REMII_APP_URL` and nothing else of the two: the consent lives at the broker, so no redirect URI of ours is registered anywhere, but the address Composio returns somebody to has to be absolute and this is where it comes from. Connecting a brokered account refuses where it resolves to nothing, rather than sending somebody to a consent screen with no way back.

## One Bot handing work to another

| Variable                   | Meaning                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `BOT_HANDOFF_MAX_DEPTH`    | How many Bots deep a chain may go. `1` is two Bots, `2` is three. `0` switches the capability off entirely. Default `2`.    |
| `BOT_HANDOFF_MAX_PER_RUN`  | How many other Bots one run may address. Default `3`.                                        |

Both refuse rather than truncate, and both are refused at start-up if they are not whole numbers of
zero or more: a deployment that typed `two` and silently got the default would believe it had set a
cap.

## How Bots act

| Variable                | Meaning                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOT_EXECUTION_MODE`    | Deployment default: `direct` (do what was asked, immediately) or `ask-first` (external actions wait for the person's word first). Default `direct`. |
| `WEB_SEARCH_API`        | Bearer key for the live web-search endpoint behind the Remi `web_search`/`web_open` tools. Unset, the tools are not offered.                        |
| `WEB_SEARCH_URL`        | Search endpoint base URL. Default `https://web.freeapi.space`.                                                                                      |

`BOT_EXECUTION_MODE` refuses anything outside the closed set at start-up. A person overrides the
default for themselves on **Settings → General → Execution mode**: direct, ask-first, or inherit
the deployment default. Internal work (reading, organizing, remembering, answering) is never gated
either way; the switch is about effects on the world.

## The Remi engine

Built-in Bots run the ported Remi ReAct loop (up to 40 tool steps a turn, parallel calls, model
fallback, truncated tool results) over OpenAI-compatible chat completions, emitting the same
AG-UI events the previous runtime did — transcript, persistence, metering and handoff are
unchanged. What the loop is told (role, instructions, grants, computer prose) is unchanged too.

| Variable                 | Meaning                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `DEEPSEEK_API_KEY`       | DeepSeek fallback link (`deepseek-chat`).                                                                                |
| `OPENROUTER_API_KEY`     | OpenRouter fallback link (`OPENROUTER_MODEL`, default `openai/gpt-4o-mini`).                                             |
| `NOVITA_API_KEY`         | Novita fallback link (`NOVITA_MODEL`, default `deepseek/deepseek-v3-0324`).                                              |
| `GEMINI_API_KEY`         | Telegram voice transcription and photo description. Unset, media arrives as captions with a note.                        |
| `COMPOSIO_TRIGGER_SECRET`| Shared secret Composio trigger webhooks must carry. Unset, events are accepted when they resolve to a local user.       |

Model fallback covers an outage, never a missing configuration: with no key for the deployment's
own model the turn fails fast naming the variable. The loop speaks OpenAI-compatible chat
completions, so `BOT_PROVIDER=anthropic` resolves only through `ANTHROPIC_BASE_URL` pointed at a
compatible endpoint. Composio app events arrive at
`POST /api/webhooks/composio` and resolve to a local user (metadata id, connected account,
payload email), fire a matching automation first, and otherwise file a todo through the junk
filter and a model triage. Redelivered events file nothing twice.

## Voice, screen and local Google

| Variable                 | Meaning                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `ELEVENLABS_API_KEY`     | Spoken Telegram replies (voice notes earn voice answers). Unset, everything stays text.                                  |
| `ELEVENLABS_VOICE_ID`    | Which voice answers. Unset, the default voice.                                                                           |
| `GOG_BINARY`             | Path to the `gog` CLI for Google Workspace tools. Unset, resolved off PATH; missing means the tools stay home.          |

`Settings → Computer` is where the app reports what is connected on this machine: the screen
and voice configuration, plus the gog binary with its auth state. Google auth itself happens once on the machine
(`gog auth add …`), never in the product.

## Browser computer

There is one. It is an E2B sandbox per person — see [The computer](#the-computer) below.
`REMII_ONE_COMPUTER_EACH` used to park it (`false` meant no routes and no `computer_*` tools)
and both it and the E2B addresses it gated are gone; the switch described a container layout that
no longer exists, and leaving it in a reference document was worse than deleting the section.
Workspace files were never the computer's — `artifact_*` covers them.

Which Bots may address which is a grant, not a variable, and no Bot may address any other until one
is made. It is made on the Bot's own screen: open it from **Agents**, and switch on each Bot under
**Bots it may ask**. The pair is directional: that list is who this Bot may ask, not who may ask it,
so letting them ask each other is two switches. Only the Bot's owner may change it; anyone who can
see the Bot can read it.

With both caps above at zero the screen says the capability is switched off, because a grant made
then is a row nothing will read.

## The computer

A computer is an **E2B sandbox**, one per person. There is no computer container in this deployment and
no port to reach one on. The API server drives the desktop through E2B's own API, and the live screen
is **noVNC talking RFB straight to the sandbox** — the browser connects to the desktop and the server is
not in the data path at all.

| Variable                             | Meaning                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `E2B_API_KEY`                        | **The whole trigger.** Present means the computer exists; absent means the server mounts no computer routes. Server-side, never reaches React. |
| `E2B_API_URL`                        | E2B API base. Only for a self-hosted control plane; E2B's own default is right for the hosted product. |
| `COMPUTER_TOKEN`                     | **Required** once `E2B_API_KEY` is set. The server refuses to boot without it.              |
| `E2B_TEMPLATE`                       | The template every desktop is built from. `desktop`, which is E2B's own.                      |
| `E2B_AUTOSTOP_MINUTES`               | Idle minutes before a desktop is **paused**, as a backstop for this process dying. Never shorter than the idle sweep, whatever it says. `10`. |
| `E2B_SANDBOX_TIMEOUT_MS`             | E2B's own kill-clock. A sandbox reaching `timeoutMs` is **deleted**. The server pushes it forward while a computer is in use, so it is a backstop. |
| `E2B_MAX_DESKTOPS_PER_USER`         | How many of one person's computers may run at once.                                           |
| `E2B_VOLUMES`                        | Whether each person's files live on their own E2B volume. On by default; only the literal string `false` turns it off. |
| `E2B_WORKSPACE_MOUNT`                | Where that volume appears inside the sandbox. `/workspace`. Also what a tool's relative paths resolve against, which is why the two live in one place in the code. |
| `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | Local-only private-host browsing when `true`. A deployment running with `NODE_ENV=production` refuses to start while it is set. Cloud metadata addresses are refused either way. |
| `AGENT_ENDPOINT_ALLOWED_HOSTS`       | Private addresses an agent may be registered at, comma separated; unset (none) by default. Host, optionally with a port. Exact match; no wildcards. Never-allowed addresses cannot be named. |
| `AGENT_COMPUTER_POLICY`              | JSON action policy: `{"mode":"enforce","deny":[...],"allow":[...]}`.                      |

### The live screen is noVNC, and that is why it is not laggy

The screen used to be a frame sampler. The server called a remote screenshot API once per frame,
base64'd the JPEG and pushed it down a websocket; the browser decoded it, and every mouse move the
person made went back up the same socket and out through another round trip. The frame rate was
therefore the platform's latency and never more than 8fps, and a click landed a frame and a half after
the hand stopped moving — so somebody who took the wheel clicked, saw nothing happen, and clicked
again.

E2B exposes the sandbox's own port, so the browser now speaks RFB directly to the desktop. Only the
rectangles that changed are sent, input never passes through the server, and latency is a property of
the network rather than of how many API calls a picture costs.

`GET /api/computers/desktop/stream` returns a **URL and a per-session password, separately**:

```json
{ "url": "https://6080-<id>.e2b.app/vnc.html?autoconnect=true", "authKey": "…", "width": 1920, "height": 1080 }
```

The password is returned beside the URL rather than inside it because a URL is what ends up in a proxy
log, in browser history and in a `Referer` header. It is a 16-character string minted by x11vnc when
the stream starts and dead when it stops — knowing it buys control of that one desktop until it is
restarted, and nothing else. The `E2B_API_KEY` never leaves the server process.

`requireAuth: true` is not configurable and is not optional. `@e2b/desktop` starts x11vnc with `-nopw`
unless told otherwise and the noVNC host is a public hostname, so the default is an unprotected desktop
with a person's files mounted on it.

### Paused is not the same as gone, and it is cheap

`daytona.get` answering happily for a stopped sandbox is a bug this file is named after: "the row names
a sandbox" and "the sandbox will accept a command" are two different facts, and conflating them produced

```
Bad request: failed to resolve container IP after 3 attempts: no IP address found.
```

on every screen, shell and file call made minutes after anyone last touched a computer. On E2B the same
confusion has a different face — `Sandbox.connect` **resumes** a paused sandbox as a side effect, so
using it to ask whether a machine is up would mean the idle pause is defeated by a status page being
polled. `Sandbox.getInfo` is the check that wakes nothing, and the provisioner uses it for exactly that.

A pause is also the right idle policy, where a stop was not. E2B's memory pause restores the desktop
with its windows, its browser session and its running programs, and returns in seconds. `kill` is never
called: a person's disk is their data, and a platform deciding to throw a machine away on a schedule is
not a persistence story anybody can rely on.

### The kill-clock is a hard ceiling, and the server pushes it forward

E2B deletes a sandbox at `timeoutMs` — one hour on Hobby, 24 on Pro. A person watching a long-running
task would otherwise lose their machine at the one-hour mark and find out from a dead screen, so the
provisioner's `heartbeat` pushes the clock forward for as long as somebody is using the computer.
`E2B_SANDBOX_TIMEOUT_MS` is a backstop under that, not the thing that does it.

### One volume per person, and why that changed

Daytona mounted **one shared volume** at a per-user subpath and relied on the FUSE mount being scoped
to that prefix for isolation. E2B mounts a volume whole, at a path, with no equivalent scoping — so a
shared volume would put every person's desktop on one directory, and there is no subpath trick available
to fix that afterwards. Hence a volume each, named from an opaque hash of the user id: it leaks nothing
into an operator's volume list, and a database row lost by mistake still finds its disk.

`E2B_VOLUMES=false` is the only value that turns this off. A typo leaves it on, because losing somebody's
files is the worse direction to be wrong in.

### Egress, and the two allow-lists that no longer exist

`DAYTONA_NETWORK_ALLOW_LIST` and `DAYTONA_DOMAIN_ALLOW_LIST` were parsed and documented and **never read
by anything** — they were not passed to the create call and referenced nowhere else. They are gone rather
than left as variables that do nothing.

Egress is no longer the question it was. Free-tier Daytona sandboxes had none, which is why a Bot's
browser could not load a page from the desktop; E2B sandboxes have it, and `allowInternetAccess: true`
is passed explicitly on create rather than left to a default. Restricting it is now E2B's own network
configuration, or the `network` field on the sandbox — not a variable in this repository.

### Stopped is not the same as gone

`daytona.get` answers perfectly happily for a **stopped** sandbox, because a stopped machine is still
there and still costs nothing to keep. So "the row names a sandbox" and "the sandbox will accept a
command" are two different facts, and conflating them produced:

```
Bad request: failed to resolve container IP after 3 attempts: no IP address found.
```

on every screen, shell and file tool call made minutes after anyone last touched a computer. There is
no container to resolve an IP for, the request dies in the proxy before any handler can explain
itself, and the only symptom is a desktop that is unreachable. The provisioner therefore confirms
`state === "started"` and wakes the machine when it is not —
`server/tests/e2b-resume.test.ts` covers it.

### Egress

There is no egress variable here, and there is no longer a question. Free-tier Daytona sandboxes had
**no internet egress**, so a Bot's browser could not load a page from the desktop at all — the reason
this deployment is on E2B now. E2B sandboxes have it, `allowInternetAccess: true` is passed explicitly
on create, and `computer_navigate` works.

Restricting egress is E2B's own network configuration, or the `network` field on the sandbox. The old
`DAYTONA_NETWORK_ALLOW_LIST` and `DAYTONA_DOMAIN_ALLOW_LIST` were parsed and documented here and
**never read by anything** — they were not passed to the create call and referenced nowhere else — so
they are gone rather than left as variables that do nothing.

`egress.env` and `EGRESS_PROXY_<BOT_ID>` are gone for the same reason they went before: they were
named after a Bot's id because the supervisor created a container per Bot. A sandbox belongs to a
**person**, so a per-Bot proxy is the wrong shape whatever platform it is for.

A person who wants their machine and their files gone removes their computer from
**Settings → Computer**, which stops and deletes the sandbox. The volume it mounted is not removed
with it: it is the shared tree every computer of that person uses, and `docker volume ls` still shows
it. Nothing above needs running on the host to do this.

## Attested identity

When optional SPIRE services are used:

- Compose uses `SPIRE_JOIN_TOKEN` for `spire-agent`'s `-joinToken`, defaulting to `remii-dev-token`;
- everything else the agent needs is in `spire/agent.conf` and `spire/server.conf` (`trust_domain`
  `remii.local`), not in the environment.

A computer used to be listed here too, reading `SPIFFE_ENDPOINT_SOCKET` from inside a container. It is
an E2B sandbox now, which is outside this deployment and outside its network — nothing here attests
it, and nothing here should.

## Images

Every service `docker-compose.yml` can build is published by a release, so a machine can run the
stack without a toolchain.

| Service           | Setting             | Published image                            |
| ----------------- | ------------------- | ------------------------------------------ |
| `agent-bot`       | `BOT_IMAGE`         | `ghcr.io/harshjorwal7/remii-agent-bot`      |
| `agent-langgraph` | `LANGGRAPH_IMAGE`   | `ghcr.io/harshjorwal7/remii-agent-langgraph`|
| `migrate`         | `SERVER_IMAGE`      | `ghcr.io/harshjorwal7/remii-server`         |

Unset, each names a local tag and Compose builds it, which is what a checkout of this repository
does. Set to a published reference, pinned by digest, together with `IMAGE_PULL_POLICY=missing`,
Compose pulls instead. Both architectures are in every image, so the same reference works on an
arm64 laptop and an amd64 server.

`IMAGE_PULL_POLICY` is needed because a service carrying a `build` section builds by default
however its image is named. It is also not a promise that nothing is built: a pull that fails falls
back to building, which suits a developer and does not suit a machine with no toolchain, where the
useful answer is that the image could not be fetched. Somewhere that must never build, override the
`build` sections away instead.

`docs/releasing.md` shows reading the digests straight out of a release's `container-images.json`.

## Ports

| Service           | Default port               | Setting           |
| ----------------- | -------------------------- | ----------------- |
| `app`             | 3010                       | `APP_PORT`        |
| `server`          | 3001                       | `SERVER_PORT`     |
| `agent-bot`       | 4200                       | `BOT_PORT`        |
| `agent-langgraph` | 4201                       | `LANGGRAPH_PORT`  |
| PostgreSQL        | 5432                       | `POSTGRES_PORT`   |

A computer has no port here. It is an E2B sandbox, reached over E2B's API rather than over a socket of
ours, so there is nothing to publish and nothing for an attacker to reach by guessing a number. The
live screen is the one exception and it is deliberate: the browser connects to the sandbox's own noVNC
port, protected by a per-session password this server mints, rather than through a port published here. `COMPUTER_PORT` and `SUPERVISOR_PORT` remain only so a stale `.env` naming them does not
become a startup failure; nothing reads them.

Set these in `.env` or in the environment. `docker-compose.yml` publishes on them and
`scripts/start.sh` reads the same names to decide where to look, so one setting moves a service and
everything that talks to it. The addresses built from them are separate settings, so a moved service
also needs its URL changed: `DATABASE_URL` and `MANAGED_AGENT_AG_UI_URL`.

To run two deployments on one Docker host, give the second one its own `COMPOSE_PROJECT_NAME`.
Container and volume names are global to a host, and the project name is what keeps each
deployment's services its own.

Two deployments **cannot** share one E2B account without care, and for a different reason than they could
not share one Daytona account. Daytona's memory was drawn from an organization-wide pool, so the second
deployment found it exhausted and every user got a quota error naming nobody. E2B has no such pool —
the limits are concurrency (20 on Hobby, 100 on Pro), disk (10 GiB on Hobby, 20 on Pro) and continuous
runtime — so the shared failure is a **concurrency ceiling** instead, and it is reached by two
deployments' desktops adding up rather than by either being large.

Split them across accounts, raise the tier, or share one account deliberately and treat the concurrency
number as a budget to divide rather than a limit to discover.

Give it its own `DEPLOYMENT_ID` as well when it shares an Intelligence project, which a copy made
from the same `.env` does. Threads are listed per Bot and carry nothing else that says where a
conversation came from, so the name goes into every thread id a deployment mints and is how its own
conversations stay tellable from the other's.

Each person gets one computer, not one per Bot, and not one shared by everybody: each has its own
browser, its own `/workspace` and its own volume subpath, so no user can see or reach another
user's. Two Bots of the same person share that one machine and are arbitrated when both would drive
it at once.

## Tenant package

The tenant package contains five required YAML files, and two optional:

```text
examples/fintech/
├── brand.yaml
├── agents.yaml
├── channels.yaml
├── model.yaml
├── knowledge.yaml
├── skills.yaml      (optional)
└── agents/          (optional)
    └── expense-review.yaml
```

### `brand.yaml`

```yaml
tenant:
  id: remii
  product_name: Remii
```

Optional theme:

```yaml
skin:
  stylesheet: theme.css
```

Theme CSS may define only `:root` and `.dark` blocks, approved theme variables, and no `@import` or `url()`.

### `agents.yaml`

```yaml
agents:
  - id: knowledge
    name: Knowledge
    title: Company Knowledge
    role_description: Answer company knowledge questions and cite sources.
    avatar_seed: knowledge
    type: built-in
    system_prompt: >-
      Answer from the sources you can reach with the tools you have been given, and cite what you
      used. If you have no tool for a source, or a tool tells you it is not connected or reports an
      error, say that plainly. Never answer from your own memory as though it came from a source, and
      never claim you lack access to something a tool has just returned.

  - id: risk-analyst
    name: Risk Analyst
    title: Risk & Compliance
    role_description: Investigate policies and controls.
    type: remote-ag-ui
    endpoint: ${MANAGED_AGENT_AG_UI_URL}
```

Each agent requires `id`, `name`, `title`, `role_description`, and `type`.

| Type           | Required field  |
| -------------- | --------------- |
| `built-in`     | `system_prompt` |
| `remote-ag-ui` | `endpoint`      |

The two types are told different amounts, which is easy to miss. A `built-in` agent gets its
`system_prompt`; a `remote-ag-ui` agent has none, and its `role_description` is the only instruction
it ever receives from the package. Write that sentence as the whole brief for the Bot, not as a
label for a list.

A `remote-ag-ui` agent is not something a person adds. Every address in a package comes from the
deployment's own configuration — the Bot it ships in the box, or the framework picked during setup —
and both are reached over AG-UI on this machine or this network. A coworker created in the product
always runs on that same engine; there is no field anywhere for pointing one somewhere else.

Both kinds are also told, by the deployment rather than by the package, to say where an answer came
from: cite what a tool returned, and say plainly when the answer is from the model's own knowledge
rather than from anything it read. That rule is not written per agent, so it cannot be missing from
the next one somebody adds.

Any `${NAME}` in a package file is replaced with that environment variable, so one package works
against a local stack, a staging one and production. `${NAME:-fallback}` uses the fallback when the
name is unset or empty, which is how the example package points at the Bot in the box without
requiring any configuration. A name with neither a value nor a fallback stops the server with a
message saying which file wanted it, rather than leaving a Bot pointed at an address nobody meant.

### `agents/`

A coworker may also be one file of its own, in an `agents/` directory beside `agents.yaml`. Both are
read, and a package that keeps every coworker in `agents.yaml` is unchanged.

```yaml
# examples/fintech/agents/expense-review.yaml
id: expense-review
name: Expense Review
title: Finance Operations
role_description: Check one expense claim at a time against the policy as it is written.
avatar_seed: expense-review
type: built-in
system_prompt: Quote the clause you relied on, and leave the decision to a person.
skills:
  - find-a-document
```

The file holds the coworker on its own, as above, or a list under `agents:` the way `agents.yaml`
does. Only `.yaml` and `.yml` are read, so a README beside them is left alone. Files are read in
filename order, and every check that applies to a row in `agents.yaml` applies here too: a refusal
names the file it came from.

Two files declaring the same `id`, or a file repeating an id `agents.yaml` already uses, stop the
server and both files are named. Nothing wins by being read later — which coworker a deployment runs
should not depend on what a directory listing happened to return.

The directory is in the package checksum, so adding, editing or deleting a coworker there is a
package change like any other and a running deployment notices it on the next boot.

### `channels.yaml`

```yaml
channels:
  - id: risk-and-compliance
    name: Risk & Compliance
    description: Investigate policies and controls.
    permitted_agents: [knowledge, risk-analyst]
    allowed_groups: [risk, compliance]
```

Each channel requires `id`, `name`, `description`, `permitted_agents`, and `allowed_groups`. Every `permitted_agents` entry must match an agent id.

`allowed_groups` is validated and stored, and nothing reads it. It decides nothing today, and a
deployment that writes one must not treat it as an access control. Both halves of that control are
missing, not one: `users.groups` exists as a column and no sign-in path or claim mapping ever
populates it, so there is nothing for a channel's list to be compared against. Channel
access is decided by membership alone — every channel route resolves the caller's row in
`channel_memberships` and refuses without it.

Package-declared channels get no membership rows from `synchronizeTenantPackage`, so today they
are unreachable rather than open. The field is kept because the enforcement it is named for needs
the declaration and needs group membership arriving from the identity provider, and neither this
column nor `users.groups` is the wrong shape for it.

### `model.yaml`

```yaml
model:
  provider: openai
  credential_secret_ref: openai-api-key
  default_model: gpt-5.6-terra
```

`provider` must be `openai`. `credential_secret_ref` is a reference to a stored credential, not a credential value. `default_model` is passed through as written, so an OpenAI-compatible endpoint reached through `OPENAI_BASE_URL` takes the name that endpoint publishes.

### `knowledge.yaml`

```yaml
sources:
  - type: google-drive
    roots: [Policies, Compliance]
  - type: microsoft-onedrive
    roots: [Risk, Operations]
```

Supported source types are `google-drive` and `microsoft-onedrive`.

### `skills.yaml` (optional)

```yaml
skills:
  - slug: find-a-document
    title: Find a document
    summary: Search the connected document sources for a file and read what it says.
    instructions: >-
      Search first, then read the file you found rather than answering from its title.
    tools:
      - google-drive/search_files
      - google-drive/read_file_content
  - slug: how-we-deploy
    title: How we deploy
    summary: Answer deployment questions from the platform repository.
    instructions: >-
      Read the deployment guide before answering, and name the file you took it from.
    repo: https://github.com/acme/platform/tree/main/docs
```

Each skill becomes a deployment skill on boot: everybody sees it in the `/` menu, and which Bots carry it is decided by a grant like any other.

`repo` is optional and is the same field the Skills page takes: a **public** GitHub address, optionally with a branch and a folder inside it. A Bot carrying such a skill is offered three tools that read that repository — an overview, a search, and one file at a time — and nothing else. Only `github.com` addresses are readable and no token is stored, so a private repository cannot be pointed at; `skill.repo` that is not readable stops the package loading, naming the key.

Like `tools`, `repo` grants nothing: a Bot reads the repository because it was granted the skill, and the grant is what decides that. A redeploy rewrites the pointer and drops the cached reading of the old one, so the first run after a deploy re-reads it.

`tools` is why this file matters beyond the instructions. A Bot holding more than twelve tools is offered, per run, only the tools of the skills that match the message, so the matching needs skills to match against. Shipping the declaration with the skill is what makes connecting a connector the only step; without it a deployment has no skills, nothing matches, and the narrowing never switches on.

Refs are `serverId/toolName`, the same form a grant is written in. A package may name tools for a connector nobody has added — the ref sits inert until that connector exists, because what a Bot is offered is always intersected with what it was granted. **Naming a tool here grants nothing.**

One slug is load-bearing. A Bot granted `skill-creator` is offered the four tools that let a conversation end in a saved skill, so a package shipping that skill should also grant it to a Bot in `agents.yaml` — shipping it and granting it to nobody boots a deployment where writing a skill in the composer quietly does nothing. It declares no `tools`, and should not: those four are the app's own rather than a connector's, so they are not `serverId/toolName` refs. See [architecture.md](architecture.md#writing-a-skill-in-a-conversation).

Slugs are lowercase letters, digits and hyphens. If a package ships a slug somebody in the deployment already wrote a skill under, theirs keeps the name, the package loses that skill, and startup continues.

Omit the file entirely for a package with no skills.

## Change workflow

1. Edit the relevant `.env` value or tenant YAML file.
2. Check cross-file references, especially `channels[].permitted_agents`.
3. Keep credential values and service-account JSON out of YAML.
4. Restart the API server; invalid configuration stops startup.
5. Run:

   ```sh
   bun run format:check
   bun run lint
   bun run typecheck
   bun run test
   ```
