---
name: autonomous-agent dashboard
description: A quiet, near-monochrome control surface for one autonomous crypto-research agent.
colors:
  ink: "oklch(0.22 0.018 262)"
  bg: "oklch(0.975 0.006 250)"
  surface: "oklch(0.995 0.003 250)"
  muted: "oklch(0.49 0.025 258)"
  hairline: "oklch(0.82 0.014 258)"
  veil: "oklch(0.18 0.02 262 / 0.24)"
  accent: "oklch(0.54 0.13 224)"
  accent-fg: "oklch(0.99 0.002 250)"
  label: "oklch(0.47 0.09 230)"
  warn: "oklch(0.58 0.14 55)"
  error: "oklch(0.55 0.19 25)"
  layer-cryptography: "oklch(0.52 0.07 208)"
  layer-foundations: "oklch(0.51 0.075 250)"
  layer-platforms: "oklch(0.5 0.07 280)"
  layer-applications: "oklch(0.5 0.065 300)"
  layer-market: "oklch(0.55 0.1 78)"
  layer-cross-cutting: "oklch(0.5 0.018 258)"
typography:
  display:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.25
  headline:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  dense:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "IBM Plex Mono, monospace"
    fontSize: "9px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.08em"
  label-lg:
    fontFamily: "IBM Plex Mono, monospace"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.08em"
  lg:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.3
rounded:
  none: "0"
spacing:
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "14px"
  xl: "20px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bg}"
    rounded: "{rounded.none}"
    padding: "8px 14px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "6px 10px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "12px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "7px 9px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.none}"
    padding: "5px 7px"
---

# Design System: autonomous-agent dashboard

## Overview

**Creative North Star: "The Quiet Observatory"**

This is a room where one person watches a system think. The interface is built to
recede: near-monochrome surfaces, a single blue accent, hairline structure, and
type that does the work hierarchy normally outsources to color and shadow. It
reads like a well-kept instrument panel — control labels set small in mono,
values set in sans, everything on a strict grid with sharp corners and no
ornament. Nothing competes with the knowledge graph, which is the one place the
palette opens up (six layer hues, used inside the graph alone).

The density is high but never crowded: railed navigation, compact panel headers,
and controls that appear on hover rather than sitting on the surface. Motion is
almost invisible — a 0.15s ease on borders and color, small translate entrances —
so the interface feels settled rather than animated. Where a generic dashboard
would reach for cards, icons and a second accent, this one reaches for a hairline,
a mono label, and restraint.

**Key Characteristics:**
- Near-monochrome neutral base; one blue accent, used sparingly.
- Sharp corners everywhere — radius 0, enforced globally.
- Flat surfaces: depth via hairline borders and tonal layering, never shadow.
- IBM Plex Sans for content, IBM Plex Mono for labels, data and code.
- Compact, tactile controls; mono-uppercase micro-labels.
- One authored moment (entrance fade/translate), not scattered effects.

## Colors

The palette is a near-monochrome neutral ladder anchored by a single blue. Color
carries meaning only where the graph needs it.

### Primary
- **Instrument Blue** (`oklch(0.54 0.13 224)`): the accent. Focus rings, active
  nav, caret, selection tint, primary buttons, the live-stream blink. Used on
  roughly ≤8% of any given screen — its rarity is what makes it read as "active".

### Neutral
- **Ink** (`oklch(0.22 0.018 262)`): primary text and the fill of solid buttons.
  Flips to near-white in dark mode.
- **Background** (`oklch(0.975 0.006 250)`): the page ground.
- **Surface** (`oklch(0.995 0.003 250)`): cards, panels, inputs — a hair lighter
  than the ground so borders read as the separator, not shadow.
- **Muted** (`oklch(0.49 0.025 258)`): secondary text, captions, placeholders.
- **Hairline** (`oklch(0.82 0.014 258)`): every 1px border and divider.
- **Veil** (`oklch(0.18 0.02 262 / 0.24)`): modal/overlay scrim.
- **Label** (`oklch(0.47 0.09 230)`): the mono micro-label tint, a whisper of the
  accent so labels sit in the same family without shouting.

