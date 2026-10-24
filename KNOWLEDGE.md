# Knowledge

## Why a fixed language
Prompts and skills alone drift — the agent invents a slightly different notation each time. Fixing the vocabulary (4 node types, 16 widget types, unknown keys are errors) and checking every save makes versions comparable: you see whether the *flow* changed, not the diagram style.

## Why screens, not a node graph
The first version was a classic graph of places, UI/code affordances and stores. On a real feature (Cineteca, 11 places) it became a hairball even with store reads hidden. Wireframe screens in numbered regions, cut-outs + decisions for state variants, exit labels for cross-region flows, and notes/questions on the drawing read far better. Old-format shapes and histories don't render any more.

## Layout
- Each region is laid out on its own (ELK layered, RIGHT). Cross-region flows end in an exit node in the source region — that keeps edges short.
- Exit ids are `exit--<from>--<to>`: one per flow (shared exits made converging arrows and stacked labels) and stable across edits (index-based ids broke saved positions).
- Every incoming flow gets its *own* WEST port (screens: stepping down from the title bar; steps: centred); labels use ELK `HEAD` placement with a paper-coloured text halo. Shared in-ports made lines merge into a bus.
- Self-loops (a widget leading to its own screen) skip ELK and are drawn as a tight bracket on the card's right side; ELK routed them around the whole card like a second border.
- Arrowheads use `markerUnits="userSpaceOnUse"` (10px) so they don't shrink with thin strokes.
- **Stable layout**: after each live draw the viewer saves region-relative node positions to `.history/<slug>.layout.json`. When at least half of a region's nodes have a saved position, ELK runs with INTERACTIVE cycle breaking / layering / crossing minimization seeded with them; new nodes get a guessed position next to a connected neighbour. Only the live view saves, so `washi shot` (headless) draws the same picture the user sees.
- Regions pack per row (col only orders within a row). A shared column grid let one wide region push every region below it apart.
- `variantOf` badges (5A, 5B…) are computed identically in `washi.region_labels` and `regionLabels` in app.js — keep them in sync.
- Node sizes come from canvas `measureText`, so fonts must be loaded first — `document.fonts.ready` isn't enough; the viewer calls `document.fonts.load()` per font spec. Font strings in `F` must match the CSS classes they measure for.
- Toggling Notes re-runs layout (notes change node heights).

## Viewer
- Errors in the page show up in the banner (window error handler). Headless Chrome doesn't give console output easily, so `--dump-dom` + banner text is how to debug `washi shot` blanks; Playwright from `~/Projects/VPNdashboard/node_modules` with `channel: 'chrome'` works for real interaction tests.
- In shot mode the header is `display:none`, so the body grid must be a single row; a `0 1fr` template put the canvas in the 0px row and produced a negative zoom.
- `[hidden] { display: none !important; }` is load-bearing: `#empty` has `display: grid`, which beats the `hidden` attribute, and the invisible overlay swallowed wheel/drag on the canvas.
- Clipped text is collected while painting (`clip()` → `clipLog`), shown under Checks and saved with the layout so `washi check` can print `render:` lines.
- Ghosts of removed nodes come from laying out the previous version (cached per `name:rev`) without saving positions.

## Checker
- Errors stop rendering (viewer falls back to the last valid version with a banner); warnings are design smells only.
- Staged: structure → nodes/widgets → flows → semantics, returning early on errors so one typo doesn't cascade.
- Option regions (a region with variants, and its variants) are exempt from "nothing leads to screen" and "not in any slice" until one is picked.

## History and sidecars
- A snapshot is written only when canonical (sort_keys) JSON differs from the last version, so re-saves don't inflate the count.
- Files with a dot in the stem (`cineteca.comments.json`) are sidecars, not shapes — the scanner skips them.
