"""Local dev server for Reading Diary with Firebase emulator support.

Serves the app like `python -m http.server`, but when index.html is requested it adds the local
emulator origins to the page's Content-Security-Policy, so http://localhost:8790/?emu can talk to
the Auth (9099) and Firestore (8085) emulators. The published site never contains those origins.
"""
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
EMU = "http://127.0.0.1:9099 http://127.0.0.1:8085 ws://127.0.0.1:8085"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always the file on disk while developing
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            html = (ROOT / "index.html").read_text(encoding="utf-8")
            html = html.replace("connect-src 'self'", f"connect-src 'self' {EMU}", 1)
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