### Graph layer hues (scoped to the knowledge graph only)
Six layer colors — **cryptography** `208`, **foundations** `250`, **platforms**
`280`, **applications** `300`, **market** `78`, **cross-cutting** `258` (all
oklch ~0.5 lightness, low chroma). Plus three **status** colors: **warn** (`55`,
pending), **error** (`25`), and **analysing** (`200`, a calmer blue-teal distinct
from the accent so "analysing" never reads as "active"). These never appear in
the shell chrome; outside the graph and status pills the UI stays neutral.

### Named Rules
**The One Voice Rule.** The accent appears on ≤10% of any screen. If two things
are both "active," neither is.

**The Graph-Only Color Rule.** Layer hues live inside the knowledge graph and
nowhere else. Chrome stays neutral so the graph's color is legible as information.

**The Auth Panel Rule.** The sign-in page's right half is a night sky: the
vault's real knowledge graph — the same deterministic build the workspace renders
— read as an observatory rather than a diagram. Its 246 notes are stars (layer
sets the colour, degree the size), the field breathes on its own epicycles while
the disc turns almost imperceptibly, the graph-walker now and then walks a light
path of two or three links, a comet crosses, and a new star kindles as a note is
added. It is theme-aware twice over: deep ink at night, a star chart on paper by
day. It does **not** override the layer hues — it inherits the theme's own `--l-*`
ramp, so the six neighbourhoods read bright on ink and deep on paper. Its own
ground/ink pair (`--axg-ground` / `--axg-ink` / `--axg-muted` / `--axg-rule`) and
the additive-vs-source-over blend both switch with the theme. This is the one
place the shell leaves the neutral ladder — the graph is the product, and here it
is the product's front door; the left half and every other surface stay neutral.

## Typography

**Display Font:** IBM Plex Sans (fallback: system-ui, sans-serif)
**Body Font:** IBM Plex Sans (fallback: system-ui, sans-serif)
**Label/Mono Font:** IBM Plex Mono (fallback: monospace)
**Serif Font:** IBM Plex Serif (fallback: Georgia, serif) — the auth screens'
display register only.

**Character:** One superfamily, two registers — Sans carries prose, values and
headings; Mono carries labels, counts, code and anything that should read as
"measurement". The pairing is technical without being costumed — mono is used for
data and labels, never as a decorative "tech" texture. A display register appears
on exactly one surface, the auth screens: the serif sibling sets the typed,
evocative clause (Plex Serif 400), and a single keyword per heading is set in an
**elegant rotating display face**. That keyword cycles through six faces on an
accelerating cadence (820ms easing each step by 0.7 down to a 120ms floor) — the
scripts Great Vibes and Pinyon Script, and the italic display serifs Cormorant
Garamond, Playfair Display, EB Garamond and Bodoni Moda. The faces differ in
x-height, width and baseline, so each is normalized on all three axes (all
measured in-browser via canvas TextMetrics, not spec tables): `font-size` matches
its x-height to the serif line, `scaleX(--sx)` matches its rendered width, and
`translateY(--y)` locks its baseline — so the word does not flicker, stretch or
bob as it swaps. Once, at a random 3–10s after load, a blue mark slides in behind
the word and stays; the word itself is never recoloured. All auth-only; none
touches dashboard prose.

### Hierarchy
- **Display** (700, 24px, 1.25): reader document titles only.
- **Headline** (600, 15–16px, 1.3): panel headers and modal titles.
- **Title** (600, 13–14px, 1.3): section headings, card names.
- **Body** (400, 11–12px, 1.5): chat messages, prose, values; reader body steps
  to 13.5px/1.7.
- **Label** (400, 9–10px, uppercase, tracking 0.08em, mono): field labels, panel
  eyebrows, status stamps. Small, spaced, mono — the signature micro-register.

**Scale in use** (the literal steps the CSS ships, 9px → 24px): `9` status stamps
and micro-labels · `10` panel eyebrows and field labels · `11` dense body, values,
mono data · `12` chat/reader body and code · `13` card titles · `14` default body
· `15` panel/modal headlines · `16` large headlines · `24` reader display and
metric numerals. New sizes should reuse these steps rather than inventing
intermediate ones.

**The one exception:** the auth screens are the product's single Persuade
surface, so they carry a display voice the Operate shell may not. Two fluid
steps exist there and nowhere else — the display step `--h1`
(`clamp(32px, 3.2vw, 44px)`, tracking -0.02em) shared by the serif clause and the
keyword, and the sans clause `clamp(24px, 2.4vw, 32px)` (tracking -0.03em). The
keyword does **not** carry a size per face: every face renders at `--h1` scaled by
an optical multiplier that normalizes its x-height to the serif line's
(`calc(var(--h1) * 0.516 / face-xHeight)` — Great Vibes ×1.57 down to Playfair
×1.00), so the word reads at one size through the whole rotation. Nothing in the
dashboard may follow them past the 24px ceiling.

