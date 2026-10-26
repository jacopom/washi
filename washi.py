#!/usr/bin/env python3
"""Shape language: parse, validate, export, comments, screenshot.

  washi check FILE...                 validate shapes (+ render warnings from the viewer), exit 1 on errors
  washi md FILE [--slice S1]           print the shape (or one slice of it) as a markdown plan
  washi comments FILE [--all]          list open comments left in the viewer (--all: resolved too)
  washi reply FILE ID TEXT...          answer a comment in its thread (the viewer shows it as Claude's)
  washi resolve FILE ID [REPLY...]     mark a comment resolved, optionally with a reply
  washi reopen FILE ID                 put a resolved comment back on the agenda
  washi delete FILE ID                 remove a comment and its thread
  washi watch                          print comments as they're sent from the viewer (one line each)
  washi relayout FILE [--region R1]    forget saved node positions (after a big restructure)
  washi shot NAME [--region R2] [--out PNG] [--port 4747]
                                       screenshot the live viewer to check the redraw
                                       (NAME is project/slug, or just slug when unambiguous)
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

SLUG = re.compile(r"^[a-z][a-z0-9-]*$")
REGION_ID = re.compile(r"^R\d+$")
SLICE_ID = re.compile(r"^S\d+$")

TOP_KEYS = {"title", "option", "prose", "slices", "regions", "nodes", "flows"}
SLICE_KEYS = {"id", "title", "note"}
REGION_KEYS = {"id", "title", "col", "row", "note", "prose", "variantOf"}
NODE_KEYS = {
    "screen": {"id", "type", "region", "slice", "caption", "title", "w", "widgets", "note", "question", "prose"},
    "cutout": {"id", "type", "region", "slice", "caption", "w", "widgets", "note", "question", "prose"},
    "step": {"id", "type", "region", "slice", "text", "note", "question", "prose"},
    "decision": {"id", "type", "region", "slice", "text", "note", "question", "prose"},
}
NODE_REQUIRED = {"screen": ["title", "widgets"], "cutout": ["caption", "widgets"], "step": ["text"], "decision": ["text"]}
# widget type -> (allowed fields, required fields)
WIDGETS = {
    "heading": ({"text"}, ["text"]),
    "text": ({"text"}, ["text"]),
    "field": ({"text", "label"}, []),
    "button": ({"text", "primary"}, ["text"]),
    "image": ({"text"}, []),
    "list": ({"items", "label"}, ["items"]),
    "tiles": ({"items", "label"}, ["items"]),
    "columns": ({"columns"}, ["columns"]),
    "post": ({"who", "when", "text", "image"}, ["who", "text"]),
    "slot": ({"text"}, ["text"]),
    "tabs": ({"items", "active"}, ["items"]),
    "select": ({"label", "value"}, ["label"]),
    "toggle": ({"label", "on"}, ["label"]),
    "progress": ({"label", "value"}, ["label"]),
    "divider": (set(), []),
}
FLOW_KEYS = {"from", "to", "label"}


def parse(text):
    """Return (shape, issues). shape is None when it can't be rendered."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        return None, [_issue("error", f"invalid JSON: {e.msg} (line {e.lineno}, col {e.colno})")]
    issues = validate(data)
    return (None if has_errors(issues) else data), issues


def has_errors(issues):
    return any(i["level"] == "error" for i in issues)


def _issue(level, msg, id=None):
    return {"level": level, "msg": msg, "id": id}


