# Deployment

Remii ships as one container. It carries the app, the API that serves it, and the browser the Bots
drive, and it can carry its own PostgreSQL as well. It does what it does on a laptop.

```sh
# Every release publishes this image, so a deployment needs no clone and no build.
# `latest` is the most recent; a version tag such as `:v0.0.9` pins one.
image=ghcr.io/copilotkit/remii:latest

# A database you already run.
docker run -p 3001:3001 --env-file .env "$image"

# Or one inside the container. Nothing else to provision.
docker run -p 3001:3001 --env-file .env \
  -e EMBEDDED_POSTGRES=on -v remii-data:/var/lib/postgresql "$image"
```

`docker build -t remii .` from a clone produces the same thing, for anyone deploying a tree of
their own. What a release publishes is digest-pinned in its `container-images.json`, and deploying
those digests rather than a moving tag is what [releasing.md](releasing.md) recommends.

## What is in the image, and what is not

**In it:** the built app and the API. One port, 3001.

**Not in it: a browser.** The computer is an E2B sandbox, one per person, reached over E2B's
API — not a Chromium inside this container on an unpublished port. The `E2B_API_KEY` is
server-side and never reaches the browser, so there is nothing here to publish and no port an
attacker could reach by guessing one.

**PostgreSQL, if you ask for it.** `EMBEDDED_POSTGRES=on` starts one inside the container, creates
the database and the `vector` extension the first time, and runs the migrations on every start. It
listens on loopback only and is never published, so there is no password to manage.

Give it a volume at `/var/lib/postgresql` — the parent, not the data directory itself. Without one,
a redeploy takes the audit trail with it, and the audit trail is the product.

**Mount the parent, not `/var/lib/postgresql/data`.** On any platform whose volume is an ext4 mount,
and that is most of them, the mount arrives holding a `lost+found` directory. `initdb` will not
initialise into a directory that has anything in it, so mounting it directly on the data directory
leaves the cluster uncreated — and because `api` waits on `postgres` and `migrate`, the container
starts, the platform reports the deploy a success, and the URL serves a 502. Mounting the parent
leaves `data` as an ordinary subdirectory, which is what PostgreSQL asks for. A Docker named volume
works either way; a platform volume does not. Platforms that offer no persistent volume are the ones to
point at a managed database instead: set `DATABASE_URL` and leave `EMBEDDED_POSTGRES` off. The
`vector` extension must be enabled there; RDS, Cloud SQL and Azure Database all support it, none
enable it for you.

**Not in it:**

**Per-user isolation, but from E2B rather than from here.** A computer used to be a container per
(user, Bot) pair, created by a supervisor that needed a Docker socket — which no serverless platform
permits, which is the whole reason the supervisor was hard to deploy. E2B supplies that isolation
instead and needs nothing from this container, so replicas can scale freely and every person still
gets their own machine, logins and files. There is no shared browser to fall back to and no
supervisor to configure: the server answers computer requests with an error rather than running one
person's tasks in another person's browser.

**This means two replicas is now trivially safe** in a way it was not before. Computer state lives in
Postgres and the machines live in E2B, so there is no per-replica browser holding a session.