### Named Rules
**The Measurement Rule.** Mono is for data, labels and code — durations, counts,
IDs, field names. Never set prose in mono for flavor.

## Layout

Fixed shell: a collapsible left nav rail, a top bar, and a single content column
that swaps views by state (not route). Content panels are dense: 14px gutters,
10–14px internal gaps, `repeat(auto-fill, minmax(220px, 1fr))` for the agent
grid, and 2-column forms inside modals. Spacing steps are 6 / 8 / 10 / 14 / 20px.
More space above a heading than below it. The layout optimizes for a single
operator scanning one screen, not for wide-breakpoint marketing composition.

**The console workspace.** The agent chat is the one view that abandons the
single-column panel model: it is a three-zone grid — the left nav rail (global),
a center conversation track, and a right operational rail. At 1440 the center
takes ~72% and the rail ~28% (`grid-template-columns: minmax(0, 1fr) clamp(304px,
25vw, 372px)` when open; the rail collapses to `0` and the center reclaims the
full width when closed). Agent answers take the full center column as a
structured document; user turns cap narrower (`min(680px, 78%)`) and align right.
Below 1100px the rail leaves the grid and overlays as a right drawer. The rule is
*more information density, not a full-width text wall*: the conversation is the
workspace, and the instrument panel sits beside it, never as a bubble in a void.

## Elevation & Depth

**Flat by default — no shadow at rest.** Depth is conveyed tonally (surface sits
a hair above background) and structurally (1px hairline borders everywhere). A
single soft popover shadow (`--pop-shadow`) exists for genuinely floating layers —
modals, dropdowns, the agent form — where a border alone would not detach the
surface from the page beneath. The hard-offset `--card-shadow` token exists but
is unused; do not reach for it.

### Shadow Vocabulary
- **Popover only** (`box-shadow: 0 2px 8px oklch(0.2 0.02 260 / 0.18)`): modals,
  menus, the agent form. Never on cards or list items.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. The only shadow is the
popover shadow, and it appears only on things that truly float.

## Shapes

Sharp, orthogonal, rectilinear. `border-radius: 0 !important` is applied to every
element, so corners are always square — buttons, cards, chips, inputs, avatars,
modals alike. Form is expressed through 1px lines and edges, never through roundness.
Circles appear only as data marks inside the graph (nodes, rings), never as
chrome. The one visual exception is the graph's organic node field, which is the
content, not the shell.

## Components

### Buttons
- **Shape:** square (radius 0), 1px border or solid fill.
- **Primary (solid):** ink fill, bg-colored text (`cs-save` "Save", "Create agent").
- **Secondary / Ghost:** transparent with an ink or hairline border that inverts
  to solid on hover (`newchat-btn`, `reg-btn`, `rd-back`).
- **Danger:** error-colored border/fill, reserved for destructive confirmation
  (`cfg-danger-btn`).
- **Hover / Focus:** background/color/border transition at 0.15s ease; focus is a
  2px accent outline offset 2px.
- **Icon buttons** (`card-act`, `reg-del`): 24–26px square, muted by default,
  ink (or error) on hover; card actions stay hidden until card hover/focus.

### Chips
- **Style:** transparent, 1px hairline border, mono-ish 11px, muted text.
- **State:** `aria-pressed="true"` inverts to solid ink / bg. Filter chips and
  composer chips share this treatment.

### Cards / Containers
- **Corner Style:** square (radius 0).
- **Background:** surface.
- **Border:** 1px hairline; hover shifts the border to ink and lifts 1px.
- **Attention state:** warn border + a 3px inset warn edge (the one place an inset
  edge is used, and only on the attention card).
- **Internal Padding:** 12px.

### Inputs / Fields
- **Style:** surface fill, 1px hairline, square, mono 11px text, 7px×9px padding.
- **Focus:** border shifts to accent (no glow).
- **Labels:** mono uppercase 9px, tracking 0.08em, muted.

### Navigation
- **Style:** left rail; icon + label rows. Active row uses the accent; inactive is
  muted, ink on hover. Collapsible to icons only.