def _strs(v):
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def validate(s):
    out = []
    err = lambda m, id=None: out.append(_issue("error", m, id))
    warn = lambda m, id=None: out.append(_issue("warning", m, id))
    keys = lambda obj, allowed, where, id=None: [
        err(f"{where}: unknown key '{k}' (allowed: {', '.join(sorted(allowed))})", id) for k in set(obj) - allowed
    ]

    if not isinstance(s, dict):
        err("top level must be an object")
        return out
    for k in set(s) - TOP_KEYS:
        warn(f"unknown top-level key '{k}'")
    if not isinstance(s.get("title"), str) or not s["title"].strip():
        err("missing 'title'")
    for k in ("option", "prose"):
        if k in s and not isinstance(s[k], str):
            err(f"'{k}' must be a string")

    regions, nodes, flows, slices = s.get("regions", []), s.get("nodes", []), s.get("flows", []), s.get("slices", [])
    for name, v in (("regions", regions), ("nodes", nodes), ("flows", flows), ("slices", slices)):
        if not isinstance(v, list):
            err(f"'{name}' must be a list")
    if has_errors(out):
        return out

    slice_ids = set()
    for sl in slices:
        if not isinstance(sl, dict) or not isinstance(sl.get("id"), str) or not SLICE_ID.match(sl["id"]):
            err(f"slice id {sl.get('id') if isinstance(sl, dict) else sl!r} must look like S1")
            continue
        if sl["id"] in slice_ids:
            err(f"duplicate slice {sl['id']}")
        slice_ids.add(sl["id"])
        keys(sl, SLICE_KEYS, sl["id"])
        if not isinstance(sl.get("title"), str) or not sl["title"].strip():
            err(f"{sl['id']} needs a title")

    region_ids = set()
    for r in regions:
        if not isinstance(r, dict) or not isinstance(r.get("id"), str) or not REGION_ID.match(r["id"]):
            err(f"region id {r.get('id') if isinstance(r, dict) else r!r} must look like R1")
            continue
        rid = r["id"]
        if rid in region_ids:
            err(f"duplicate region {rid}", rid)
        region_ids.add(rid)
        keys(r, REGION_KEYS, rid, rid)
        if not isinstance(r.get("title"), str) or not r["title"].strip():
            err(f"{rid} needs a title", rid)
        for k in ("note", "prose"):
            if k in r and not isinstance(r[k], str):
                err(f"{rid}: '{k}' must be a string", rid)
        for k in ("col", "row"):
            if k in r and (not isinstance(r[k], int) or r[k] < 0):
                err(f"{rid}: {k} must be an integer ≥ 0", rid)
        if "variantOf" in r:
            base = next((b for b in regions if isinstance(b, dict) and b.get("id") == r["variantOf"]), None)
            if base is None or base.get("variantOf") or regions.index(base) > regions.index(r):
                err(f"{rid}: variantOf must name an earlier region that isn't itself a variant", rid)

    by_id = {}
    for n in nodes:
        if not isinstance(n, dict) or not isinstance(n.get("id"), str) or not SLUG.match(n["id"]):
            err(f"node id {n.get('id') if isinstance(n, dict) else n!r} must be a lowercase slug like 'film-page'")
            continue
        nid, t = n["id"], n.get("type")
        if nid in by_id:
            err(f"duplicate node id '{nid}'", nid)
            continue
        by_id[nid] = n
        if t not in NODE_KEYS:
            err(f"{nid}: type must be one of {', '.join(sorted(NODE_KEYS))}", nid)
            continue
        keys(n, NODE_KEYS[t], nid, nid)
        if n.get("region") not in region_ids:
            err(f"{nid}: region {n.get('region')!r} doesn't exist", nid)
        if "slice" in n and n["slice"] not in slice_ids:
            err(f"{nid}: slice {n['slice']!r} isn't in 'slices'", nid)
        for k in NODE_REQUIRED[t]:
            if k not in n:
                err(f"{nid}: {t} needs '{k}'", nid)
        for k in ("caption", "title", "text", "note", "question", "prose"):
            if k in n and not isinstance(n[k], str):
                err(f"{nid}: '{k}' must be a string", nid)
        if "w" in n and (not isinstance(n["w"], int) or not 160 <= n["w"] <= 520):
            err(f"{nid}: w must be an integer between 160 and 520", nid)
        if "widgets" in n:
            _widgets(n, err)
    if has_errors(out):
        return out

    def widget_ids(n):
        return {w.get("id") for w in n.get("widgets", []) if w.get("id")}

    seen, outgoing, incoming = set(), {}, set()
    for f in flows:
        if not isinstance(f, dict):
            err("each flow must be an object")
            continue
        keys(f, FLOW_KEYS, f"flow {f.get('from')}→{f.get('to')}")
        src, dst = f.get("from"), f.get("to")
        if not isinstance(src, str) or not isinstance(dst, str):
            err(f"flow needs string 'from' and 'to': {f}")
            continue
        node, _, widget = src.partition(".")
        if node not in by_id:
            err(f"flow from unknown node '{node}'", node)
            continue
        if widget and widget not in widget_ids(by_id[node]):
            err(f"flow from '{src}': {node} has no widget with id '{widget}'", node)
            continue
        if dst not in by_id:
            err(f"flow from '{src}' to unknown node '{dst}' (flows point at nodes, not widgets)", node)
            continue
        if dst == node and not widget:
            err(f"{node} flows to itself", node)
        if "label" in f and not isinstance(f["label"], str):
            err(f"flow {src}→{dst}: label must be a string", node)
        if (src, dst) in seen:
            warn(f"duplicate flow {src} → {dst}", node)
        seen.add((src, dst))
        outgoing.setdefault(node, []).append(f)
        incoming.add(dst)
    if has_errors(out):
        return out

    for nid, n in by_id.items():
        t = n["type"]
        outs = outgoing.get(nid, [])
        if t == "decision":
            if len(outs) < 2:
                warn(f"decision '{nid}' needs at least two answers", nid)
            if any(not f.get("label") for f in outs):
                warn(f"decision '{nid}': label every answer", nid)
        if t in ("step", "decision", "cutout") and nid not in incoming:
            warn(f"{t} '{nid}' is never reached", nid)
        if t in ("screen", "cutout"):
            sources = {f["from"].partition(".")[2] for f in outs}
            for w in n.get("widgets", []):
                if w.get("type") == "button" and w.get("id") not in sources:
                    warn(f"{nid}: button '{w['text']}' goes nowhere — give it an id and a flow", nid)
    used = {n.get("region") for n in by_id.values()}
    for rid in region_ids - used:
        warn(f"{rid} is empty", rid)

    # alternatives (a region with variants, and the variants) aren't part of the plan until one is picked
    optional = {r["id"] for r in regions if r.get("variantOf")} | {r["variantOf"] for r in regions if r.get("variantOf")}
    order = {r["id"]: i for i, r in enumerate(regions)}
    screens = sorted((n for n in by_id.values() if n["type"] == "screen"), key=lambda n: order[n["region"]])
    entry = screens[0]["id"] if screens else None
    for n in screens:
        if n["id"] != entry and n["id"] not in incoming and n["region"] not in optional:
            warn(f"nothing leads to screen '{n['id']}'", n["id"])
    if slices:
        loose = [nid for nid, n in by_id.items() if "slice" not in n and n["region"] not in optional]
        if loose:
            warn(f"{len(loose)} node{'s' * (len(loose) != 1)} not in any slice: {', '.join(loose)}", loose[0])
        for sl in slice_ids - {n.get("slice") for n in by_id.values()}:
            warn(f"slice {sl} has no nodes")
    return out


