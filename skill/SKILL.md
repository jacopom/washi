---
name: washi
description: Shape a feature before building it — numbered regions of low-fi wireframe screens, cut-outs, steps and decisions taped together with flows — in Washi's fixed JSON language, rendered live at localhost:4747. Use when the user asks to shape, sketch, wireframe, map the flow of, or plan the screens of a feature, to revise an existing shape, or to read comments left on one.
---

# Washi

A shape is the mid-altitude sketch of a feature: **numbered regions** (stages of the story, often phrased as a question), each holding **low-fi screens** built from a fixed set of widgets, **dashed cut-outs** for the variants of a slot, **gray steps** for what the system does, **green decisions**, **flows** taping them together, and **notes / red open questions** on the drawing. Flows that leave a region become exit labels like "Film (1)", so the drawing never turns into a hairball.

You write it in a fixed JSON language; the viewer at http://localhost:4747 renders it live and keeps every valid save as a version (v1, v2…), so the user watches the shape change and can replay it. The tool lives at `~/Projects/washi`; the `washi` CLI is on the PATH. Never invent keys, node types or widget types — the fixed language is the point; the checker rejects anything else.

## Setup

- Shapes live in `<project>/washi/<slug>.json`. The viewer watches every `~/Projects/*/washi/` folder at once and runs as a LaunchAgent, so it is normally already up: `curl -s localhost:4747/api/state`. If it's down: `launchctl kickstart -k gui/$(id -u)/com.jacopo.washi` (or `washi serve` in the background).
- In the viewer and for `washi shot`, a shape is named `<project>/<slug>` (a bare slug works when unambiguous).

## The language

```json
{
  "title": "Cineteca",
  "option": "my own Letterboxd",
  "prose": "Paragraphs separated by blank lines. **Bold** works. The why, in plain words.",
  "slices": [ { "id": "S1", "title": "Film page + sync", "note": "optional" } ],
  "regions": [
    { "id": "R1", "title": "Tonight · what do I watch?", "row": 0, "col": 0, "note": "optional" },
    { "id": "R5", "title": "Explore · Ask", "row": 2, "col": 1, "variantOf": "R4" }
  ],
  "nodes": [
    { "id": "film", "type": "screen", "region": "R1", "slice": "S1", "caption": "Film", "title": "Paterson (2016)", "widgets": [
      { "type": "text", "text": "Jim Jarmusch · 118'" },
      { "type": "slot", "id": "status", "text": "Status: depends on where the file is" },
      { "type": "button", "id": "log", "text": "Log on Letterboxd" }
    ], "note": "gray note under the card", "question": "red open question" },
    { "id": "where", "type": "decision", "region": "R1", "slice": "S1", "text": "where's the file?" },
    { "id": "status-mac", "type": "cutout", "region": "R1", "slice": "S1", "caption": "Status · on the Mac", "widgets": [
      { "type": "button", "id": "archive", "text": "Archive", "primary": true }
    ] },
    { "id": "move", "type": "step", "region": "R1", "slice": "S1", "text": "Finder job: archive to Proton" }
  ],
  "flows": [
    { "from": "film.status", "to": "where" },
    { "from": "where", "to": "status-mac", "label": "on the Mac" },
    { "from": "status-mac.archive", "to": "move" }
  ]
}
```

- **Regions** `R1, R2…`, numbered in list order. `row` puts a region on a row (default 0); `col` orders regions within the row, which packs left to right. Put the story's start top-left.
- **Options** for one stage: give the alternatives `"variantOf": "R5"` and put them on their own row. They are badged 5A, 5B, 5C… and the base region becomes 5A. Use this whenever the user asks for variants or alternatives of a region.
- **Nodes** have lowercase slug ids and one of four types:
  - `screen` — a wireframe card: `title` (window title), optional `caption` (label above, e.g. "Request · Planner"), `widgets`, optional `w` (160–520, default 270).
  - `cutout` — dashed card showing one variant of a slot: `caption` + `widgets`, optional `w`.
  - `step` — what the system does, in plain words: `text`.
  - `decision` — green diamond: `text` (short question). Every answer is a labelled flow.
  - Any node can carry `note` (gray), `question` (red, listed under Open questions) and `slice`.
- **Widgets** (only these): `heading{text}`, `text{text}`, `field{label?, text?}`, `button{text, primary?}`, `image{text?}`, `list{label?, items}`, `tiles{label?, items}` (poster grid), `columns{columns:[{title, items}]}` (board), `post{who, when?, text, image?}` (thread entry), `slot{text}` (dotted placeholder filled by cut-outs), `tabs{items, active?}`, `select{label, value?}`, `toggle{label, on?}`, `progress{label, value 0–1}`, `divider{}`. Give a widget an `id` to wire from it.
- **Flows**: `from` is `node` or `node.widget`; `to` is always a node; `label` is the trigger or answer ("click", "on the Mac"). A flow to a node in another region renders as an exit label — that's intended.
- **Slices** (optional) split the shape into build increments. Once `slices` exists, every node outside option regions should carry one; the viewer can show one slice at a time and `washi md FILE --slice S1` exports just that increment.

## Loop: comments → save → check → look → report

1. **Read comments first**: `washi comments <file>`. The user leaves them in the viewer, pinned to a node or a spot on the canvas. They are the agenda for the next version.
2. Edit the JSON. One idea per save — each valid save is a version, and the viewer marks nodes added (green), changed (yellow) and removed (red dashed ghost) since the previous one.
3. `washi check <file>` — errors mean the viewer keeps the last valid version. Warnings (dead buttons, unreached screens/cut-outs, unlabelled answers, nodes outside any slice) are design smells: fix or justify them. `render:` lines are text the viewer had to cut off — shorten it or widen the card (`w`).
4. Look at the redraw before reporting: `washi shot <slug> [--region R2]` prints a PNG path; Read it. Check that what you meant is legible on the drawing, not just in the JSON.
5. Resolve what you addressed: `washi resolve <file> c3 "Split into two cut-outs in v14"`.
6. Report: "Saved as v7, checks passing." then what changed in bold-led short paragraphs, a **Removed:** list if anything went, and **Decisions for you:** for anything you chose on the user's behalf. Don't re-describe the whole shape.

## Shaping well

- Draw what the person sees, in plain words. Everything in English (UI copy, regions, notes), even if the app or the conversation is Italian. Steps in plain words, not function names.
- Name screens by viewer when it matters ("Request · Requester" vs "Request · Planner") and draw them side by side.
- A slot plus a decision plus cut-outs is how you show "this block depends on who's looking / what state it's in" without duplicating the whole screen.
- Put unresolved things on the drawing as `question` — they're the agenda for the next conversation.
- Keep ids stable across versions: the diff, the replay and the layout (positions are remembered per node id) all depend on it. Stay low-fi: no colors, spacing or polish.

## Handoff to a build agent

When the user says it's done: `washi md <file> > <project>/docs/<slug>-shape.md` (or one file per slice with `--slice`) — regions, screens with their widgets and where each one leads, steps, decisions, slices and the open questions. Commit it with the JSON and `<slug>.comments.json`; that's the plan the builder works from. The viewer's "Copy plan" gives the same text (for the selected slice, if one is picked).