**The routines schedule.** Nothing in this image is scheduled to fire a routine — there is no
worker service beside the API, and `worker/` (the looping local variant) is not in the image. The
sweep itself is: `bun scripts/fire-routines.ts` from `/app/server`, one pass then exit, which is what
the Helm chart's CronJob runs from this same image. So a one-container deployment needs something
outside the container to run it on a schedule — an external cron, a platform scheduled job, or a
second container of this image started with `--entrypoint sh` (without it the command arrives as a
`CMD`, and this image's entrypoint boots a whole second server before it runs one; see
[Migrations](#migrations)) — with `SERVER_INTERNAL_URL` and
`WORKER_SHARED_SECRET` set **on top of this server's whole environment**, not instead of it. That
sweep builds the same configuration the API server does before it looks for a due routine, so it
refuses to start without the encryption key and an identity provider,
exactly as the server does: give it the same env file and add those two. Until something does, a
routine is stored, its next run time is computed, the Routines page shows it, and it never fires.
See [routines.md](routines.md).

**The staged-attachment sweep.** Same shape as the routines schedule, with a consequence worth
stating on its own: a file dropped into the composer is stored before it is sent, and nothing in
this image reclaims the ones that never were. The sweep is `bun scripts/cull-staged-attachments.ts`
from `/app/server`, one pass then exit, which the Helm chart runs hourly and which deletes unsent
attachments older than 24 hours — the window is the script's one positional argument, so
`bun scripts/cull-staged-attachments.ts 72` keeps them for three days, and a fraction is a fraction
of an hour. It needs only `DATABASE_URL` — no encryption key, no identity provider, nothing else
this image is configured with — so unlike the routines sweep above, an external cron can run it
with one variable set. A second container of this image still needs `--entrypoint sh`, for the
reason under [Migrations](#migrations).

Until something does, abandoned uploads accumulate in `attachments` up to a ceiling that is one
person's: **32 unsent files each**, counted across every channel and every composer session at once
and refused at the upload endpoint. A file is at most 8 MiB, so that is 256 MiB of staged blobs per
person who uploads, and that is the number to size storage against. It is **not** the eight files
the composer refuses a ninth on: that cap is counted over a bucket the client names in its own
request, so it bounds a client that plays along and nothing else, which is exactly why the
per-person ceiling was added behind it.

That ceiling is also why never running this sweep is worse than growth. The refusal a person sees on
their 33rd staged file tells them anything still unsent is cleared within a day — which is a promise
made on this sweep's behalf. With nothing running it, the files are never cleared, and anybody who
reaches 32 can attach nothing, in any channel, for good.

## Minimum size

Measured on the real image, one Bot, arm64.

| | Measured | Minimum | Recommended |
| --- | --- | --- | --- |
| Memory | 409 MB idle, 498 MB after three page loads, 548 MB after a snapshot | **2 GB** | **4 GB** |
| vCPU | 3 to 6 percent at rest, bursty while a page renders | **1** | **2** |
| Disk | 1.4 GB image | **4 GB** | 8 GB with room for `/workspace` |

**Why 2 GB when it measures at 550 MB.** That figure is one Bot with one page open. Every additional
concurrent page is roughly another 100 to 200 MB, and Playwright's own guidance is to allow about
1 GB per concurrent browser. 2 GB is the floor at which one person using it does not meet the OOM
killer; 4 GB is where a handful of Bots working at once stays comfortable.

**Do not configure shared memory.** Chromium used to run inside this container, launched with
`--disable-dev-shm-usage` so that `/tmp` carried the load and the 64 MB `/dev/shm` default was
irrelevant. Chromium now runs inside the E2B sandbox and this image's own `/dev/shm` is nobody's
problem — but the setting is still worth leaving off deliberately rather than by omission, because a
platform that supports it and a replica that assumes it are the two things that differ between Fargate
and everything else here.

## Required configuration

| Variable | |
| --- | --- |
| `DATABASE_URL` | PostgreSQL with the `vector` extension. Not needed with `EMBEDDED_POSTGRES=on` |
| an identity provider | `GOOGLE_OAUTH_*`, `MICROSOFT_OAUTH_*` or `OKTA_OAUTH_*`, with `BETTER_AUTH_URL` and `BETTER_AUTH_SECRET`. See the README |
| `EMBEDDED_POSTGRES` | `on` to run the database inside the container. Off by default |
| `KEY_ENCRYPTION_KEY` | base64 32 bytes. `openssl rand -base64 32`. The example key is refused in production |
| a model key | `OPENAI_API_KEY`, or the provider you configured |

`COMPUTER_TOKEN` is generated at start if you do not set one. Both processes that need it are inside
the container, so there is nothing to share it with.

`MANAGED_AGENT_AG_UI_URL` is not required here. The image does not carry `agent-langgraph` or
`agent-bot`. Leave it unset and the shipped Risk Analyst coworker is omitted rather than registered
against a host that is not there. Set it, with `MANAGED_AGENT_TOKEN`, only when a Bot is actually
reachable from this container. Unset it if your `.env` still has the laptop default
`http://localhost:4201/ag-ui`.

**Authentication is required.** With no identity provider configured, the deployment refuses to start,
because a public URL where every visitor gets an account of their own fails silently: it looks like
it works. Configure Google, Microsoft or Okta, or set `REMII_SINGLE_USER=true` to say you meant an
open deployment. `NODE_ENV` does not affect this.

**Put TLS in front of it.** Not only for the cookies. A page served from `http://<address>` is not a
secure context, which removes a set of browser APIs that are present on `http://localhost` and so
never missing on a laptop. The app does not depend on any of them, but sign-in cookies still want
`Secure`, and every platform below terminates TLS for you.

## Migrations

With `EMBEDDED_POSTGRES=on` they run at start and there is nothing to do. There is exactly one
process and no deploy pipeline, so the alternative would be a runbook.

With an external database, they are a release step, not a start step. Two replicas starting together
would race, and a failed migration should stop a deploy rather than leave a half-migrated database
serving traffic.

```sh
docker run --rm --env-file .env --entrypoint sh remii \
  -c "cd /app/server && bun scripts/migrate.ts"
```

**`--entrypoint sh`, and it is the load-bearing part of that command.** This image's entrypoint is
`/init`, which is s6's, and anything after the image name is a `CMD` — which s6 runs *after* it has
started everything in the image. Without the override, `docker run … remii sh -c "… migrate.ts"`
brings up the API against the database you have not migrated yet, and only then
migrates it: a second server on an unmigrated schema, which is the race this whole section exists to
avoid, in the one command meant to avoid it. Replacing the entrypoint runs the migration and nothing
else. The Helm chart's migration Job is the same thing said in Kubernetes' terms — it sets
`command:`, which overrides an image's entrypoint rather than appending to it — which is why that
path was never wrong and this one was.

`scripts/migrate.ts`, not `drizzle-kit migrate`. The CLI is a development dependency and this image
is built with `bun install --production`, so it is not in there; it also needs esbuild to read its
TypeScript config. Asked to migrate here it exits 1 without saying why, and the deployment comes up
against an empty database. The script uses the migrator inside `drizzle-orm`, which is a runtime
dependency, and keeps the same journal, so a database migrated by either is migrated. It is what
this image's own start-up path and the Helm chart's migration Job both run.

## Replicas

The page snapshot a Bot resolves element references against lives in Postgres, so a second replica
can answer a click the first one snapshotted. Run more than one if the platform wants it.

That used to be true with a catch: every replica shared one browser inside it, so two replicas could
both be holding one person's session. A computer is an E2B sandbox now, so there is no catch. Two
replicas do not conflict over a desktop, and a Bot's logins do not stay on whichever replica happened
to serve the turn.

## Platform notes

**Google Cloud Run.** Set memory to at least 2 GB; more than one instance is fine, and see Replicas
above for why that is now simpler than it was. Chromium no longer runs inside this container, so
Cloud Run's gVisor sandbox is no longer something a navigation has to be tested against.
`gcloud run compose up` will also deploy the whole compose file if you want a throwaway database
alongside.

**AWS.** ECS Express Mode provisions the cluster, load balancer, HTTPS and autoscaling from an image
in ECR, and is what AWS points App Runner users at now that App Runner takes no new customers.
Plain ECS on Fargate behind an ALB is the answer if you want task definitions and fine-grained IAM.
No shared-memory configuration is needed or possible.

**Kubernetes.** Everything above describes one container run by hand. A cluster is the other shape,
and it is the only one that gives a Bot a computer of its own, runs the routines schedule without
something outside the container, and scales the API past a single replica. That is the Helm chart:
[charts/remii/README.md](../charts/remii/README.md), which covers EKS, GKE, AKS and a plain
self-hosted cluster from the same templates.

**Azure Container Apps.** Managed ingress with TLS and custom domains. Note the **240-second request
timeout**: the live screen holds a long connection, so expect it to reconnect. Concurrent WebSockets
are capped at 350 per instance on the basic tier.

**Railway, Render, Fly.io.** All run this image directly and all provision PostgreSQL in a click,
which makes them the shortest path from nothing to a running deployment.

## Known costs

**No browser in any image.** The all-in-one Dockerfile no longer runs Playwright's installer, and
`agent-computer` and `supervisor` are no longer published at all — the computer moved into a E2B
sandbox, which brings its own Chromium from `E2B_IMAGE`. Nothing here needs a Playwright version
kept matched against anything, and there is no browser-protocol-versus-executable-revision pairing to
get wrong.

The images keep the baseline Node command-line tools (`node`, `npm`, `npx`) from the official Node
24.18.1 image.

**A strict content-security-policy needs a hash or a nonce.** `app/index.html` runs a small inline
script that decides the theme before the first paint. Nothing in this repo sends a CSP header, so it
works as shipped; a deployment that adds one at its proxy has to allow that script explicitly, or
`script-src` blocks it and the page renders with the wrong theme until the app boots. A `'sha256-'`
hash of the script body is the version that survives a rebuild without a per-request nonce.
