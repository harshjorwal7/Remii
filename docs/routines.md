# Routines

A routine is a standing instruction: something a Bot carries out on a schedule instead of waiting to
be asked. "Every weekday at nine, summarize what changed in this channel overnight" is a routine, not
a message — it fires on its own, for as long as it stays switched on, and its reply lands in a channel
the same way any other message from that Bot does.

## Creating one

There is no form for this. Ask a Bot, in a channel: "every weekday at 9, post the standup notes
here." Turning a sentence into a five-field cron expression and a channel is conversational work, and
that is what the conversation is for. The same Bot can list what is standing, change one, or delete
one, all by being asked.

**The prerequisite:** a Bot can only do this once you have granted it to. Routines is a
catalogue entry like any other — `create_routine`, `update_routine` and `delete_routine` are its write
tools — and adding the entry does not hand any Bot access to it. Each tool is granted per Bot from
the coworker's own **Connection** tab under `/agents`, exactly as a Google Drive or Notion tool
would be. Deciding which of your Bots may schedule future work at all is a step before deciding what
that work is; a Bot with none of the three tools can still be asked and will say it cannot.

The routine belongs to whoever asked for it and runs as them. See
[Who a routine runs as](#who-a-routine-runs-as).

## The 15-minute floor and the 20-enabled cap

A routine may fire at most every 15 minutes. The floor exists because a model can be talked into
anything a sentence can describe, including "every minute", and the floor is what a sentence cannot
talk its way past.

A person may have at most 20 routines switched on at once. The cap exists for the same reason as the
floor: a conversation is an easy place to accumulate standing work without noticing, and 20 is where a
person's own list stops being something they can hold in their head. Switching one off frees a slot;
deleting one is not required.

## The fatigue rule

A routine that fails posts exactly one message about it — the first failure after a success, not
every failure. Ten consecutive failures switch the routine off and post a second, final message
saying so; nothing further fires until a person turns it back on.

The Routines page shows that count before it arrives at ten, because the channel message is the
announcement that it already has. A routine carrying a streak is a person who still has time to fix
it.

This is deliberately not a retry policy. A retry policy answers "did this one attempt make it through
a dispatch that failed for a moment" — a busy queue, a server that hiccuped — and that question is
already answered by the shared work queue's own attempt count, quietly, before a routine's turn ever
runs. The fatigue rule answers a different question: is this routine worth firing at all. A Notion
token that expired in March fails cleanly, once, every single night, and no number of retries of any
one night's attempt will fix that — only switching it off, and saying so, does.

## Missed windows are skipped, not replayed

A routine's next run is a stamp, not a queue. If nothing was watching the clock — a worker that was
never started, or one that was down for a month — a routine's stamp falls behind, and the deployment
does not owe it every occurrence it missed: catching up is a silent drain, not a burst. A deployment
whose worker comes back after a quiet month drains that backlog in one pass, by computing the next
occurrence from the moment the sweep actually runs rather than from the stamp it found, until it is
current again — not by firing thirty stale summaries of thirty different mornings, and not by walking
the backlog one occurrence per sweep, which kept a fifteen-minute routine silent for a further
fortnight.

A firing that is still recent enough to be worth having does still happen. A server pod that restarts
loses at most the one occurrence that was in flight when it stopped; the next one fires on schedule,
because the clock had already moved on before that firing was attempted. A server that stays down
loses more than that: every occurrence whose stamp ages past the grace window while nothing can
carry it out is skipped, not just the one that was in flight.

## The worker requirement

Nothing above happens without a second process. The API server answers `/internal/routines/run` when
it is handed a run, but nothing hands it one on its own — that is a separate worker's whole job, and a
deployment that never started one schedules nothing.

This used to fail silently. A routine created in chat is stored, its schedule is computed, and the
Routines page shows it sitting there with a next run time like any other — because as far as that
page knows, it is correct. A deployment with no worker looked identical to one running normally,
right up until nobody's standup notes ever arrive.

Each sweep now records that it happened, in `routine_sweeps`, and the Routines page reads it. A
person with standing routines and nothing sweeping is told so: that no worker has ever checked in,
or when the last one did. The window is `MINIMUM_INTERVAL_MS` — fifteen minutes, the floor a
routine's own schedule already has, so a gap longer than that is one no routine could have wanted.
A CronJob scheduled less often than that will read as quiet between runs.

Two settings carry this:

- **`WORKER_SHARED_SECRET`** — the credential the worker presents to `/internal/routines/run`. The API
  server refuses every handoff without it configured on both sides, and the worker refuses to start
  without it at all, rather than firing routines nobody could ever prove came from it.
- **`SERVER_INTERNAL_URL`** — where the worker reaches this deployment's own API server. It is a fact
  about where the worker process runs rather than a fact about the deployment, so it is read from the
  environment directly rather than from the rest of the deployment's configuration.

On Kubernetes, `routines.enabled` turns on a CronJob running `fire-routines.ts` on `routines.schedule`,
the same way the computer culler is a CronJob rather than a timer inside the API — a timer fires in
every replica, and a CronJob's single run does the whole sweep once. On a laptop, `scripts/start.sh`
starts a worker process that runs that same sweep in a loop instead of once and exiting, so the two
shapes are the same code doing the same thing on two different clocks, not two implementations to keep
in sync.

## Who a routine runs as

A routine runs as the person who created it, not as the Bot and not as the deployment. Its turn is
built with that person's own grants, so it can do in the middle of the night exactly what they could
do by typing the same instruction in chat themselves, and nothing more — a routine cannot reach a
connector its creator never connected, or post into a channel they are not in.

"Exactly what they could do by typing it themselves" is carried by the collaborators the turn is
built with, not only by the grants: a routine's Bot holds the same `message_bot`, `delegate_bot`,
`ask_person` and `connect_app` a chat turn offers, built from the same closure, so a Bot that can
hand work sideways when somebody is watching can also do it at three in the morning. Its reply is
posted into the channel as an ordinary message from that Bot: it lights the recipients' unread dot
the same way any other Bot message does, and it appears in the conversation transcript rather than
anywhere separate, because as far as the channel is concerned, that is exactly what it is.

A coworker that is **paused** is the one thing a routine will not wake. The pause is enforced for
chat turns and for handoffs, but a routine is neither typed at nor handed to, so the pause is read
where the decision is made. The firing is recorded as `skipped` rather than failed, and nothing is
posted in the channel: a pause is the owner's decision and it is temporary, so counting it as a
failure would walk the fatigue rule and switch the routine off after ten paused nights.

### What a routine's turn does not get

The turn enforcement wrapper — `EnforcedAgent`, which meters a person's own chat turn and bills it —
is deliberately **not** given to a routine, and the reason is worth knowing before anyone "fixes"
that. The wrapper answers `runAgent` by forwarding to the agent it wraps, which leaves its own
`messages` array as the caller seeded it; a routine recovers its reply by diffing exactly that array,
so a wrapped routine reads back as having said nothing and every firing is recorded as "the turn
finished without saying anything". It would also charge the turn twice, once through the wrapper's
settlement and once through the routine's own.

So a routine's metering, its loop breaker and its credit charge are its own, in
`server/src/routines/run-turn.ts`, which is the only place that can stop a headless turn on a
deadline anyway.

## Scope

This ships the core: creating, listing, changing and deleting routines from chat; the schedule, the
cap and the fatigue rule; the worker that fires them. Audit rows now say what started the run they
came out of, so a
routine's action is told apart from the same person's own by reading the row rather than by
correlating timestamps against `routine_runs`. See [Architecture](architecture.md#what-started-a-run). Still open:
routines are owner-scoped by row and there is no deployment-wide list of them — not because such a
view was withheld, but because there is nothing to widen it to, since no query here can reach past
the owner's id; there is also no
per-Bot cap on how many routines may be running at once beyond the sweep's own claim
limit; and a tenant package cannot yet ship routines the way it ships agents, channels or skills.

## See also

- [Architecture](architecture.md) — where the routines sweep sits beside the computer culler on the
  shared work queue.
- [Coworkers](coworkers.md) — durable Bot profiles and channels, which a routine posts into.
- [Configuration](configuration.md) — `WORKER_SHARED_SECRET`, `SERVER_INTERNAL_URL`.
