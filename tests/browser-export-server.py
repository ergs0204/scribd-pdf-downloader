"""Local, opt-in full-pipeline regression runner using a normal public preview.

Raw document responses/tokens remain in memory. Nothing is uploaded or committed.
"""
import argparse
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

import requests

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_URL = "https://www.scribd.com/document/507619928/B-tree-dbms"
DOCUMENT_ID = "507619928"
PREVIEW_URL = "https://www.scribd.com/embeds/507619928/content?start_page=1&view_mode=scroll&show_recommendations=false"
SESSION = requests.Session()
CACHE = {}
LOCK = threading.Lock()
SAVE_ROOT = ROOT / "tmp" / "font-regression"


def source(url):
    with LOCK:
        if url not in CACHE:
            response = SESSION.get(url, timeout=30)
            response.raise_for_status()
            CACHE[url] = response.text
        return CACHE[url]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, data, content_type, status=200):
        if isinstance(data, str):
            data = data.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlsplit(self.path).path
        try:
            if path == "/fixture":
                preview = source(PREVIEW_URL)
                self.respond(json.dumps({"preview": preview}), "application/json")
            elif path == "/proxy":
                remote = parse_qs(urlsplit(self.path).query)["url"][0]
                parsed = urlsplit(remote)
                if parsed.hostname not in {"www.scribd.com", "html.scribdassets.com", "html.scribd.com"}:
                    raise ValueError("Unsupported regression fixture host")
                if remote == PUBLIC_URL or remote == PREVIEW_URL:
                    self.respond(source(remote), "text/html")
                else:
                    response = SESSION.get(remote, timeout=30)
                    self.respond(response.content, response.headers.get("content-type", "application/octet-stream"), response.status_code)
            else:
                file = ROOT / ("tests/browser-export.html" if path.startswith("/document/") else path.lstrip("/"))
                file = file.resolve()
                if ROOT not in file.parents or not file.is_file():
                    self.respond("Not found", "text/plain", 404)
                    return
                mime = "application/pdf" if file.suffix == ".pdf" else "text/html" if file.suffix == ".html" else "text/javascript"
                self.respond(file.read_bytes(), mime)
        except Exception as error:
            self.respond(type(error).__name__, "text/plain", 500)

    def do_POST(self):
        path = urlsplit(self.path).path
        data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        try:
            if path == "/save":
                SAVE_ROOT.mkdir(parents=True, exist_ok=True)
                name = parse_qs(urlsplit(self.path).query).get("name", ["full-export.pdf"])[0]
                name = Path(name).name
                (SAVE_ROOT / name).write_bytes(data)
                self.respond(json.dumps({"ok": True, "bytes": len(data)}), "application/json")
                print(f"Saved {name}: {len(data)} bytes", flush=True)
            elif path == "/proxy":
                remote = parse_qs(urlsplit(self.path).query)["url"][0]
                parsed = urlsplit(remote)
                if parsed.hostname != "www.scribd.com" or parsed.path not in {"/csrf_token", f"/document/{DOCUMENT_ID}/token"}:
                    raise ValueError("Unsupported token request")
                headers = {"Content-Type": "application/json"}
                for key in ("x-csrf-token", "x-requested-with"):
                    if key in self.headers:
                        headers[key] = self.headers[key]
                if parsed.path == "/csrf_token":
                    data = json.dumps({"href": PUBLIC_URL}).encode()
                response = SESSION.post(remote, data=data, headers=headers, timeout=30)
                self.respond(response.content, "application/json", response.status_code)
            else:
                self.respond("Not found", "text/plain", 404)
        except Exception as error:
            self.respond(type(error).__name__, "text/plain", 500)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--url", default=PUBLIC_URL, help="Normal public Scribd document URL to test")
    args = parser.parse_args()
    parsed_url = urlsplit(args.url)
    match = re.fullmatch(r"/(?:document|doc)/(\d+)(?:/[^?#]*)?", parsed_url.path)
    if parsed_url.scheme != "https" or parsed_url.hostname != "www.scribd.com" or not match:
        parser.error("--url must be an https://www.scribd.com/document/<id>/... URL")
    PUBLIC_URL = args.url
    DOCUMENT_ID = match[1]
    PREVIEW_URL = f"https://www.scribd.com/embeds/{DOCUMENT_ID}/content?start_page=1&view_mode=scroll&show_recommendations=false"
    if DOCUMENT_ID != "507619928":
        SAVE_ROOT = ROOT / "tmp" / f"regression-{DOCUMENT_ID}"
    print(f"Regression server: http://127.0.0.1:{args.port}{parsed_url.path}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
