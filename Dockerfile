# Remii, whole, in one container.
#
# WHAT THIS IS FOR. Everything a laptop runs, minus the database, in one image on one port. Deploy it
# anywhere that runs a container and you get what `scripts/start.sh` gives you locally: the app and
# the API.
#
# WHAT IS NOT HERE, AND WHY.
#
#   PostgreSQL. A container filesystem does not survive a redeploy and the audit trail is the
#   product. `DATABASE_URL` points at a managed instance, which is one click on every platform this
#   is meant to run on.
#
#   Chromium, Playwright, and the per-Bot browser service.
#
#     The computer is not in this image any more. A person gets one desktop inside their own E2B
#     sandbox (`E2B_IMAGE`, see `.env.example`), reached over the E2B API, and this container
#     holds nothing but the API that drives it. That is why there is no browser here and no
#     `PLAYWRIGHT_VERSION` to keep matched with anything: a browser in the API image would be a few
#     hundred megabytes of memory holding one person's logins, in every replica, which is the
#     opposite of stateless.
#
#     `agent-computer/` and `supervisor/` were deleted when that move was made. They were a browser
#     per Bot and a Docker socket to spawn them with; both are gone from the tree, and the references
#     left behind here and in `docker/s6` are what this section removed.
#
#   The supervisor. It existed to give each Bot its own container, which needs a Docker socket, which
#   no serverless container platform permits. E2B gives each person a sandbox instead, and needs
#   no socket from us.

FROM node:24.18.1-bookworm-slim AS node-toolchain
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun-toolchain

FROM ubuntu:24.04 AS base

