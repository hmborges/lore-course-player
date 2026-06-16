"""
scanner.py — Course library scanning and classification.
"""
import os
import re
import unicodedata

VIDEO_EXT  = {'mp4', 'ts', 'mov', 'mkv', 'webm', 'avi', 'm4v'}
AUDIO_EXT  = {'mp3', 'm4a', 'aac', 'wav', 'ogg'}
DOC_EXT    = {'pdf', 'html', 'htm', 'docx', 'doc', 'txt', 'md', 'pptx',
              'ppsx', 'pps', 'xlsx', 'zip', 'rar', 'png', 'jpg', 'jpeg',
              'epub', 'url', 'lnk', '3mf', 'stl'}

MEDIA_EXT  = VIDEO_EXT | AUDIO_EXT


def nfc(s: str) -> str:
    return unicodedata.normalize('NFC', s)


def natural_key(s: str):
    """Sort key for natural ordering: splits into int/str chunks."""
    parts = re.split(r'(\d+)', s)
    return [int(p) if p.isdigit() else p.lower() for p in parts]


def _is_ignored(name: str) -> bool:
    """Returns True for names that should be skipped during scanning."""
    if name.startswith('._') or name.startswith('.'):
        return True
    if name in ('.DS_Store', 'Thumbs.db', 'DS_Store'):
        return True
    if name == '_player':
        return True
    if name.endswith('.progress.json'):
        return True
    return False


TITLE_NUM_PREFIX = re.compile(r'^\s*\d+\s*[-._)]\s*')
TITLE_RES_SUFFIX = re.compile(r'\s*[-_]?\s*\d{3,4}x\d{3,4}.*$', re.IGNORECASE)


def clean_title(name: str) -> str:
    """Clean a filename for display, stripping numeric prefix and resolution suffix."""
    t = os.path.splitext(name)[0]
    t = TITLE_NUM_PREFIX.sub('', t)
    t = TITLE_RES_SUFFIX.sub('', t)
    return nfc(t.strip()) or nfc(os.path.splitext(name)[0])


def _classify(name: str) -> str:
    ext = os.path.splitext(name)[1].lstrip('.').lower()
    if ext in VIDEO_EXT:
        return 'video'
    if ext in AUDIO_EXT:
        return 'audio'
    if ext in DOC_EXT:
        return 'doc'
    return 'other'


def _scan_module_dir(mod_abs: str, course_abs: str) -> tuple:
    """
    Scan a module directory (level 3), flattening sub-folders recursively.
    Returns (lessons, materials).
    """
    lessons = []
    materials = []

    def walk(dirpath: str):
        try:
            entries = sorted(os.scandir(dirpath), key=lambda e: natural_key(e.name))
        except PermissionError:
            return
        for e in entries:
            if _is_ignored(e.name):
                continue
            if e.is_dir(follow_symlinks=False):
                walk(e.path)
            elif e.is_file(follow_symlinks=False):
                kind = _classify(e.name)
                rel_to_course = os.path.relpath(e.path, course_abs)
                item = {
                    'id':    rel_to_course,
                    'name':  nfc(e.name),
                    'title': clean_title(e.name),
                    'path':  rel_to_course,
                    'size':  e.stat().st_size,
                    'kind':  kind,
                }
                if kind in ('video', 'audio'):
                    lessons.append(item)
                elif kind in ('doc', 'other'):
                    materials.append(item)

    walk(mod_abs)
    return lessons, materials


