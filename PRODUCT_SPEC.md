# Product spec

## Vision
Move up an altitude before code. When a coding agent's first build misses, iterate on the *shape* — screens, cut-outs, steps, decisions and the flows between them — with Claude Code, watching it update live, then hand the final plan to a build agent.

## User
Me, shaping side projects with Claude Code on the left and the viewer on the right.

## In scope
- Fixed JSON shape language + checker (`washi.py`)
- Live viewer: numbered regions of wireframe screens, cut-outs, steps, decisions, exits, notes + open questions; hover/select to trace flows
- Version history, replay, diff vs previous version (added / changed / removed ghosts), layout that stays put between versions
- Comments pinned to the drawing, read and resolved by Claude
- Options (`variantOf`) for alternative takes on one stage
- Slices: build increments, filterable in the viewer, exported one at a time
- Markdown export as the build plan
- One viewer for all projects, always on (LaunchAgent)
- Claude Code skill that teaches the language and the loop

## Out of scope (for now)
- Editing the drawing directly in the viewer — Claude is the only author; the user comments
- Visual design beyond low-fi wireframes (no colors, spacing, polish)
- Multi-user, hosting, auth

## Maybe later
- Export the replay as GIF/MP4
- Requirements list with cross-links to the nodes that satisfy them
