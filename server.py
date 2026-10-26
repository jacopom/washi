#!/usr/bin/env python3
"""Washi viewer for every project at once.

Watches <root>/*/washi/*.json (plus any extra dirs), snapshots every
valid change into .history/, stores viewer comments and layout next to each
shape, and serves the viewer + a small JSON API. Shapes are named
"<project>/<slug>", e.g. "my-app/onboarding"."""
import argparse
import json
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import washi

STATIC = Path(__file__).resolve().parent / "static"


class Boards:
    def __init__(self, root, extra):
        self.root, self.extra = root, extra
        self.lock = threading.Lock()
        self.entries = {}  # name -> {path, mtime, cmtime, board, issues}
        self.version = 0

    def dirs(self):
        found = sorted(self.root.glob("*/washi")) if self.root else []
        return [d for d in dict.fromkeys(found + self.extra) if d.is_dir()]

    def path(self, name):
        with self.lock:
            e = self.entries.get(name)
        return e and e["path"]

    def rev_files(self, name):
        d = washi.history_dir(self.path(name))
        return sorted(d.glob("*.json")) if d.exists() else []

    def rev(self, name, n):
        files = self.rev_files(name)
        if not 1 <= n <= len(files):
            return None
        return json.loads(files[n - 1].read_text(encoding="utf-8"))

    def snapshot(self, path, board):
        d = washi.history_dir(path)
        files = sorted(d.glob("*.json")) if d.exists() else []
        canon = json.dumps(board, sort_keys=True)
        if files and json.dumps(json.loads(files[-1].read_text(encoding="utf-8"))["board"], sort_keys=True) == canon:
            return
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{len(files) + 1:04d}.json").write_text(json.dumps({"ts": time.time(), "board": board}, indent=1), encoding="utf-8")

    def scan(self):
        seen, changed = set(), False
        for d in self.dirs():
            for path in sorted(d.glob("*.json")):
                if "." in path.stem:  # sidecars like cineteca.comments.json
                    continue
                name = f"{d.parent.name}/{path.stem}"
                seen.add(name)
                try:
                    mtime = path.stat().st_mtime_ns
                    cpath = washi.comments_path(path)
                    cmtime = cpath.stat().st_mtime_ns if cpath.exists() else 0
                    old = self.entries.get(name)
                    if old and old["mtime"] == mtime:
                        if old["cmtime"] != cmtime:
                            old["cmtime"] = cmtime
                            changed = True
                        continue
                    board, issues = washi.parse(path.read_text(encoding="utf-8"))
                except (FileNotFoundError, UnicodeDecodeError):
                    continue
                if board is not None:
                    self.snapshot(path, board)
                with self.lock:
                    self.entries[name] = {"path": path, "mtime": mtime, "cmtime": cmtime, "board": board, "issues": issues}
                changed = True
        with self.lock:
            for name in set(self.entries) - seen:
                del self.entries[name]
                changed = True
            if changed:
                self.version += 1

    def bump(self):
        with self.lock:
            self.version += 1

    def watch(self):
        while True:
            try:
                self.scan()
            except Exception as e:  # keep watching whatever happens
                print("scan error:", e, flush=True)
            time.sleep(0.4)

    def resolve_name(self, name):
        """Accept 'project/slug' or a bare slug when it's unambiguous."""
        with self.lock:
            if name in self.entries:
                return name
            hits = [n for n in self.entries if n.split("/", 1)[1] == name]
        return hits[0] if len(hits) == 1 else None

    def current(self, name):
        """Current board, falling back to the last valid revision."""
        name = self.resolve_name(name)
        with self.lock:
            e = self.entries.get(name)
        if not e:
            return None
        revs = len(self.rev_files(name))
        board, stale = e["board"], False
        if board is None and revs:
            board, stale = self.rev(name, revs)["board"], True
        return {"name": name, "board": board, "stale": stale, "issues": e["issues"], "revs": revs}

    def state(self):
        with self.lock:
            names = sorted(self.entries, key=lambda n: -self.entries[n]["mtime"])
            version = self.version
        boards = []
        for n in names:
            c = self.current(n)
            if not c:
                continue
            boards.append({
                "name": n,
                "project": n.split("/", 1)[0],
                "title": (c["board"] or {}).get("title", n),
                "revs": c["revs"],
                "errors": sum(i["level"] == "error" for i in c["issues"]),
                "warnings": sum(i["level"] == "warning" for i in c["issues"]),
                "comments": sum(x.get("status") == "open" for x in washi.load_comments(self.path(n))),
            })
        # open tabs reload themselves when the viewer's own files change
        viewer = max(int(f.stat().st_mtime) for f in STATIC.iterdir() if f.is_file())
        return {"version": version, "viewer": viewer, "listening": washi.listening(), "dirs": [str(d) for d in self.dirs()], "boards": boards}


