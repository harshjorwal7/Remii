# Vendored from bloub

These files are copied verbatim from <https://github.com/jeremy-prt/bloub>, at commit
`b4bbc1b5f93c7b87a2e8d620f667c4093d97744a`, under the MIT licence reproduced in `LICENSE`.

Only `src/bot/` came over. The Vue component, the animation editor, the exporter and the i18n
layer did not, because this app renders the bot from React and never exports it.

## Do not tidy these files

The constants in here are **measurements**, not choices. Upstream measured them frame by frame
off a reference video, and their README is explicit that rounding them to friendlier values
breaks the resemblance. Two things follow:

- Biome's linter and formatter are switched off for this directory in the root `biome.json`, so
  a `bun run format` cannot quietly reflow them.
- Reformatting, "simplifying", or adding `readonly` to these types is not a neutral change. If a
  file here must change for a real reason, say why in the commit.

The comments are in French because that is what upstream wrote. Translating them would make a
future diff against upstream unreadable, which is the one thing this directory needs to be.

## What depends on this

`app/src/mascot/` builds on it: `seed.ts` picks a shape/colour/expression from a hash,
`mascot-avatar.tsx` renders `BotEngine.sample()` into an SVG. Nothing in `app/` or `server/`
imports these files directly except through those two.

Upstream disclaims affiliation with x.ai, and so do we: "Grok" and "x.ai" belong to their owners.
The MIT licence covers the code in that repository, not the design it imitates.