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

## Typography

**Display Font:** IBM Plex Sans (fallback: system-ui, sans-serif)
**Body Font:** IBM Plex Sans (fallback: system-ui, sans-serif)
**Label/Mono Font:** IBM Plex Mono (fallback: monospace)

**Character:** One superfamily, two registers. Plex Sans carries prose, values
and headings; Plex Mono carries labels, counts, code and anything that should
read as "measurement". The pairing is technical without being costumed — mono is
used for data and labels, never as a decorative "tech" texture.

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
· `15` panel/modal headlines · `16` large headlines · `24` reader display. New
sizes should reuse these steps rather than inventing intermediate ones.

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