### Signature Component: the knowledge graph
Build-time precomputed positions; zero client layout; six layer hues; one edge
type (resolved wikilink). It is the only surface where the palette opens up, and
it sets the bar every other panel must not distract from.

### Signature Component: the agent console
The chat inside a Swarm agent is the product's control surface — a three-zone
execution workspace, not a chat column. It refuses the wait-then-answer chatbot
default and reads instead as an instrument panel:

- **The console header.** Identity on the left (avatar tile, name, mono role),
  the live state block beside it (lamp + state word + `heartbeat 2.1s ago` +
  what-it-is-doing sub-line), the session id, then the actions scoped to this
  agent: Focus-in-graph, the conversation's model picker, New chat, and the rail
  toggle. It reads as *selecting an active worker*, not opening a conversation.
- **The telemetry strip.** HEARTBEAT · STATUS · UPTIME · TASK QUEUE · ERROR RATE
  · THROUGHPUT · LATENCY, every cell derived from real backend state and rendered
  in mono tabular numerals. When a reading cannot be measured yet it shows `—`
  (with `no history` as a sub-line), never a fake zero. The header carries the
  live state word (WORKING / LIVE / IDLE / STALE / OFFLINE) with a lamp.
- **The execution spine.** A turn folds the real SSE stream into a vertical
  hairline spine of discrete activities (thinking, search, read, run, delegate,
  answer), each a small circular status node — the one shape reserved for data.
  Exactly one node carries Instrument-Blue at a time: the freshest still-running
  step (One Voice Rule). Settled sections collapse; the active one stays open.
- **The reasoning block.** The model's streamed reasoning is a collapsed
  `<details>` that shows a measured summary (`REASONING · 4.2s · 8 operations`)
  folded from the turn's own trace — never raw chain-of-thought front and centre.
- **The command composer.** Anchored at the bottom of the center track, carrying
  a context strip (`A1 › model`) so a command visibly names its target, then the
  textarea and the action row (attach, Reasoning, Deep research, voice, send).
- **The operational rail.** A persistent right panel with three tabs — Console,
  History, Config — so the center stays pure conversation. Console stacks four
  sections under mono headings: **SWARM** (every agent with its live telemetry
  state and lamp; click to switch), **CURRENT TASKS** (the run actually in flight
  plus the queue), **AGENT ACTIVITY** (newest-first, folded from the real
  execution trace, not a synthesized feed), and **KNOWLEDGE GROWTH** (the graph's
  node-creation curve). History folds the session list; Config folds the existing
  per-agent configuration pane. Below 1100px the rail becomes a right drawer with
  a veil and its own close control, and the conversation goes full width.
- **The empty state.** Addresses the worker, not the visitor: the agent's tile,
  name and role, then `What should I investigate?` and four operational starters
  (Research a topic / Analyze existing knowledge / Investigate a source / Trace
  relationships). Never a generic "How can I help?".
- **Derived, never mocked.** The figures fold from the in-process run registry,
  the persisted `messages` table (timestamps + recorded event log) and
  `process.uptime()`, served by `GET /api/telemetry` and polled by the client.
- **Knowledge references.** An answer's `[[wikilinks]]` render inline as accent
  citations *and* as a `N REFERENCES` chip strip beneath it; both route to the
  same "focus in graph" action, keeping the conversation wired to the live graph.

Like the graph, the console earns its motion: the spine, the status lamp, the
typewriter reveal and the drawer slide are the only animations, all short and all
stilled under `prefers-reduced-motion`.

## Do's and Don'ts

- **Do** keep chrome neutral; let the graph carry color.
- **Don't** introduce a second accent or a warm color into the shell.
- **Do** use mono for labels, data and code, uppercase and small (9–10px).
- **Don't** set prose in mono, and don't use mono as a "technical" costume.
- **Do** separate surfaces with 1px hairlines and tonal surface shifts.
- **Don't** add shadows to cards or list items — flat at rest is the rule.
- **Do** keep every corner square; radius is 0 everywhere.
- **Don't** round a button, chip or modal to "soften" it.
- **Do** keep motion to 0.15s ease on border/color, plus the single entrance
  fade/translate; respect `prefers-reduced-motion`.
- **Don't** animate layout properties (width/height/padding/margin) — use
  transform/opacity.