def _widgets(n, err):
    nid, ids = n["id"], set()
    if not isinstance(n["widgets"], list):
        return err(f"{nid}: widgets must be a list", nid)
    for i, w in enumerate(n["widgets"]):
        where = f"{nid} widget {i + 1}"
        if not isinstance(w, dict) or w.get("type") not in WIDGETS:
            err(f"{where}: type must be one of {', '.join(WIDGETS)}", nid)
            continue
        allowed, required = WIDGETS[w["type"]]
        for k in set(w) - allowed - {"id", "type"}:
            err(f"{where} ({w['type']}): unknown key '{k}' (allowed: {', '.join(sorted(allowed | {'id'}))})", nid)
        for k in required:
            if k not in w:
                err(f"{where} ({w['type']}): needs '{k}'", nid)
        if "id" in w:
            if not isinstance(w["id"], str) or not SLUG.match(w["id"]):
                err(f"{where}: widget id must be a lowercase slug", nid)
            elif w["id"] in ids:
                err(f"{where}: duplicate widget id '{w['id']}'", nid)
            ids.add(w.get("id"))
        for k in ("text", "label", "who", "when", "value") if w["type"] != "progress" else ("label",):
            if k in w and not isinstance(w[k], str):
                err(f"{where}: '{k}' must be a string", nid)
        if "items" in w and not _strs(w["items"]):
            err(f"{where}: items must be a list of strings", nid)
        if "columns" in w and not (
            isinstance(w["columns"], list)
            and all(isinstance(c, dict) and isinstance(c.get("title"), str) and _strs(c.get("items", [])) for c in w["columns"])
        ):
            err(f"{where}: columns must be a list of {{title, items}}", nid)
        if w["type"] == "progress" and "value" in w and not (isinstance(w["value"], (int, float)) and 0 <= w["value"] <= 1):
            err(f"{where}: progress value must be a number from 0 to 1", nid)
        if "active" in w and not isinstance(w["active"], int):
            err(f"{where}: active must be an index", nid)
        for k in ("primary", "on", "image"):
            if k in w and not isinstance(w[k], bool):
                err(f"{where}: '{k}' must be true or false", nid)