def make_handler(boards):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(STATIC), **kw)

        def log_message(self, *a):
            pass

        def end_headers(self):
            if not self.path.startswith("/api/"):
                self.send_header("Cache-Control", "no-cache")  # always pick up viewer edits
            super().end_headers()

        def send(self, code, body, ctype="application/json"):
            data = body.encode("utf-8") if isinstance(body, str) else json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", f"{ctype}; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        # The server only listens on 127.0.0.1, but any page open in the browser can still reach it.
        # Writes end up in Claude's chat via `washi watch`, so: only localhost Host names (no DNS
        # rebinding), no foreign Origin, and JSON bodies only (a cross-site form or no-cors fetch
        # can't set that content type without a preflight, which this server never approves).
        def local(self, write=False):
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
            origin = self.headers.get("Origin")
            ok = host in ("localhost", "127.0.0.1", "[::1]") and (
                not origin or urlparse(origin).hostname in ("localhost", "127.0.0.1", "::1"))
            if ok and write:
                ok = (self.headers.get("Content-Type") or "").split(";")[0].strip() == "application/json"
            if not ok:
                self.send(403, {"error": "local requests only"})
            return ok

        def do_GET(self):
            if not self.local():
                return
            u = urlparse(self.path)
            q = parse_qs(u.query)
            if u.path == "/api/state":
                return self.send(200, boards.state())
            if not u.path.startswith("/api/"):
                return super().do_GET()
            cur = boards.current(q.get("name", [""])[0])
            if cur is None:
                return self.send(404, {"error": "no such shape"})
            name, path = cur["name"], boards.path(cur["name"])
            if u.path == "/api/board":
                return self.send(200, cur)
            if u.path == "/api/rev":
                try:
                    r = boards.rev(name, int(q.get("n", ["0"])[0]))
                except ValueError:
                    r = None
                return self.send(200, r) if r else self.send(404, {"error": "no such revision"})
            if u.path == "/api/export":
                if cur["board"] is None:
                    return self.send(409, {"error": "shape has no valid version yet"})
                return self.send(200, washi.to_markdown(cur["board"], q.get("slice", [None])[0]), "text/markdown")
            if u.path == "/api/comments":
                return self.send(200, washi.load_comments(path))
            if u.path == "/api/layout":
                return self.send(200, washi.load_layout(path))
            return self.send(404, {"error": "unknown endpoint"})

        def do_POST(self):
            if not self.local(write=True):
                return
            u = urlparse(self.path)
            try:
                n = int(self.headers.get("Content-Length", 0))
                if n > 2_000_000:  # layouts of big shapes are ~100 KB
                    return self.send(413, {"error": "too large"})
                body = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                return self.send(400, {"error": "bad JSON"})
            cur = boards.current(body.get("name", ""))
            if cur is None:
                return self.send(404, {"error": "no such shape"})
            path = boards.path(cur["name"])
            if u.path == "/api/comments":
                text = str(body.get("text", "")).strip()
                if not text:
                    return self.send(400, {"error": "empty comment"})
                anchor = {k: body.get(k) for k in washi.ANCHOR_KEYS}
                c = washi.add_comment(path, text, body.get("node"), body.get("x"), body.get("y"), cur["revs"], **anchor)
                if body.get("send"):
                    washi.send_comments(path, cur["name"], [{"id": c["id"], "where": body.get("where")}])
                boards.bump()
                return self.send(200, c)
            if u.path == "/api/comments/reply":
                text = str(body.get("text", "")).strip()
                if not text:
                    return self.send(400, {"error": "empty reply"})
                cid = str(body.get("id", ""))
                ok = washi.reply_comment(path, cid, text, "you")
                if ok and body.get("send"):
                    washi.send_reply(path, cur["name"], cid, text, body.get("where"))
                boards.bump()
                return self.send(200 if ok else 404, {"ok": bool(ok)})
            if u.path == "/api/comments/resolve":
                ok = washi.resolve_comment(path, str(body.get("id", "")), body.get("reply"), cur["revs"])
                boards.bump()
                return self.send(200 if ok else 404, {"ok": ok})
            if u.path == "/api/comments/send":
                n = washi.send_comments(path, cur["name"], body.get("items") or [])
                boards.bump()
                return self.send(200, {"sent": n})
            if u.path == "/api/relayout":
                if not body.get("done"):
                    washi.relayout(path, body.get("region"))
                boards.bump()
                return self.send(200, {"ok": True})
            if u.path == "/api/comments/delete":
                ok = washi.delete_comment(path, str(body.get("id", "")))
                boards.bump()
                return self.send(200 if ok else 404, {"ok": ok})
            if u.path == "/api/comments/reopen":
                ok = washi.reopen_comment(path, str(body.get("id", "")))
                boards.bump()
                return self.send(200 if ok else 404, {"ok": ok})
            if u.path == "/api/layout":
                washi.save_layout(path, body.get("positions") or {}, body.get("clipped") or [], body.get("rev"))
                return self.send(200, {"ok": True})
            return self.send(404, {"error": "unknown endpoint"})

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("dirs", nargs="*", help="extra shape directories to watch")
    ap.add_argument("--root", default="~/Projects", help="watch <root>/*/washi (default ~/Projects; '' to disable)")
    ap.add_argument("--port", type=int, default=4747)
    args = ap.parse_args()

    root = Path(args.root).expanduser().resolve() if args.root else None
    extra = [Path(d).expanduser().resolve() for d in args.dirs]
    for d in extra:
        d.mkdir(parents=True, exist_ok=True)
    boards = Boards(root, extra)
    boards.scan()
    threading.Thread(target=boards.watch, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(boards))
    print(f"washi: watching {root}/*/washi" + "".join(f", {d}" for d in extra), f"\n            http://localhost:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
