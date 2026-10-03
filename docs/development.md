# Development

## Setup

Install Docker, [Bun](https://bun.sh) 1.3+, `lsof`, `python3`, `openssl`, and `curl`.
`scripts/start.sh` uses `openssl` to mint the generated secrets on a first run.

```sh
cp .env.example .env
bun install
```

Add `OPENAI_API_KEY` (or the provider you configured) to `.env`. Threads live in
PostgreSQL — there is no cloud service to provision and no key to fetch.

Start the stack:

```sh
bash scripts/start.sh
```

## Running services

Use `bash scripts/start.sh` for the full local stack. It starts Docker services, applies migrations, starts the API server, the app, and the routine worker, and verifies health routes.

Use `bash scripts/stop.sh` to take it down: the app, the routine worker, the API server and the Docker services. Nobody's computer is stopped, because nobody's computer is here — a computer is an E2B sandbox and the API server's idle sweep stops it. Nothing is deleted either way.

### Talking to a computer while you work on it

`server/scripts/probe-e2b-desktop.ts` builds one sandbox with the provisioner's own parameters,
asks Computer Use for its status, stops it, wakes it, screenshots it again, and deletes it. It prints
`RESULT: the desktop works` or does not. Run it with `E2B_API_KEY` in the environment:

```sh
bun --env-file=.env server/scripts/probe-e2b-desktop.ts
```

It costs a sandbox for a minute or two, so it belongs to a change that touched the computer, not to a
routine check. Note the second half: a desktop that creates and screenshots cleanly and then cannot
be woken is the failure that matters most, and it is invisible to anything that only creates one.

Use `bun run dev` only when you want the app and API server without starting the Docker Bots.

| Service           | Port                       |
| ----------------- | -------------------------- |
| `app`             | 3010                       |
| `server`          | 3001                       |
| `agent-bot`       | 4200                       |
| `agent-langgraph` | 4201                       |
| PostgreSQL        | 5432                       |

A computer is an E2B sandbox and has no port on this host.

`start.sh` leaves existing matching services alone and reports when a port is held by another process.

**Nothing here sweeps staged attachments.** A file dropped into the composer is stored before the
message is sent, and the only thing that reclaims the ones never sent is
`bun scripts/cull-staged-attachments.ts` from `server/`, which the Helm chart runs hourly and which
neither `docker-compose.yml` nor `start.sh` starts. It needs only `DATABASE_URL`, and takes a
retention window in hours as its one optional argument, defaulting to 24. On a laptop that is
usually nothing, because the rows are small and the database is yours. It stops being nothing at
thirty-two: one person may hold that many unsent files across every channel at once, the refusal on
the next one promises they are cleared within a day, and where nothing sweeps they are not, so a
long-lived local deployment can reach a state where attaching anything is refused. Removing a file
in the composer deletes it outright, so it takes abandoned drafts rather than ordinary use.
[deployment.md](deployment.md) says the same for a real deployment.

## Migrations

After changing the Drizzle schema:

```sh
bun run --filter server db:generate
bun run --filter server db:migrate
```

Review generated migration files before sharing them. `start.sh` applies existing migrations when it starts the stack.

**Do not hand-edit a generated migration.** It leaves a file that no longer matches what the
generator produced. If the generated SQL will not work — `ADD COLUMN ... NOT NULL` fails on a table
that already has rows — split it instead: generate the column nullable, add the data step, then
generate the constraint.

**A constraint that tightens an existing column belongs to a later release**, not to the release that
adds the column. A rolling deploy runs the migrations and then serves from old and new replicas at
once, and an old replica writes rows without the new column: under `NOT NULL` its writes start
failing, so the release that added the column breaks for everybody who lands on a replica that has
not been replaced yet. Ship the column nullable, let the fleet turn over, then tighten it. `issuer`
on `accounts` is the worked example: the column is nullable and no migration tightens it.

**A data step is its own migration**, created with the flag that exists for it:

```sh
bun run --filter server db:generate -- --custom --name=backfill_something
```

A generator diffs schema against schema, so a rule like "the rows whose provider is Google get
Google's issuer" can never come out of one: it is not in the schema. `--custom` writes an empty file
registered in the journal, and it is the only migration anybody should be writing by hand.

CI enforces two things about this: `drizzle-kit check` for collisions and gaps between migrations,
and a generate-and-fail-if-dirty probe that refuses a schema change with no migration written for it.

**If `drizzle-kit migrate` hangs and then exits non-zero with no error**, the journal names a
migration file that is not there. A rebase does this: `meta/_journal.json` is a checked-in file, so
restoring it can reinstate entries for migrations that were renamed. `drizzle-kit check` reports
"Everything's fine" in that state, because it compares schemas rather than checking that the journal
and the directory agree. Compare `meta/_journal.json` against `ls server/drizzle/*.sql`.

## Quality checks

Run these before opening a pull request:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

Integration tests expect a PostgreSQL database with pgvector. Point `TEST_DATABASE_URL` at a dedicated database such as `postgres://remii:remii@localhost:5432/remii_test` before running them.

They refuse to use the application `remii` database. `DATABASE_URL` is still the application setting, and the database client removes it from the process environment after opening a connection to preserve the Windows Bun connection fix, so tests use `TEST_DATABASE_URL` as their immutable fixture address. Running them against a deployment you are using puts test Bots in its audit trail and its activity reports, so create a separate database and migrate that before running the integration suite.

CI uses `bun run test:ci` to verify the expected test count in addition to normal tests.

`bun run test:smoke` is separate and needs a deployment that is up, and a session on it:

```sh
bash scripts/start.sh
export REMII_SMOKE_COOKIE='better-auth.session_token=...'
bun run test:smoke
```

It drives one journey over HTTP against the running stack, so it covers the joins the rest of the
suite cannot reach: server to a real computer, the gateway deciding before the browser acts, and the
audit row landing. Point it elsewhere with `REMII_API_URL`. Without a deployment it is
skipped by `bun run test` and says what to start when asked for by name.

The session is not optional and not a convenience. Every route the journey proves is behind
`requireUser`, so without one the three tests that act on a computer answer 401 and the run reports
a broken deployment when nothing is broken. Take the cookie from a browser already signed in to the
deployment under test, from DevTools under Application, Cookies. It is a credential with that
person's reach: it belongs in the environment of the run, not in a file or a pull request comment.
Asked for without it, the run stops before the first test and names the variable.

### There is no `test:live-screen`

It used to be here, and it drove a real Chromium through `agent-computer/src/index.ts`: a socket
closing mid-launch, a second connection taking the screen, the wheel refusing input from the socket
that did not own it. All of that was Playwright inside a container, and all of it went with the
browser service.

What replaced it is `server/tests/e2b-resume.test.ts` plus the probe script above, and the
difference in what they can see is worth stating plainly: the unit suite proves the provisioner takes
the right branch against a stub, and the probe proves E2B agrees. Neither can prove that a
WebSocket behaves when a browser is half-loaded, because there is no longer a server process here
holding that socket — the frames are sampled from E2B's remote screenshot API instead, and a bug in
that path would show up as a blank frame rather than a dropped connection.

## Contribution checklist

- Keep changes focused.
- Keep credentials, service-account JSON, customer data, and transcripts out of source control.
- Put sensitive behavior on the server, not only in the browser.
- Update [configuration](configuration.md), [architecture](architecture.md), or the root [README](../README.md) when behavior changes.
- Run the quality checks above and include the results in the pull request.