def _widget_md(w):
    t = w["type"]
    if t == "divider":
        return "—"
    if t == "columns":
        return "columns: " + "; ".join(f"{c['title']} ({', '.join(c.get('items', []))})" for c in w["columns"])
    if t in ("list", "tiles", "tabs"):
        label = f"{w['label']}: " if w.get("label") else ""
        return f"{t} {label}{', '.join(w['items'])}"
    if t == "post":
        return f"post by {w['who']}{' · ' + w['when'] if w.get('when') else ''}: {w['text']}"
    if t in ("select", "toggle", "progress"):
        return f"{t} {w['label']}" + (f" = {w['value']}" if isinstance(w.get("value"), str) else "")
    return f"{t} \"{w.get('text', '')}\"" + (" (primary)" if w.get("primary") else "")


def region_labels(regions):
    """R-id -> badge label: 1, 2, … and 5A, 5B, … for a region and its variants."""
    labels, n = {}, 0
    for r in regions:
        if not r.get("variantOf"):
            n += 1
            labels[r["id"]] = str(n)
    for r in regions:
        if r.get("variantOf"):
            base = r["variantOf"]
            k = sum(1 for x in regions[: regions.index(r) + 1] if x.get("variantOf") == base)
            labels[base] = labels[base].rstrip("A") + "A"
            labels[r["id"]] = labels[base][:-1] + chr(ord("A") + k)
    return labels


def to_markdown(s, only_slice=None):
    regions = s.get("regions", [])
    flows = s.get("flows", [])
    slices = {sl["id"]: sl for sl in s.get("slices", [])}
    by_id = {n["id"]: n for n in s.get("nodes", [])}
    nodes = [n for n in s.get("nodes", []) if not only_slice or n.get("slice") == only_slice]
    rnum = region_labels(regions)
    name = lambda n: n.get("caption") or n.get("title") or n.get("text")

    def ref(nid):
        n = by_id[nid]
        later = f" _(slice {n['slice']})_" if only_slice and n.get("slice") != only_slice and n.get("slice") else ""
        return f"{name(n)} ({rnum[n['region']]}){later}"

    arrow = lambda f: f"→ {ref(f['to'])}" + (f" [{f['label']}]" if f.get("label") else "")

    head = f"# {s['title']}" + (f" · {s['option']}" if s.get("option") else "")
    if only_slice:
        head += f" — slice {only_slice}: {slices[only_slice]['title']}" if only_slice in slices else f" — slice {only_slice}"
    lines = [head, ""]
    if only_slice and slices.get(only_slice, {}).get("note"):
        lines += [slices[only_slice]["note"], ""]
    if s.get("prose") and not only_slice:
        lines += [s["prose"].strip(), ""]
    if slices and not only_slice:
        lines += ["## Slices", ""]
        for sid, sl in slices.items():
            members = [name(n) for n in nodes if n.get("slice") == sid]
            lines.append(f"- **{sid} · {sl['title']}**" + (f" — {sl['note']}" if sl.get("note") else "") + (f": {', '.join(members)}" if members else ""))
        lines.append("")
    questions = []
    for r in regions:
        members = [n for n in nodes if n["region"] == r["id"]]
        if only_slice and not members:
            continue
        lines += [f"## {rnum[r['id']]}. {r['title']}", ""]
        if r.get("note"):
            lines += [r["note"], ""]
        if r.get("prose"):
            lines += [r["prose"].strip(), ""]
        for n in members:
            label = {"screen": "Screen", "cutout": "Cut-out", "step": "Step", "decision": "Decision"}[n["type"]]
            head = f"### {label}: {name(n)}"
            if n["type"] == "screen" and n.get("caption"):
                head += f" — \"{n['title']}\""
            if n.get("slice") and not only_slice:
                head += f" · {n['slice']}"
            lines += [head, ""]
            if n.get("prose"):
                lines += [n["prose"].strip(), ""]
            for w in n.get("widgets", []):
                outs = [arrow(f) for f in flows if w.get("id") and f["from"] == f"{n['id']}.{w['id']}"]
                lines.append(f"- {_widget_md(w)}" + (f" {' '.join(outs)}" if outs else ""))
            for f in flows:
                if f["from"] == n["id"]:
                    lines.append(f"- {arrow(f)}")
            if n.get("note"):
                lines.append(f"- _Note:_ {n['note']}")
            if n.get("question"):
                lines.append(f"- **Open question:** {n['question']}")
                questions.append(f"- {name(n)} ({rnum[r['id']]}): {n['question']}")
            lines.append("")
    if questions:
        lines += ["## Open questions", ""] + questions + [""]
    return "\n".join(lines)