def scan_course(course_abs: str) -> dict:
    """
    Scan a course and return its full structure: modules → lessons + materials + progress.
    """
    from progress import load_progress

    modules = []
    general_lessons = []
    general_materials = []

    try:
        entries = sorted(os.scandir(course_abs), key=lambda e: natural_key(e.name))
    except PermissionError:
        entries = []

    for e in entries:
        if _is_ignored(e.name):
            continue
        if e.is_file(follow_symlinks=False):
            kind = _classify(e.name)
            rel = os.path.relpath(e.path, course_abs)
            item = {
                'id':    rel,
                'name':  nfc(e.name),
                'title': clean_title(e.name),
                'path':  rel,
                'size':  e.stat().st_size,
                'kind':  kind,
            }
            if kind in ('video', 'audio'):
                general_lessons.append(item)
            elif kind in ('doc', 'other'):
                general_materials.append(item)
        elif e.is_dir(follow_symlinks=False):
            lessons, materials = _scan_module_dir(e.path, course_abs)
            modules.append({
                'name':      nfc(e.name),
                'title':     nfc(e.name),
                'lessons':   lessons,
                'materials': materials,
            })

    # Loose files at course root → virtual "General" module (first)
    if general_lessons or general_materials:
        modules.insert(0, {
            'name':      'General',
            'title':     'General',
            'lessons':   general_lessons,
            'materials': general_materials,
        })

    # Load progress
    progress = load_progress(course_abs)
    lessons_prog = progress.get('lessons', {})
    notes_data   = progress.get('notes', {})

    # Count totals
    total_lessons  = 0
    watched_lessons = 0
    for mod in modules:
        for lesson in mod['lessons']:
            total_lessons += 1
            lp = lessons_prog.get(lesson['id'], {})
            lesson['watched']   = lp.get('watched', False)
            lesson['position']  = lp.get('position', 0)
            lesson['duration']  = lp.get('duration', 0)
            lesson['updatedAt'] = lp.get('updatedAt', '')
            lesson['note']      = notes_data.get(lesson['id'], '')
            if lesson['watched']:
                watched_lessons += 1

    progress_pct = round(watched_lessons / total_lessons * 100) if total_lessons else 0

    return {
        'title':        nfc(os.path.basename(course_abs)),
        'path':         course_abs,
        'modules':      modules,
        'lessonCount':  total_lessons,
        'watchedCount': watched_lessons,
        'progressPct':  progress_pct,
    }


def scan_library(root: str) -> list:
    """
    Scan the library root and return a lightweight list of categories with courses.
    """
    from progress import load_progress

    categories = []
    try:
        cat_entries = sorted(os.scandir(root), key=lambda e: natural_key(e.name))
    except PermissionError:
        return []

    for cat in cat_entries:
        if _is_ignored(cat.name) or not cat.is_dir(follow_symlinks=False):
            continue
        courses = []
        try:
            course_entries = sorted(os.scandir(cat.path), key=lambda e: natural_key(e.name))
        except PermissionError:
            course_entries = []

        for c in course_entries:
            if _is_ignored(c.name) or not c.is_dir(follow_symlinks=False):
                continue
            lesson_count, _ = _quick_count(c.path)
            prog = load_progress(c.path)
            watched_count = sum(
                1 for v in prog.get('lessons', {}).values() if v.get('watched')
            )
            courses.append({
                'title':        nfc(c.name),
                'path':         os.path.relpath(c.path, root),
                'lessonCount':  lesson_count,
                'watchedCount': watched_count,
                'progressPct':  round(watched_count / lesson_count * 100) if lesson_count else 0,
                'updatedAt':    prog.get('updatedAt', ''),
            })

        if courses:
            categories.append({
                'title':   nfc(cat.name),
                'courses': courses,
            })

    return categories


def _quick_count(course_abs: str) -> tuple:
    """Count lessons quickly without deep scanning."""
    total = 0
    def walk(d):
        nonlocal total
        try:
            for e in os.scandir(d):
                if _is_ignored(e.name):
                    continue
                if e.is_dir(follow_symlinks=False):
                    walk(e.path)
                elif e.is_file(follow_symlinks=False):
                    if _classify(e.name) in ('video', 'audio'):
                        total += 1
        except PermissionError:
            pass
    walk(course_abs)
    return total, 0
