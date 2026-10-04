# Coworkers

A coworker is a Bot with a durable profile and standing role. The role is sent with every run so the user does not have to restate the job in each channel.

## Data model

| Piece                | Table                           | Purpose                                                               |
| -------------------- | ------------------------------- | --------------------------------------------------------------------- |
| Runtime agent        | `agents`                        | How the Bot runs: its instruction, or the AG-UI address this deployment runs it at. |
| Profile              | `agent_profiles`                | Name, title, role, avatar seed, mascot, owner, visibility, and soft deletion. |
| Personal roster      | `agent_preferences`             | Per-user hidden state.                                                |
| Channel              | `channels`                      | Conversation membership and coworker binding.                         |
| Intelligence mapping | `intelligence_channel_mappings` | Channel-to-thread mapping.                                            |

Package-provided agents are ownerless templates. User-created coworkers are owned by the creator.

Strict per-user sandboxing: there is no public tier. A template is a DEFINITION
every user may see; the moment a user starts one, it joins their workspace as
their own private copy with their own sandbox, workspace and connections, so no
user can ever see or run another user's coworker, computer or data.

## Standing role

Remote coworkers receive a system message derived from their title and role description:

```text
You are Expense Manager, Finance Operations.

Review receipts, categorize expenses, and prepare reimbursement reports.

This standing role applies in every channel. Treat channel messages as task-specific instructions within it.
```

A further provenance block is appended by the deployment rather than the package: it tells the
coworker to say where each answer came from, to mark plainly anything it answers from its own
knowledge rather than from a source, and never to present the latter as the former. Being deployment-wide,
it cannot be forgotten from the next coworker somebody adds.

The message is ordinary AG-UI system content, so it works with any AG-UI-compatible backend. Editing the role affects the next run.

## Mascot

Every coworker has a mascot: a body silhouette and a colour. There are 7 × 9 of them, drawn by the
engine vendored at `app/src/mascot/bloub` (see `app/src/mascot/bloub/UPSTREAM.md` for the licence and
for why that directory is not formatted or linted with the rest of the app).

It also has a face, and a face is the one thing about a mascot that nobody chooses.

**The face is the work.** `mascotExpressionFor` in `app/src/mascot/ids.ts` maps each product state to
a face: `listening` looks attentive, `thinking` looks curious, `streaming` looks excited, `done` looks
pleased, `error` looks wary. Idle is the exception — there is no work to mirror when nothing is
happening, so it wears the mascot's own resting face, hashed from `avatar_seed` from the ten faces that
read as "at ease" (`RESTING_EXPRESSION_IDS` in `app/src/mascot/seed.ts`).

That is the whole reason `agent_profiles.mascot_expression` no longer exists. It was a column until
migration 0070, and a row of sixteen faces in the customizer until the same change. A chosen face is
one face held for the life of the coworker, so somebody could pick `sleepy` and watch the coworker look
asleep while it streamed a long answer — the picker had no way of knowing that was what was happening,
and the face is the answer to "what is this thing doing". It belongs to the state.

A `mascot.expression` in a request body is now ignored with a warning rather than refused, and
`agent.mascot_expression` in a tenant package is the same: a client or a package from before the deploy
keeps working, and the log says where the value went.

**Nothing has to be chosen.** `agent_profiles.mascot_shape` and `mascot_color` are both nullable, and
a null axis is resolved on the client from `agent_profiles.avatar_seed` by a stable hash. So every coworker that predates the feature — and every one created since that nobody
has dressed — has a mascot, it is different from its siblings', and it is the same one on every
machine and every visit. That is why there is no backfill migration rewriting a row.

Three nullable columns rather than one serialised choice, because a partial choice has to be
expressible: somebody who has only ever picked a colour should still see coworkers that differ in
shape.