# ── files next to a shape ─────────────────────────────────
# <dir>/<slug>.json             the shape
# <dir>/<slug>.comments.json    comments left in the viewer (worth committing)
# <dir>/.history/<slug>/NNNN.json, <dir>/.history/<slug>.layout.json

def history_dir(path):
    path = Path(path)
    return path.parent / ".history" / path.stem


def comments_path(path):
    path = Path(path)
    return path.with_name(f"{path.stem}.comments.json")


def layout_path(path):
    path = Path(path)
    return path.parent / ".history" / f"{path.stem}.layout.json"


def _read_json(p, default):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return default


def _write_json(p, data):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)


def load_comments(path):
    return _read_json(comments_path(path), [])


# where exactly a comment points: a spot on a card (dx/dy, the widget and list row under it),
# or a dragged area (rect, relative to the card it overlaps most, plus what it covers)
ANCHOR_KEYS = ("dx", "dy", "widget", "item", "rect", "covers")


def add_comment(path, text, node=None, x=None, y=None, version=None, **anchor):
    cs = load_comments(path)
    n = max([int(c["id"][1:]) for c in cs if str(c.get("id", "")).startswith("c")] + [0]) + 1
    c = {"id": f"c{n}", "text": text, "node": node, "x": x, "y": y, "version": version, "ts": time.time(), "status": "open"}
    c.update({k: anchor[k] for k in ANCHOR_KEYS if anchor.get(k) is not None})
    _write_json(comments_path(path), cs + [c])
    return c


# a comment is a thread: the first message is c["text"], then c["thread"] = [{by: you|claude, text, ts}]
def reply_comment(path, cid, text, by="claude"):
    cs = load_comments(path)
    for c in cs:
        if c["id"] == cid:
            c.setdefault("thread", []).append({"by": by, "text": text, "ts": time.time()})
            _write_json(comments_path(path), cs)
            return c
    return None


def resolve_comment(path, cid, reply=None, version=None):
    cs = load_comments(path)
    for c in cs:
        if c["id"] == cid:
            if reply:
                c.setdefault("thread", []).append({"by": "claude", "text": reply, "ts": time.time()})
            c.update(status="resolved", resolvedIn=version)
            _write_json(comments_path(path), cs)
            return True
    return False


def comment_where(c):
    if c.get("rect"):
        return "area over " + " + ".join(c["covers"]) if c.get("covers") else "an area of the canvas"
    if c.get("node"):
        return "on " + " › ".join(str(x) for x in (c["node"], c.get("widget"), c.get("item")) if x)
    return f"at ({round(c.get('x') or 0)}, {round(c.get('y') or 0)})"


# "Send to Claude" in the viewer appends here; `washi watch` (run by Claude as a background monitor) tails it
# and touches LISTENING, so the viewer can tell "Claude is working on it" from "nobody is listening"
OUTBOX = Path.home() / ".washi" / "outbox.jsonl"
LISTENING = Path.home() / ".washi" / "listening"


