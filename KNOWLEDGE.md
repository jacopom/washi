# Knowledge

## Why a fixed language
Prompts and skills alone drift — the agent invents a slightly different notation each time. Fixing the vocabulary (4 node types, 16 widget types, unknown keys are errors) and checking every save makes versions comparable: you see whether the *flow* changed, not the diagram style.

## Why screens, not a node graph
The first version was a classic graph of places, UI/code affordances and stores. On a real feature (Cineteca, 11 places) it became a hairball even with store reads hidden. Wireframe screens in numbered regions, cut-outs + decisions for state variants, exit labels for cross-region flows, and notes/questions on the drawing read far better. Old-format shapes and histories don't render any more.

## Layout
- Each region is laid out on its own (ELK layered, RIGHT). Cross-region flows end in an exit node in the source region — that keeps edges short.
- Exit ids are `exit--<from>--<to>`: one per flow (shared exits made converging arrows and stacked labels) and stable across edits (index-based ids broke saved positions).
- Every incoming flow gets its *own* WEST port (screens: stepping down from the title bar; steps: centred); labels use ELK `HEAD` placement with a paper-coloured text halo. Shared in-ports made lines merge into a bus.
- Self-loops (a widget leading to its own screen) skip ELK and are drawn as a circular-arrow note next to the widget: "<label> · same screen". There's no wire, because it isn't a navigation. A wire-hook version with an arrowhead was unreadable at that size. The node is widened by a gutter so ELK keeps that space clear of other wires. (A bracket up to the title bar crossed the vertical wire lanes, and ELK's own routing went around the whole card like a second border.)
- A wire from a narrow widget (button, text link) starts at the widget with a dot and runs across the card to its port. Starting at the card edge left it unclear which button a wire belonged to. Wires are drawn after the cards for this reason, with pointer-events off so they don't block hover and click.
- Back flows inside a region (target listed before the source: Close, Back, Not now) end in a muted name stub, like a cross-region exit without the region number. Drawn as wires they each looped around the region to a separate in-port on the home screen.
- Arrowheads use `markerUnits="userSpaceOnUse"` (10px) so they don't shrink with thin strokes.
- **Stable layout**: after each live draw the viewer saves region-relative node positions to `.history/<slug>.layout.json`. When at least half of a region's nodes have a saved position, ELK runs with INTERACTIVE cycle breaking / layering / crossing minimization seeded with them; new nodes get a guessed position next to a connected neighbour. Only the live view saves, so `washi shot` (headless) draws the same picture the user sees.
- Cycle breaking uses `MODEL_ORDER`: nodes are listed in story order, so a flow back to an earlier node (Close, Back, "not now") is the one reversed. The default greedy strategy put the Proton VPN popup's home screen at the far right of its region, with everything reading backwards.
- Regions pack per row (col only orders within a row). A shared column grid let one wide region push every region below it apart.
- `variantOf` badges (5A, 5B…) are computed identically in `washi.region_labels` and `regionLabels` in app.js — keep them in sync.
- Node sizes come from canvas `measureText`, so fonts must be loaded first — `document.fonts.ready` isn't enough; the viewer calls `document.fonts.load()` per font spec. Font strings in `F` must match the CSS classes they measure for.
- Toggling Notes re-runs layout (notes change node heights).

## Viewer
- Errors in the page show up in the banner (window error handler). Headless Chrome doesn't give console output easily, so `--dump-dom` + banner text is how to debug `washi shot` blanks; Playwright from `~/Projects/VPNdashboard/node_modules` with `channel: 'chrome'` works for real interaction tests.
- In shot mode the header is `display:none`, so the body grid must be a single row; a `0 1fr` template put the canvas in the 0px row and produced a negative zoom.
- `[hidden] { display: none !important; }` is load-bearing: `#empty` has `display: grid`, which beats the `hidden` attribute, and the invisible overlay swallowed wheel/drag on the canvas.
- Clipped text is collected while painting (`clip()` → `clipLog`), shown under Checks and saved with the layout so `washi check` can print `render:` lines.
- Ghosts of removed nodes come from laying out the previous version (cached per `name:rev`) without saving positions. A ghost that overlaps a live node is dropped: drawn on top it hid the new card's text. It's still listed under "Since vN".
- Comments reach Claude through an outbox: **Send to Claude** appends to `~/.washi/outbox.jsonl` and marks the comment `sent`. `washi watch` tails that file and prints one line per comment, and Claude runs it as a background Monitor, so each send lands in the chat as a notification. A web page can't write into a Claude Code session directly. Copy (clipboard) stays as the fallback. Open comments have no Resolve button: Claude resolves them when they're addressed. Resolved comments have Reopen.
- Comment anchors: a click stores `node` + `dx/dy` relative to the card, so the pin follows the card when the layout changes. It also stores the widget under the cursor and, for lists, the row (`list` measure has an `item(ly)` hit test). Dragging in comment mode draws an area instead of panning. The area is stored relative to the card it overlaps most, along with a `covers` list ("Card › widget, widget") that's computed at creation, so the CLI and chat text don't need the layout.
- After a big restructure, saved positions from the old version can pin a node somewhere silly. Clearing `positions` in `.history/<slug>.layout.json` gives a fresh layout.

## Checker
- Errors stop rendering (viewer falls back to the last valid version with a banner); warnings are design smells only.
- Staged: structure → nodes/widgets → flows → semantics, returning early on errors so one typo doesn't cascade.
- Option regions (a region with variants, and its variants) are exempt from "nothing leads to screen" and "not in any slice" until one is picked.

## History and sidecars
- A snapshot is written only when canonical (sort_keys) JSON differs from the last version, so re-saves don't inflate the count.
- Files with a dot in the stem (`cineteca.comments.json`) are sidecars, not shapes — the scanner skips them.

## Dropdowns
- Never compare `select.innerHTML` with freshly built HTML to skip a rewrite: the browser re-serializes it (`selected=""`), so it never matches. The board list was rebuilt on every 700 ms poll, and a pick made while Chrome's native menu was open got dropped. Compare with the last string written instead (`sel.dataset.html`).