| Rule                            | Why                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Omitted `mascot` means untouched | The update endpoint takes the whole profile and the edit form sends the whole form, so an omitted field is how a rename avoids resetting the mascot. |
| A present `mascot` replaces the row | Otherwise clearing one colour would need a separate reset endpoint. An axis left out of a present mascot goes back to the seed.               |
| An unknown id is refused, not dropped | A dropped id renders as somebody else's mascot while the screen says it saved, and there is nothing to see. Refusing says which field is wrong.   |
| A duplicate carries the choice | A copy is meant to look like what it was copied from. `avatarSeed` is copied too, so an unchosen source produces an exact match.               |

The vocabulary lives in `shared/mascot-ids.ts` and is read by both sides, because the server has to
reject a shape it does not recognise and the app has to draw exactly the shapes the server accepts.
Those ids are this codebase's English. The engine's own are French, and `app/src/mascot/ids.ts` is
the only file that knows both — so a rename in the engine cannot break a stored row.

Channels carry the chosen mascots of their agents (`mascots`, keyed by agent id) because a channel
announces its agents and nothing else. Without it, a roster row or a channel header would have to
fetch every agent's profile just to draw a face, and would show a different face from the profile
screen whenever that fetch had not landed. An agent with no choice is simply absent from the map,
and absence is the signal to seed.

A deployment package can set a mascot per coworker with `mascot_shape`, `mascot_color` and
`mascot_expression` in the YAML, validated against the same closed vocabulary and refusing to load on
a typo rather than silently dressing every coworker the same way.

### What animates, and what does not

Three tiers, and the boundaries are where the drawing stops working rather than where the CPU starts
complaining. Getting this wrong is not a subtle degradation: at fourteen pixels a two-holed circle is
not a face, it is a smudge, and every chip in a roster looks like the same smudge.

| Tier            | Sizes       | Face                          | Frame                       |
| --------------- | ----------- | ----------------------------- | --------------------------- |
| chip            | ≤ 20px      | none — silhouette only        | body fills 77% of the square |
| avatar          | 21–47px     | eyes enlarged ×1.2, or ×1.08 below 28px | same            |
| hero            | ≥ 48px      | the engine's own proportions  | same, plus decor             |

The frame is `±1.3` radii for all three, deliberately. A mascot that looked larger in a profile panel
than in the roster row two clicks away would read as two different coworkers, and the whole point of
one avatar per agent is that it is the same face everywhere.

**Every state keeps the body.** Upstream's states declare `baseBody`; when it is false the state draws
its own silhouette and the chosen shape is discarded. Only `idle`, `wink`, `notify` and `swirl` are
true, and only those are used:

| Product state     | Engine state | Why                                                     |
| ----------------- | ------------ | ------------------------------------------------------- |
| `idle`            | `idle`       | the resting face, which is the chosen expression         |
| `listening`       | `wide`       | eyes up, body intact                                     |
| `thinking`        | `swirl`      | rings flare for 1.3s then settle; body never leaves      |
| `streaming`       | `swirl`      | the same, held while text arrives                        |
| `done`            | `wink`       | body intact                                              |
| `error`           | `notify`     | a blue pip on the shoulder; face still there afterwards  |

`thinking` and `alert` upstream are not used. `thinking` shrinks the body to the middle of three pulsing
dots, so a 32px avatar vanishes and three specks appear; `alert` throws an exclamation mark off the
side of the frame and leaves a lone stroke. Both are the clearest "busy" and "broken" signals the
engine has, and both are the wrong signal here: a triangle that stays a triangle while a coworker works
is indistinguishable from a coworker that has stopped, and this product already has real activity
indicators — the roster's typing badge, the per-channel activity brief, the run state on the card. The
mascot's job is to be a recognisable coworker.

**Each coworker rests in its own loop.** Shape, colour and resting face tell a roster apart, but two
differently-shaped mascots sitting in identical stillness still read as clones, so an idle mascot
cycles a short loop seeded from its id — one winks, one looks up, one flicks its rings, one is on the
phone, and about one in eight stays perfectly still. Hold times are jittered per mascot so a roster
never changes posture in unison, which is the give-away that one clock is driving the screen. The loop
is torn down the moment the state leaves `idle`, so it can never argue with a semantic state.

Rings and particles are drawn in the body's own colour, not the engine's gradient. Upstream sweeps the
ring hue across orange, green and cyan; on a mascot whose colour is one of those it reads as three
unrelated party rings, and
this product's palette is greyscale.