def listening():
    try:
        return time.time() - LISTENING.stat().st_mtime < 5
    except FileNotFoundError:
        return False


def _private_dir():
    # only this user may read or append what reaches Claude
    OUTBOX.parent.mkdir(mode=0o700, exist_ok=True)
    OUTBOX.parent.chmod(0o700)
    OUTBOX.touch(mode=0o600)
    OUTBOX.chmod(0o600)


def _outbox(entries):
    _private_dir()
    with OUTBOX.open("a", encoding="utf-8") as f:
        f.writelines(json.dumps(x, ensure_ascii=False) + "\n" for x in entries)


def send_comments(path, name, items):
    cs = load_comments(path)
    by_id = {c["id"]: c for c in cs}
    sent = []
    for it in items:
        c = by_id.get(str(it.get("id", "")))
        if c and c.get("status") == "open":
            c["sent"] = time.time()
            sent.append({"shape": name, "file": str(path), "id": c["id"], "where": it.get("where") or comment_where(c), "text": c["text"]})
    if sent:
        _write_json(comments_path(path), cs)
        _outbox(sent)
    return len(sent)


def send_reply(path, name, cid, text, where=None):
    """The user answered in a thread with "Send to Claude" on."""
    cs = load_comments(path)
    c = next((c for c in cs if c["id"] == cid), None)
    if not c:
        return False
    c["sent"] = time.time()
    _write_json(comments_path(path), cs)
    _outbox([{"shape": name, "file": str(path), "id": cid, "where": where or comment_where(c), "text": text, "re": c["text"]}])
    return True


def watch():
    _private_dir()
    with OUTBOX.open(encoding="utf-8") as f:
        f.seek(0, 2)
        while True:
            line = f.readline()
            if not line:
                LISTENING.touch()
                time.sleep(0.5)
                continue
            try:
                x = json.loads(line)
            except ValueError:
                continue
            text = " ".join(x["text"].split())
            re = f" (reply in the thread that began \"{' '.join(x['re'].split())[:80]}\")" if x.get("re") else ""
            print(f"{x['shape']} {x['id']} {x['where']}{re}: {text}  [{x['file']}]", flush=True)


def delete_comment(path, cid):
    cs = load_comments(path)
    rest = [c for c in cs if c["id"] != cid]
    if len(rest) == len(cs):
        return False
    _write_json(comments_path(path), rest)
    return True


def reopen_comment(path, cid):
    cs = load_comments(path)
    for c in cs:
        if c["id"] == cid:
            c.update(status="open", resolvedIn=None)
            c.pop("sent", None)
            _write_json(comments_path(path), cs)
            return True
    return False


def load_layout(path):
    return _read_json(layout_path(path), {"positions": {}, "clipped": []})


def save_layout(path, positions, clipped, version):
    _write_json(layout_path(path), {"positions": positions, "clipped": clipped, "version": version})


def relayout(path, region=None):
    """Drop saved positions (all, or one region's nodes and their exits) so the next draw starts fresh."""
    lay = load_layout(path)
    pos = lay.get("positions", {})
    if region:
        shape, _ = parse(Path(path).read_text(encoding="utf-8"))
        ids = {n["id"] for n in (shape or {}).get("nodes", []) if n.get("region") == region}
        owner = lambda k: k.split("--")[1].split(".")[0] if "--" in k else k  # exit--<from>--<to>, back--<from>--<to>
        keep = {k: v for k, v in pos.items() if owner(k) not in ids}
    else:
        keep = {}
    dropped = len(pos) - len(keep)
    save_layout(path, keep, lay.get("clipped", []), lay.get("version"))
    return dropped


