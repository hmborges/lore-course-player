"""
progress.py — Atomic read/write of .progress.json per course.
"""
import json
import os
import tempfile
import threading
from datetime import datetime, timezone

PROGRESS_FILE = '.progress.json'

_locks: dict = {}
_locks_lock = threading.Lock()


def _get_lock(course_abs: str) -> threading.Lock:
    with _locks_lock:
        if course_abs not in _locks:
            _locks[course_abs] = threading.Lock()
        return _locks[course_abs]


def _progress_path(course_abs: str) -> str:
    return os.path.join(course_abs, PROGRESS_FILE)


def load_progress(course_abs: str) -> dict:
    """Load .progress.json; returns {} if absent or corrupted."""
    path = _progress_path(course_abs)
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return _empty()
        return data
    except FileNotFoundError:
        return _empty()
    except (json.JSONDecodeError, OSError) as e:
        print(f'[progress] Warning: {path} is corrupted or unreadable ({e}). Treating as empty.')
        return _empty()


def _empty() -> dict:
    return {'version': 1, 'lessons': {}, 'notes': {}}


def _save_progress(course_abs: str, data: dict):
    """Atomic write via temp file + os.replace."""
    path = _progress_path(course_abs)
    data['updatedAt'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    dirpath = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=dirpath, prefix='.prog_tmp_')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def upsert_progress(course_abs: str, lesson_id: str,
                    position: float = None, duration: float = None,
                    watched: bool = None, course_title: str = '') -> dict:
    """Update lesson progress atomically and thread-safely."""
    lock = _get_lock(course_abs)
    with lock:
        data = load_progress(course_abs)
        if 'lessons' not in data or not isinstance(data['lessons'], dict):
            data['lessons'] = {}
        if 'notes' not in data or not isinstance(data['notes'], dict):
            data['notes'] = {}
        if course_title:
            data['courseTitle'] = course_title

        lesson = data['lessons'].setdefault(lesson_id, {})
        lesson['updatedAt'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

        if position is not None:
            lesson['position'] = position
        if duration is not None:
            lesson['duration'] = duration
        if watched is not None:
            lesson['watched'] = watched
            if watched:
                lesson['position'] = 0  # reset position when marking as watched

        _save_progress(course_abs, data)
        return data


def save_note(course_abs: str, lesson_id: str, text: str) -> dict:
    """Save a lesson note."""
    lock = _get_lock(course_abs)
    with lock:
        data = load_progress(course_abs)
        if 'notes' not in data or not isinstance(data['notes'], dict):
            data['notes'] = {}
        data['notes'][lesson_id] = text
        _save_progress(course_abs, data)
        return data


def export_progress(course_abs: str) -> bytes:
    """Return the contents of .progress.json as bytes."""
    path = _progress_path(course_abs)
    try:
        with open(path, 'rb') as f:
            return f.read()
    except FileNotFoundError:
        return json.dumps(_empty(), ensure_ascii=False, indent=2).encode('utf-8')


def import_progress(course_abs: str, data: dict):
    """Replace .progress.json with the provided data (basic merge)."""
    lock = _get_lock(course_abs)
    with lock:
        existing = load_progress(course_abs)
        # Merge: existing lessons and notes are preserved when absent from the import
        merged_lessons = {**existing.get('lessons', {}), **data.get('lessons', {})}
        merged_notes   = {**existing.get('notes', {}), **data.get('notes', {})}
        data['lessons'] = merged_lessons
        data['notes']   = merged_notes
        data['version'] = 1
        _save_progress(course_abs, data)