**No two coworkers are painted the same.** Eight seeded hues across a roster of a dozen guarantees
collisions, and a real one had them badly: a knowledge bot, an onboarding bot and a release bot all
seeded pink, all three within a shade of one another, reading as one mascot three times. Each palette
colour is therefore given the band of hue that reaches halfway to its neighbours on the wheel — wide for
pink, which has red and violet either side of it and nothing between, narrow for amber, which is boxed
in by orange and yellow — and a coworker takes one continuous point inside its own band's, plus four
per cent of lightness either way. It still reads as the colour it was seeded from; it does not read as
the colour of the coworker next to it.

The palette itself is pitched at mid lightness on purpose. The customizer's own ten swatches were
taken from the upstream screen, where they sit alone on a white background and a very light colour is
enough; here a mascot sits in a roster beside text at 32px, in a product with a dark theme. Nothing at
either end of the range survives both: too light and it disappears into a light surface, too dark and it
disappears into a dark one. Mid lightness with the chroma pushed up is the only family that holds on
both, and the chroma is what "dull" was about in the first place — a desaturated red reads as brown, not
as a red.

**There is no black and no brown.** Both were in the original palette and both are gone from the
vocabulary, the engine's table and the customizer, and neither will come back. At 16 to 40 pixels a
near-black mascot reads as a hole rather than as a coworker, and on the dark theme it disappears into
the surface it is drawn on; a brown one reads as mud. `grey` and `cream` are the quiet end of what is
left and stay: a quiet coworker is a choice, and it is the one nobody mistakes for a status light.
A row written before this still holds `ink` or `brown` in `mascot_color`, and the client drops it as an
id it does not recognise, which sends that axis back to the seed — the same handling a row from a newer
build gets.

`MascotAvatar` animates in place: the frame loop writes SVG attributes rather than React state, one
shared `requestAnimationFrame` drives every avatar in the app, and avatars scrolled out of view stop
being sampled. `prefers-reduced-motion` paints one frame and never subscribes, and the customizer's
swatches are static so twenty-four of them cost twenty-four paints rather than twenty-four engines.

### Default colour

An unchosen coworker is always a colour: `red`, `orange`, `amber`, `green`, `teal`, `blue`, `violet`,
`pink`, evenly weighted — **except a colour a named coworker already wears**. `ink`, `brown`, `grey`
and `cream` are the only exclusions from the palette at all — the first because it is the black this
list exists to remove, `brown` because it reads as mud, and the last two because `cream` rendered a
coworker as a ghost on the light surface and `grey` reads as dead rather than quiet. All nine stay in
the customizer; this is a default, not a palette.

The reservation is derived from the named list rather than written here, so adding a named coworker
takes its colour out of the seed automatically. It exists because the hue-band rule below could not be
relied on for this case: `pink` has red and violet either side of it and nothing between, so its band
is wide, and two coworkers both seeded pink stayed close enough to read as one another. It did happen
— the email manager was born the same pink as Remii, because a hash of its generated id landed there
and nothing was standing in the way. Colour is reserved; silhouette is not, because the band and the
four per cent of lightness are enough to separate two bodies that differ in shape.

Two earlier versions of this list were wrong and both were caught the same way — by rendering a
twelve-row roster and looking at it. One was half `ink`, on the reasoning that a greyscale app should
have greyscale mascots: six of twelve coworkers came out black — which is why the black is out of the
palette now rather than out of this list. The other excluded red and orange
because `--destructive` is a red at hue 27 and `orange` sits on 28, so a mascot in either would sit
beside an activity indicator using that exact hue to mean failure — also true, also the wrong
conclusion, because it bought the avoidance of a rare coincidence with a grey roster. The theme is the
app's *chrome*; the coworker is the thing being recognised at a glance.

### Templates