def shot(args):
    name, region, out, port = args[0], None, None, 4747
    rest = args[1:]
    while rest:
        flag, val, rest = rest[0], rest[1], rest[2:]
        if flag == "--region":
            region = val
        elif flag == "--out":
            out = val
        elif flag == "--port":
            port = int(val)
    out = Path(out or Path(tempfile.gettempdir()) / f"washi-{name.replace('/', '-')}{'-' + region if region else ''}.png").resolve()
    chrome = next((c for c in (
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        shutil.which("google-chrome"), shutil.which("chromium"),
    ) if c and Path(c).exists()), None)
    if not chrome:
        print("no Chrome/Chromium found", file=sys.stderr)
        return 1
    url = f"http://localhost:{port}/?shot=1#{name}" + (f"&region={region}" if region else "")
    subprocess.run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1800,1100",
                    "--virtual-time-budget=8000", f"--screenshot={out}", url], capture_output=True, timeout=90)
    if not out.exists():
        print("screenshot failed — is the viewer running?", file=sys.stderr)
        return 1
    print(out)
    return 0


def main(argv):
    if argv[:1] == ["watch"]:
        return watch()
    if argv[:1] == ["relayout"] and len(argv) > 1:
        region = argv[argv.index("--region") + 1] if "--region" in argv else None
        print(f"forgot {relayout(argv[1], region)} positions" + (f" in {region}" if region else ""))
        try:  # tell a running viewer to redraw
            name = Path(argv[1]).resolve().parent.parent.name + "/" + Path(argv[1]).stem
            req = urllib.request.Request("http://localhost:4747/api/relayout", json.dumps({"name": name, "done": True}).encode(), {"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=2)
        except OSError:
            pass
        return 0
    if not argv or argv[0] not in ("check", "md", "shot", "comments", "reply", "resolve", "reopen", "delete") or len(argv) < 2:
        print(__doc__.strip())
        return 2
    cmd, args = argv[0], argv[1:]
    if cmd == "shot":
        return shot(args)
    if cmd == "comments":
        cs = [c for c in load_comments(args[0]) if "--all" in args or c.get("status") == "open"]
        for c in cs:
            where = comment_where(c)
            print(f"{c['id']} [{c['status']}] v{c.get('version')} {where}: {c['text']}" + (f"\n    reply: {c['reply']}" if c.get("reply") else "")
                  + "".join(f"\n    {m['by']}: {m['text']}" for m in c.get("thread", [])))
        if not cs:
            print("no open comments")
        return 0
    if cmd == "reply":
        ok = len(args) > 2 and reply_comment(args[0], args[1], " ".join(args[2:]))
        print("replied" if ok else f"no comment {args[1]}" if len(args) > 2 else "usage: washi reply FILE ID TEXT...")
        return 0 if ok else 1
    if cmd == "resolve":
        ok = resolve_comment(args[0], args[1], " ".join(args[2:]) or None, len(list(history_dir(args[0]).glob("*.json"))))
        print("resolved" if ok else f"no comment {args[1]}")
        return 0 if ok else 1
    if cmd == "delete":
        ok = delete_comment(args[0], args[1])
        print("deleted" if ok else f"no comment {args[1]}")
        return 0 if ok else 1
    if cmd == "reopen":
        ok = reopen_comment(args[0], args[1])
        print("reopened" if ok else f"no comment {args[1]}")
        return 0 if ok else 1
    if cmd == "md":
        shape, issues = parse(Path(args[0]).read_text(encoding="utf-8"))
        if shape is None:
            for i in issues:
                print(f"{i['level']}: {i['msg']}", file=sys.stderr)
            return 1
        sl = args[args.index("--slice") + 1] if "--slice" in args else None
        sys.stdout.write(to_markdown(shape, sl))
        return 0
    failed = False
    for f in args:
        shape, issues = parse(Path(f).read_text(encoding="utf-8"))
        failed |= shape is None
        print(f"{f}: {'ok' if shape is not None else 'INVALID'}" + (f" ({len(issues)} issue{'s' * (len(issues) != 1)})" if issues else ""))
        for i in issues:
            print(f"  {i['level']}: {i['msg']}")
        lay = load_layout(f)
        for c in lay.get("clipped", []):
            print(f"  render: {c['node']}: \"{c['text']}\" is cut off in the drawing (as of v{lay.get('version')})")
        n_open = sum(c.get("status") == "open" for c in load_comments(f))
        if n_open:
            print(f"  {n_open} open comment{'s' * (n_open != 1)} — run: washi comments {f}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