# Keep Bun and global installs readable by the runtime's unprivileged user.
ENV BUN_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"
ENV DEBIAN_FRONTEND=noninteractive
COPY --from=node-toolchain /usr/local /usr/local
COPY --from=bun-toolchain /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils \
  && ln -s bun /usr/local/bin/bunx \
  && rm -rf /root/.cache /tmp/* /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/bash pwuser \
  && useradd --create-home --shell /usr/sbin/nologin apiuser


FROM base AS deps

WORKDIR /src

# Manifests first, so editing a source file does not reinstall the world.
COPY package.json bun.lock ./
COPY tsconfig.base.json bunfig.toml ./
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
RUN bun install --frozen-lockfile

# The lockfile travels with the manifest, because `--frozen-lockfile` with no lockfile in the context
# is not an error: bun resolves afresh, succeeds, and the flag has decorated nothing. With both files
# here, the tree in the image is the tree this repository resolved and committed. Bun is already
# pinned twenty-odd lines above for the same reason; this is the install below it.
#
# No second install for `agent-computer`, which had its own lockfile and its own tree. It was a
# browser per Bot and it is gone; `--frozen-lockfile` failing here is what said so.

# A second tree with the build-time dependencies left out, for the runtime stage to take. Vite,
# biome and the test tooling are a gigabyte that nothing in a running container imports.
RUN mkdir -p /prod && cp package.json bun.lock /prod/ \
  && cd /prod && mkdir -p app server worker \
  && cp /src/app/package.json app/package.json \
  && cp /src/server/package.json server/package.json \
  && cp /src/worker/package.json worker/package.json \
  && bun install --frozen-lockfile --production


FROM deps AS app-build

COPY app app
COPY scripts scripts
COPY shared shared
# The server's source as well: the app's prebuild step reads the tenant package through
# `server/src/tenant-package`, so the app cannot be built without it.
COPY server server
COPY examples examples
RUN bun run --cwd app build


FROM base AS runtime

# s6 rather than supervisord. The deciding difference is that s6 brings the container down when a
# supervised process exits, which is what makes the platform restart it. supervisord stays alive and
# the container keeps reporting healthy while the API inside it is dead.
ARG S6_OVERLAY_VERSION=3.2.1.0
# `TARGETARCH` is filled in by the builder. s6 names its tarballs by uname, so amd64 and arm64 have
# to be translated. Hardcoding one of them builds fine on the other and then fails at start with an
# exec format error, which reads as a broken image rather than a wrong download.
ARG TARGETARCH
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp/
RUN case "${TARGETARCH}" in \
      amd64) S6_ARCH=x86_64 ;; \
      arm64) S6_ARCH=aarch64 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSL -o /tmp/s6-overlay-arch.tar.xz \
    "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" \
  && tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz \
  && tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz \
  && rm /tmp/s6-overlay-*.tar.xz

WORKDIR /app

# BOTH HALVES OF THE TREE COME FROM /prod. A workspace install is two directories, not one: the
# packages it could hoist go to the root `node_modules`, and a per-workspace `node_modules` sits
# beside each manifest holding the rest. The server's half used to be taken from /src, which is the
# unpruned install, so the prune above bought nothing where the server actually resolves — and
# `@copilotkit/aimock`, a development dependency, shipped as a symlink into a store the prune had
# emptied, along with the two `.bin` shims pointing at it. Every dependency `server/package.json`
# declares resolves from the /prod half; the ones it does not declare are absent now rather than
# present and broken.
COPY --from=deps /prod/node_modules node_modules
COPY --from=deps /prod/server/node_modules server/node_modules
COPY --from=deps /src/package.json package.json
COPY --from=deps /src/bun.lock bun.lock

COPY server server
COPY shared shared
COPY examples examples

# `bun run composio:smoke`, because the manifest copied above carries that entry and the question it
# answers belongs here rather than on a laptop: it asks what THIS deployment's Composio key can see,
# and that key is the one in this container's environment. It reads `server/src/plugins/composio*`,
# which is already in the image, so the file itself was the only thing missing and the entry was an
# instruction that could not be followed where it shipped.
#
# ONE FILE, NOT `scripts/`. The others there are the laptop's. `diagram` and `mock:knowledge` reach
# for `roughjs` and `@copilotkit/aimock`, which the prune above removes; `test:ci` runs a suite that
# is not in the image; `generate:app-config` writes a file the build has already baked into
# `app/dist`. Copying the directory ships four more entries with nothing to do here, to fix one that
# has something to do.
COPY scripts/composio-smoke.ts scripts/composio-smoke.ts

# The built app, served by the API on the same origin. There is no CORS in this server, so this is
# not a convenience: two origins would simply fail.
COPY --from=app-build /src/app/dist app/dist
ENV APP_DIST_DIR=/app/app/dist

COPY docker/s6 /etc/s6-overlay

# PostgreSQL, for the deployment that wants one thing to run rather than two.
#
# OFF UNLESS ASKED FOR. Set `EMBEDDED_POSTGRES=on` and the container runs its own; leave it and
# `DATABASE_URL` points wherever you like. The trade is the one you would expect: a database inside
# a container lives and dies with that container unless /var/lib/postgresql is a mounted volume, and
# the audit trail is the thing you would be losing.
RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql-16 postgresql-16-pgvector \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/postgresql/data /var/run/postgresql \
  && chown -R postgres:postgres /var/lib/postgresql /var/run/postgresql

# A Bot can install what a task needs, and nothing else as root.
#
# `sudo` without a password, because a package manager that cannot install is not one, and "install a
# tool then use it" is the whole point of giving a Bot a shell.
#
# THE PACKAGE MANAGERS, NOT ALL. This was `NOPASSWD: ALL`, and the comment below it explained what
# that cost: a Bot could become root inside its container. It then named the two conditions that make
# that acceptable — the container being one Bot's alone, and not holding a database — and this image
# meets neither. The supervisor is deliberately not in it, so every Bot shares one computer, and
# `EMBEDDED_POSTGRES=on` is a documented way to run it. So root here read another Bot's workspace, the
# API's environment, and the audit database that records what it did.
#
# Naming the commands keeps the feature and removes that. `apt-get install` still works, which is what
# the tool description tells a model to run. `sudo cat /proc/1/environ` does not.
#
# WHAT THIS IS NOT. It is a floor, not a boundary. Root is one CVE away and a shared container is not
# an isolation story for code a model wrote: that needs a computer per Bot and a sandbox under it,
# which is why per-Bot computers and gVisor are not optional extras next to this feature. Run the
# image with `--security-opt no-new-privileges` where the platform allows, which turns setuid off
# entirely for anything not named here.
RUN apt-get update && apt-get install -y --no-install-recommends sudo \
  && rm -rf /var/lib/apt/lists/* \
  && printf '%s\n' \
    'pwuser ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt, /usr/bin/dpkg, /usr/bin/apt-key, /usr/bin/apt-cache' \
    'Defaults!/usr/bin/apt-get env_keep += "DEBIAN_FRONTEND"' \
    > /etc/sudoers.d/pwuser \
  && chmod 0440 /etc/sudoers.d/pwuser \
  && visudo -cf /etc/sudoers.d/pwuser

# THE PACKAGE MANAGER AND THE SHELL STAY. Both were removed here once as hardening, which was
# backwards: a Bot being able to open a shell and install what a task needs is a requested feature,
# not an oversight. Removing them hardens the image by deleting the product.
#
# What makes that safe is not their absence. It is that a Bot reaches them the same way it reaches
# anything else, through the gateway: resolve, decide against the policy, write the audit row, then
# act. A command is a decision like a click is.

# Where a Bot's files live. Mount a volume here to keep them across a redeploy; without one they are
# as durable as the container, which for a trial is the honest default.
ENV WORKSPACE_DIR=/workspace
ENV PROFILES_DIR=/profiles

# NO SHARED COMPUTER IS NAMED HERE, and naming one is now a refusal rather than a default.
#
# `AGENT_COMPUTER_URL` used to point at a browser service on loopback inside this image. That
# service is gone with `agent-computer/` — one computer per person is an E2B sandbox or a
# supervisor container now — and the variable now names the one configuration strict per-user
# sandboxing forbids: one /workspace, one shell and one browser shared by everybody. Setting it
# here made every deployment built from this image refuse to start, and it pointed at a port
# nothing was listening on besides. A computer is configured by `E2B_API_KEY`,
# `COMPUTER_SUPERVISOR_URL` or `COMPUTER_SANDBOX_NAMESPACE`; with none of them there is no
# computer, which is a state the server serves rather than a failure.

# NOTHING THAT MATTERS RUNS AS ROOT.
#
# s6 stays root because that is the only way it can drop each service to a different user, and they
# genuinely differ: the browser and the Bot's shell run as `pwuser`, the API and migrations as
# `apiuser`, the database as `postgres`. One shared account would put the process that renders the
# open internet in the same skin as the one holding the audit trail.
#
# This matters more than usual here. Chromium is launched with `--no-sandbox` unless the host can
# support its sandbox, and with that flag the process user IS the boundary, so root would mean a
# page exploit lands as root.
#
# The two directories the browser writes are its workspace and its profile, the second being what
# keeps a Bot signed in between turns. Owned here, because a non-root process cannot create them at
# the root of the filesystem and the failure surfaces as EACCES on the first navigation.
RUN mkdir -p /workspace /profiles \
  && chown -R pwuser:pwuser /workspace /profiles /app

# Where the embedded database answers, when there is one. Overridden by whatever you set, so an
# external database needs no special case: set DATABASE_URL and EMBEDDED_POSTGRES stays off.
ENV EMBEDDED_POSTGRES=off
ENV DATABASE_URL=postgres://remii@127.0.0.1:5432/remii

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# One port out. The browser's 4100 is deliberately not exposed: it holds real logins and its only
# caller is the process next to it.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3001/health'); process.exit(r.ok ? 0 : 1)"

ENTRYPOINT ["/init"]
