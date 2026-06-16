"""
Lore Course Player — local video library server.

Usage:
    python3 _player/serve.py                           # root = current directory, port 8777
    python3 _player/serve.py --root "/path/to/courses" --port 8777
    python3 _player/serve.py --no-browser              # do not open browser

Requirements: Python 3.8+ (stdlib only)
"""

import argparse
import json
import os
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

# Add _player/ to path so scanner and progress can be imported
PLAYER_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PLAYER_DIR)

import scanner as _scanner
import progress as _progress

# ---------------------------------------------------------------------------
# MIME types
# ---------------------------------------------------------------------------
MIME = {
    'mp4':  'video/mp4',
    'ts':   'video/mp2t',
    'mov':  'video/quicktime',
    'mkv':  'video/x-matroska',
    'webm': 'video/webm',
    'avi':  'video/x-msvideo',
    'm4v':  'video/mp4',
    'mp3':  'audio/mpeg',
    'm4a':  'audio/mp4',
    'aac':  'audio/aac',
    'wav':  'audio/wav',
    'ogg':  'audio/ogg',
    'pdf':  'application/pdf',
    'html': 'text/html; charset=utf-8',
    'htm':  'text/html; charset=utf-8',
    'txt':  'text/plain; charset=utf-8',
    'md':   'text/markdown; charset=utf-8',
    'js':   'application/javascript',
    'css':  'text/css',
    'json': 'application/json',
    'png':  'image/png',
    'jpg':  'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif':  'image/gif',
    'svg':  'image/svg+xml',
    'ico':  'image/x-icon',
}

CHUNK_SIZE = 65536  # 64KB


def get_mime(path: str) -> str:
    ext = os.path.splitext(path)[1].lstrip('.').lower()
    return MIME.get(ext, 'application/octet-stream')


