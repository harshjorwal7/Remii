#!/usr/bin/env bash
#
# Stop everything `scripts/start.sh` started, in the reverse order it started them.
# Safe to rerun: anything already stopped is reported and skipped.
#
# Four things run, and they are stopped in this order so nothing is left calling something that has
# gone: the app, then the routine worker, then the API server, then Docker.
#
# A fifth used to be here — the Bot computers, last, because a supervisor made them rather than
# compose and so `docker compose down` left them running. There is no fifth thing: a computer is a
# E2B sandbox and the idle sweep stops it. See the note above the "Bot computers" line below for
# why this script deliberately does not do that itself.

# Before anything else, and before the `set` line below, which is itself bash-only: this file is
# bash, and being read by `sh` used to end it with exit 1 and no output at all. See that file.
. "$(dirname "$0")/require-bash.sh"

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

for arg in "$@"; do
  case "$arg" in
    # Accepted and ignored rather than rejected. It used to mean "leave the per-Bot Chromium
    # containers alone", and there are no containers of ours holding a browser any more, so the flag
    # has nothing to act on. Erroring on it would break a muscle-memory invocation in a script that
    # may well be running unattended from somewhere else, and warn instead: the flag is now noise,
    # and saying so once is how it gets dropped from the call sites.
    --keep-computers)
      echo "note: --keep-computers does nothing now. Computers are E2B desktops, stopped by" >&2
      echo "      the API server's idle sweep rather than by anything in this repository." >&2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/stop.sh

Stops the app, the routine worker, the API server and the Docker services.

Nobody's computer is stopped: a desktop is an E2B sandbox reached over the E2B API, and it is
stopped by the API server's idle sweep or from the Settings page. Nothing here deletes it.

  --keep-computers  Accepted and ignored. It used to leave per-Bot browser containers running, and
                    there are none.
EOF
      exit 0
      ;;
    *)
      printf '\033[31m%s\033[0m\n' "Unknown argument: $arg. Try --help."
      exit 1
      ;;
  esac
done

# The environment first, then .env, then the default: the same resolution order start.sh uses, so a
# port configured there is the port stopped here. A missing .env is not an error for stopping —
# the defaults still find whatever a previous run left behind.
setting() {
  local name="$1" fallback="$2" value="${!1:-}"
  if [ -z "$value" ] && [ -f "$ROOT/.env" ]; then
    # `|| true`, for `start.sh`'s reason: a key with a default here is routinely absent from `.env`
    # — of the two this reads, `.env.example` lists `SERVER_PORT` and not `APP_PORT` — and `grep`
    # finding nothing is an exit status of 1 that `pipefail` makes the pipeline's. The fallback on
    # the next line is what the second argument promises, and it must not depend on whether the key
    # happened to be written down.
    value="$(grep -E "^$name=" "$ROOT/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true)"
  fi
  printf '%s' "${value:-$fallback}"
}

APP_PORT="$(setting APP_PORT 3010)"
SERVER_PORT="$(setting SERVER_PORT 3001)"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
info()  { printf '\033[2m%s\033[0m\n' "$1"; }

holder() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fcn 2>/dev/null | awk '/^c/{c=substr($0,2)} /^n/{print c" ("substr($0,2)")"; exit}' || true
}

# Does whatever holds this port answer as Remii, rather than merely answer?
#
# The same question start.sh asks before starting, asked here for the opposite reason. Starting on
# an occupied port is a failed run; killing the occupant of a port is somebody else's editor server
# gone. So a port holder is only killed once it has identified itself, and is otherwise named and
# left alone.
identifies_as_remii() {
  local port="$1" name="$2"
  case "$name" in
    server)
      curl -fsS --max-time 3 "http://localhost:$port/api/copilotkit/info" 2>/dev/null \
        | grep -q '"agents"'
      ;;
    app)
      curl -fsS --max-time 3 "http://localhost:$port/" 2>/dev/null \
        | grep -qi '<title>[^<]*Remii'
      ;;
  esac
}

# Stop the process listening on a port, once it has proved to be ours.
#
# SIGTERM first, then SIGKILL for anything still holding the port two seconds later: bun and vite
# both exit on the first signal, but a process wedged mid-request would otherwise keep the port and
# make the next start.sh refuse it.
stop_port() {
  local port="$1" name="$2" who pids
  who="$(holder "$port")"
  if [ -z "$who" ]; then
    info "  $name: not running on $port"
    return 0
  fi
  if ! identifies_as_remii "$port" "$name"; then
    red "  $name: port $port is held by something that is not Remii: $who"
    red "  Left it alone. Stop it yourself if it is in the way."
    return 0
  fi
  pids="$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$pids" ] && { info "  $name: not running on $port"; return 0; }
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 2
  pids="$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
  green "  $name: stopped ($who)"
}

echo
echo "Remii"
echo "======="

info "1/4  App"
stop_port "$APP_PORT" app

info "2/4  Routine worker"
# The same pattern start.sh starts it with, and it has to stay that specific: a bare `bun
# src/index.ts` matches the API server's own container on a Linux host, where processes in a
# container are visible to `pgrep` as well.
if pgrep -f "bun worker/src/index.ts" >/dev/null 2>&1; then
  pkill -f "bun worker/src/index.ts" || true
  green "  worker: stopped"
else
  info "  worker: not running"
fi

info "3/4  API server"
stop_port "$SERVER_PORT" server

info "4/4  Docker"
if docker compose ps --quiet 2>/dev/null | grep -q .; then
  docker compose down >/dev/null 2>&1
  green "  compose services: stopped"
else
  info "  compose services: not running"
fi

#
# Nothing to stop, and nothing to sweep up.
#
# This looked for containers carrying `label=remii.supervisor=true` and removed them, which was a
# per-Bot Chromium container the supervisor had spawned. Both are gone: a person's computer is a
# E2B sandbox reached over the E2B API, so there is no container of ours holding a browser and
# no label worth matching on. Removing the loop also removes the only reason `--keep-computers`
# existed.
#
# A E2B desktop is stopped by the API server's idle sweep or from the Settings page. `stop.sh`
# does not reach across the API to do it, and should not: the metering that decides when a machine is
# idle is the server's own, and a script that stopped sandboxes behind its back would leave billing
# rows open against machines it had already reclaimed.
info "  Bot computers: none on this host (an E2B desktop is stopped by the API server)"

cat <<EOF

$(green "Stopped.")

Nothing was deleted. PostgreSQL, each Bot's files and each Bot's browser profile are Docker
volumes, so channels, credentials and signed-in sessions are all still there next time.

Start again: bash scripts/start.sh
EOF