The sixteen templates the example packages ship are the one place a mascot is *not* left to the hash,
and they carry `mascot_shape` and `mascot_color` in their YAML for that reason. A hash that spreads
well still collides: sixteen templates drawn from the seeded colours put two or three of them in the
same hue every time, and three coworkers in one pink in the template gallery read as one coworker shown
three times. The roster is composed by hand against the rule above, and the closest pair in it is a
third of the colour range apart.

### Remii

`REMII_AGENT_ID` is not hashed. The deployment's own chief of staff is in every roster of every
installation, so it is the one avatar anybody looks at twice, and a hash would make the product's own
assistant look different on every deployment for no reason. It is a pink cloud resting on a curious
face, defined in `NAMED_MASCOTS` in `app/src/mascot/seed.ts` and keyed by id rather than by name —
the name is operator-editable in a tenant package, the id is not.

It is a default and not a lock: `mergeMascotChoice` still lets a chosen axis win, so picking a colour
keeps the cloud and picking a shape keeps the pink.

### Checking it

`app/tests/visual/` photographs the real engine at every size the product uses and compares the result
against a committed PNG. It exists because every scaling bug this feature had was invisible to
everything else: the frame loop writes attributes rather than state, so a mascot a hundred times its
intended size typechecks, renders, satisfies every accessibility assertion and passes every DOM
snapshot — and looks like a grey rectangle. `app/tests/mascot-geometry.test.ts` asserts the numeric
invariants alongside it, with a tolerance of zero and no browser, and is what fails first.

To change a mascot on purpose: edit, then `node app/tests/visual/sheet.mjs --update`, then **read the
resulting PNG before committing it.**

## Visibility

Every coworker is `private`: its owner sees and runs it, and nobody else may
administer it. There is no `public` tier, and nobody may use, see, or run
a coworker that is not theirs. Filtering happens in server/database queries.
Package-provided agents cannot be edited or deleted through the product; they
are definitions only, and every user who starts one gets their own private
copy with their own computer and connections.

## Channels

Starting a channel creates a new conversation and thread. Two channels with the same coworker stay separate.

Each channel routes through a channel-local proxy agent id, pinned to that channel's thread id, then forwards to the coworker runtime id.

## Deleting and hiding

Deleting is soft. The coworker stops running, but existing channels remain readable for their members and restore as tombstones.

Hiding is personal roster state. It removes the coworker from one user's list without disabling the coworker for anyone else.

## Default endpoint

Product-created coworkers use:

```dotenv
MANAGED_AGENT_AG_UI_URL=http://localhost:4201/ag-ui
```

That is `agent-langgraph`, which runs a real framework and its own tool loop. The proof-of-concept on
`4200` hand-writes the protocol and leaves the loop to whatever is watching, so it is a reference
rather than something to build a deployment on.

The URL is optional. Set it with `MANAGED_AGENT_TOKEN`, or leave it unset: product-created coworkers
then run in-process on their role description rather than at an address, and a package agent whose
endpoint expands to nothing is omitted rather than registered against a missing host. A leftover
token with no URL is ignored. Package-provided agents otherwise use their own `agents.yaml`
configuration.

## Register an AG-UI agent the deployment runs

In `agents.yaml`:

```yaml
agents:
  - id: risk
    name: Risk
    title: Risk & Compliance
    role_description: Investigate policies and controls.
    type: remote-ag-ui
    endpoint: ${MANAGED_AGENT_AG_UI_URL}
```

Every address in a package comes from the deployment's own configuration, and both shipped rows are
the deployment's own Bot: the one in the box, and the framework picked during setup. A coworker
created in the product always runs on that engine — the create form has no address field and no key
field, and the API refuses either rather than ignoring it, so a stale client cannot point a Bot
somewhere it does not belong. A coworker created where the deployment has no engine of its own runs
in-process on its role description instead.

## Capabilities

A coworker's role description does not grant capabilities. Capabilities are governed separately:

- browser and file actions go through the computer gateway policy;
- components are published deployment-wide and can be withheld per Bot;
- MCP tools are granted per Bot by the Bot's own owner;
- skills can be attached only to Bots the person writing them owns — including the ones the tenant
  package ships, which are visible to everyone but still go only onto Bots a grant names.

See [architecture.md](architecture.md).
