# Washi — Claude context

A local shaping tool: Claude edits a shape (JSON, fixed language) describing numbered regions of low-fi wireframe screens, cut-outs, steps and decisions taped together with flows. The viewer renders it live, keeps every valid save as a version, takes comments pinned to the drawing, and exports a markdown plan (whole shape or per slice) for a build agent.

## Layout

- `washi.py` — the language: `parse` / `validate` / `to_markdown`, sidecar storage (comments, layout), CLI `check`, `md`, `comments`, `resolve`, `shot`. Single source of truth for the rules.
- `washi` — CLI wrapper (symlinked to `/opt/homebrew/bin/washi`); `washi serve` starts the viewer.
- `server.py` — stdlib HTTP server. Watches `~/Projects/*/washi/*.json` (+ extra dirs) every 0.4s, snapshots valid changes, serves `static/` and the API. Imports `washi` at start — restart it after changing `washi.py`.
- `static/` — viewer (vanilla JS, light "paper" theme). Widgets drawn as SVG by `WIDGET` in `app.js`; each region laid out separately with ELK (jsdelivr, pinned 0.9.3), regions packed per row.
- `skill/SKILL.md` — Claude Code skill: language spec + comments → save → check → look → resolve → report loop. Symlinked to `~/.claude/skills/washi`.
- `launchd/com.jacopo.washi.plist` — keeps the viewer up on :4747 (installed in `~/Library/LaunchAgents`, log `~/Library/Logs/washi.log`).

## Files next to a shape

```
<project>/washi/<slug>.json                 the shape
<project>/washi/<slug>.comments.json        viewer comments (commit these)
<project>/washi/.history/<slug>/NNNN.json   every valid version
<project>/washi/.history/<slug>.layout.json node positions + text the viewer had to cut off
```

## Run

```bash
launchctl kickstart -k gui/$(id -u)/com.jacopo.washi   # restart the viewer (after editing washi.py/server.py)
washi check ~/Projects/x/washi/*.json
washi comments ~/Projects/x/washi/<slug>.json
washi reopen ~/Projects/x/washi/<slug>.json c3            # undo a resolve
washi shot x/<slug> --region R2                         # prints PNG path
washi md <file> [--slice S1]
```

`?shot=1` hides chrome (used by `washi shot`); `#<project>/<slug>&region=R2` fits to a region.

## API

- `GET /api/state` → `{version, dirs, boards:[{name, project, title, revs, errors, warnings, comments}]}` (viewer polls every 700ms)
- `GET /api/board?name=` → `{board, stale, issues, revs}` — `stale` = file currently invalid, `board` is the last valid version
- `GET /api/rev?name=&n=` → `{ts, board}` (1-based)
- `GET /api/export?name=[&slice=S1]` → markdown plan
- `GET/POST /api/comments`, `POST /api/comments/resolve`, `POST /api/comments/reopen`, `POST /api/comments/send` (→ `~/.washi/outbox.jsonl`, tailed by `washi watch`), `GET/POST /api/layout`

## Data shape

See `skill/SKILL.md`. Real example: `~/Projects/torrent-box/washi/cineteca.json`.