# ---------------------------------------------------------------------------
# Request handler
# ---------------------------------------------------------------------------
class LibraryHandler(BaseHTTPRequestHandler):
    ROOT: str = ''
    STATIC_DIR: str = ''

    def log_message(self, fmt, *args):
        pass  # silence default request logs


    def log_request_custom(self, code, path):
        print(f'[{code}] {path}')

    # ------------------------------------------------------------------
    # Routing
    # ------------------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path   = parsed.path
        qs     = parse_qs(parsed.query)

        if path == '/':
            self._serve_index()
        elif path.startswith('/static/'):
            self._serve_static(path[len('/static/'):])
        elif path.startswith('/media/'):
            rel = unquote(path[len('/media/'):])
            self._serve_media(rel)
        elif path == '/api/library':
            self._api_library()
        elif path == '/api/course':
            course_rel = qs.get('path', [''])[0]
            self._api_course(course_rel)
        elif path == '/api/export':
            course_rel = qs.get('course', [''])[0]
            self._api_export(course_rel)
        else:
            self._send_json({'error': 'Not found'}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path   = parsed.path
        qs     = parse_qs(parsed.query)

        body = self._read_body()

        if path == '/api/progress':
            self._api_progress(body)
        elif path == '/api/note':
            self._api_note(body)
        elif path == '/api/import':
            course_rel = qs.get('course', [''])[0]
            self._api_import(course_rel, body)
        else:
            self._send_json({'error': 'Not found'}, 404)

    def do_HEAD(self):
        """HEAD: same as GET but without body — required by some browsers."""
        parsed = urlparse(self.path)
        path   = parsed.path
        if path.startswith('/media/'):
            rel   = unquote(path[len('/media/'):])
            fpath = self._safe_abs_path(rel)
            if fpath and os.path.isfile(fpath):
                mime  = get_mime(fpath)
                total = os.path.getsize(fpath)
                self.send_response(200)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(total))
                self.send_header('Accept-Ranges', 'bytes')
                self._cors_headers()
                self.end_headers()
            else:
                self.send_response(404)
                self.end_headers()
        else:
            self.send_response(200)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _read_body(self) -> dict:
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length)
            return json.loads(raw.decode('utf-8')) if raw else {}
        except Exception:
            return {}

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _safe_abs_path(self, rel: str):
        """
        Resolve a relative path against the library root and validate
        against path traversal. Returns the absolute path or None if
        invalid or outside the root.
        """
        # Reject absolute paths
        if os.path.isabs(rel):
            return None
        # Reject explicit '..'
        if '..' in rel.split(os.sep) or '..' in rel.split('/'):
            return None
        # Build and resolve
        candidate = os.path.realpath(os.path.join(self.ROOT, rel))
        root_real = os.path.realpath(self.ROOT)
        if not (candidate == root_real or candidate.startswith(root_real + os.sep)):
            return None
        return candidate

    def _safe_course_abs(self, course_rel: str):
        """Resolve and validate a course path."""
        if not course_rel:
            return None
        return self._safe_abs_path(course_rel)

    # ------------------------------------------------------------------
    # Serve index and static files
    # ------------------------------------------------------------------
    def _serve_index(self):
        index = os.path.join(self.STATIC_DIR, 'index.html')
        self._serve_file(index)

    def _serve_static(self, rel: str):
        # Simple path-traversal guard for static files
        rel_clean = os.path.normpath(rel)
        if rel_clean.startswith('..'):
            self._send_json({'error': 'Forbidden'}, 403)
            return
        fpath = os.path.join(self.STATIC_DIR, rel_clean)
        self._serve_file(fpath)

    def _serve_file(self, fpath: str):
        if not os.path.isfile(fpath):
            self._send_json({'error': 'Not found'}, 404)
            return
        mime = get_mime(fpath)
        size = os.path.getsize(fpath)
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(size))
        self._cors_headers()
        self.end_headers()
        with open(fpath, 'rb') as f:
            while True:
                chunk = f.read(CHUNK_SIZE)
                if not chunk:
                    break
                self.wfile.write(chunk)

    # ------------------------------------------------------------------
    # /media with Range support
    # ------------------------------------------------------------------
    def _serve_media(self, rel: str):
        fpath = self._safe_abs_path(rel)
        if fpath is None:
            self._send_json({'error': 'Forbidden'}, 403)
            return
        if not os.path.isfile(fpath):
            self._send_json({'error': 'Not found'}, 404)
            return

        mime       = get_mime(fpath)
        total_size = os.path.getsize(fpath)
        range_hdr  = self.headers.get('Range', None)

        if range_hdr:
            # Parse "bytes=start-end"
            try:
                range_val = range_hdr.strip().replace('bytes=', '')
                parts     = range_val.split('-')
                start     = int(parts[0]) if parts[0] else 0
                end       = int(parts[1]) if parts[1] else total_size - 1
            except (ValueError, IndexError):
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{total_size}')
                self.end_headers()
                return

            end   = min(end, total_size - 1)
            start = max(0, start)
            if start > end:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{total_size}')
                self.end_headers()
                return

            length = end - start + 1
            self.send_response(206)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Range', f'bytes {start}-{end}/{total_size}')
            self.send_header('Content-Length', str(length))
            self.send_header('Accept-Ranges', 'bytes')
            self._cors_headers()
            self.end_headers()

            try:
                with open(fpath, 'rb') as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(CHUNK_SIZE, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass  # browser closed connection after buffering — normal
        else:
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(total_size))
            self.send_header('Accept-Ranges', 'bytes')
            self._cors_headers()
            self.end_headers()
            try:
                with open(fpath, 'rb') as f:
                    while True:
                        chunk = f.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass  # browser closed connection after buffering — normal

    # ------------------------------------------------------------------
    # API endpoints
    # ------------------------------------------------------------------
    def _api_library(self):
        try:
            data = _scanner.scan_library(self.ROOT)
            self._send_json(data)
        except Exception as e:
            self._send_json({'error': str(e)}, 500)

    def _api_course(self, course_rel: str):
        course_abs = self._safe_course_abs(course_rel)
        if not course_abs or not os.path.isdir(course_abs):
            self._send_json({'error': 'Course not found'}, 404)
            return
        try:
            data = _scanner.scan_course(course_abs)
            data['path'] = course_rel  # return relative path, not absolute
            self._send_json(data)
        except Exception as e:
            self._send_json({'error': str(e)}, 500)

    def _api_progress(self, body: dict):
        course_rel = body.get('course', '')
        lesson_id  = body.get('lessonId', '')
        if not course_rel or not lesson_id:
            self._send_json({'error': 'course and lessonId are required'}, 400)
            return
        course_abs = self._safe_course_abs(course_rel)
        if not course_abs:
            self._send_json({'error': 'Forbidden'}, 403)
            return
        try:
            _progress.upsert_progress(
                course_abs,
                lesson_id,
                position=body.get('position'),
                duration=body.get('duration'),
                watched=body.get('watched'),
                course_title=body.get('courseTitle', ''),
            )
            self._send_json({'ok': True})
        except Exception as e:
            self._send_json({'error': str(e)}, 500)

    def _api_note(self, body: dict):
        course_rel = body.get('course', '')
        lesson_id  = body.get('lessonId', '')
        text       = body.get('text', '')
        if not course_rel or not lesson_id:
            self._send_json({'error': 'course and lessonId are required'}, 400)
            return
        course_abs = self._safe_course_abs(course_rel)
        if not course_abs:
            self._send_json({'error': 'Forbidden'}, 403)
            return
        try:
            _progress.save_note(course_abs, lesson_id, text)
            self._send_json({'ok': True})
        except Exception as e:
            self._send_json({'error': str(e)}, 500)

    def _api_export(self, course_rel: str):
        course_abs = self._safe_course_abs(course_rel)
        if not course_abs:
            self._send_json({'error': 'Forbidden'}, 403)
            return
        try:
            data = _progress.export_progress(course_abs)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Disposition',
                             'attachment; filename=".progress.json"')
            self.send_header('Content-Length', str(len(data)))
            self._cors_headers()
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._send_json({'error': str(e)}, 500)

    def _api_import(self, course_rel: str, body: dict):
        course_abs = self._safe_course_abs(course_rel)
        if not course_abs:
            self._send_json({'error': 'Forbidden'}, 403)
            return
        try:
            _progress.import_progress(course_abs, body)
            self._send_json({'ok': True})
        except Exception as e:
            self._send_json({'error': str(e)}, 500)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description='Lore Course Player — local course library server'
    )
    parser.add_argument(
        '--root',
        default=os.getcwd(),
        help='Course library root directory (default: current directory)',
    )
    parser.add_argument(
        '--port',
        type=int,
        default=8777,
        help='Server port (default: 8777)',
    )
    parser.add_argument(
        '--no-browser',
        action='store_true',
        help='Do not open the browser automatically',
    )
    args = parser.parse_args()

    root       = os.path.realpath(args.root)
    static_dir = os.path.join(PLAYER_DIR, 'static')

    if not os.path.isdir(root):
        print(f'Error: root "{root}" is not a valid directory.', file=sys.stderr)
        sys.exit(1)
    if not os.path.isdir(static_dir):
        print(f'Error: static/ folder not found at {static_dir}', file=sys.stderr)
        sys.exit(1)

    # Configure handler with root and static_dir
    LibraryHandler.ROOT       = root
    LibraryHandler.STATIC_DIR = static_dir

    url = f'http://127.0.0.1:{args.port}'
    server = ThreadingHTTPServer(('127.0.0.1', args.port), LibraryHandler)

    print(f'Lore Course Player running at {url}')
    print(f'Root: {root}')
    print('Press Ctrl+C to stop.')

    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.')
        server.server_close()


if __name__ == '__main__':
    main()
