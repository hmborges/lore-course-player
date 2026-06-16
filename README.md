# Lore — Course Player

> Your courses, your pace, your knowledge.

A video and audio player for your local course library, running 100% offline. Browse by category, track progress, take per-lesson notes, and resume automatically from where you left off — no npm, no Docker, no external dependencies. Just Python 3.8+.

---

## Requirements

- **Python 3.8+** (standard library only — no `pip install` required)
- A modern browser with HTML5 and MSE support (Chrome, Firefox, Safari, Edge)

---

## Installation

Clone this repository **directly into the root folder of your course library**:

```bash
cd /path/to/your/courses
git clone git@github.com:hmborges/lore-course-player.git .
```

> The `.` at the end clones the contents into the current directory instead of creating a subfolder.

Your courses folder will look like this:

```
/path/to/your/courses/
├── _player/          ← cloned from this repo
├── README.md         ← cloned from this repo
├── Category A/
│   └── Course Name/
│       └── ...
└── Category B/
    └── ...
```

That's it — no dependencies to install, no build step.

---

## Running

Open a terminal inside your courses folder and run:

```bash
python3 _player/serve.py
```

The server starts at `http://127.0.0.1:8777` and opens your browser automatically.

### Options

```
python3 _player/serve.py [options]

Options:
  --root   <path>    Course library root (default: current directory)
  --port   <number>  Server port (default: 8777)
  --no-browser       Do not open the browser automatically
```

```bash
# Run from a different directory, pointing to your courses folder
python3 _player/serve.py --root "/path/to/your/courses"

# Change the port if 8777 is already in use
python3 _player/serve.py --port 9000

# Start without opening the browser automatically
python3 _player/serve.py --no-browser
```

---

## Expected library structure

The player reads your folder hierarchy to build the library. The expected structure is:

```
courses/                         ← root (--root)
├── _player/                     ← ignored automatically
├── Category A/
│   ├── Course Name/
│   │   ├── Module 1/
│   │   │   ├── 01 - Introduction.mp4
│   │   │   ├── 02 - Concepts.mp4
│   │   │   └── material.pdf
│   │   ├── Module 2/
│   │   │   └── 03 - Advanced.mp4
│   │   └── loose-lesson.mp4     ← grouped into the "General" virtual module
│   └── Another Course/
│       └── ...
└── Category B/
    └── ...
```

- **Level 1:** Category (e.g. `Programming`, `Design`)
- **Level 2:** Course (e.g. `Python for Beginners`)
- **Level 3:** Module (e.g. `Module 1 - Fundamentals`)
- **Files at the course root:** automatically grouped into the virtual module "General"

Progress for each course is saved in a `.progress.json` file inside the course folder — portable when moving or sharing the folder.

---

## Supported formats

| Type | Extensions |
|------|-----------|
| Video | `.mp4`, `.mov`, `.mkv`, `.webm`, `.avi`, `.m4v`, `.ts` |
| Audio | `.mp3`, `.m4a`, `.aac`, `.wav`, `.ogg` |
| Materials | `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.zip` and more |

> `.ts` files (MPEG-TS) are supported via [mpegts.js](https://github.com/xqq/mpegts.js), which is already bundled — no extra installation needed.

---

## Features

### Library
- Cards per category with distinct colour identity
- "Continue watching" section — in-progress courses sorted by most recent activity
- Status badges: **Completed** (100%) and **In progress** (1–99%)
- Search by course name on the home screen
- Topbar stats: total courses and how many are in progress

### Player
- Video and audio playback via native HTML5
- Streaming with **HTTP Range** support (seeking works even on large files)
- Playback speed from `0.5x` to `3.0x` (persisted across sessions)
- Buffering indicator during loading
- Theatre mode (expands the player on screen)
- Per-module playlist with previous / next buttons
- "Jump to current lesson" button in the playlist
- Autoplay when a lesson ends
- Automatic **watched** marking at 90% of duration
- Manual watched / unwatched toggle

### Progress
- Automatic position resume per lesson when reopening a course
- Course progress bar (% of lessons watched)
- Export and import `.progress.json` per course

### Notes
- Per-lesson notes with **Markdown preview**
- Auto-saved (800 ms debounce + on field blur)

### Materials
- Module material listing (PDFs, docs, etc.)
- Opens in a new tab

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `←` / `→` | Seek back / forward 10 seconds |
| `↑` / `↓` | Volume +5% / -5% |
| `N` | Next lesson |
| `P` | Previous lesson |
| `M` | Mark lesson as watched / unwatched |
| `F` | Fullscreen |
| `T` | Toggle theatre mode |
| `,` / `[` | Decrease speed by 0.1x |
| `.` / `]` | Increase speed by 0.1x |
| `0` | Reset speed to 1.0x |
| `?` | Show all keyboard shortcuts |

---

## How it works internally

```
Browser (SPA)  ←→  serve.py (HTTP + API)  ←→  Filesystem
                         ↕
                    scanner.py              ← reads folder structure
                    progress.py             ← reads/writes .progress.json
```

1. `serve.py` starts a `ThreadingHTTPServer` and serves the SPA from `static/`.
2. The frontend calls `GET /api/library` to list categories and courses.
3. When opening a course, `GET /api/course?path=...` returns modules, lessons and progress.
4. Media is served via `GET /media/<path>` with Range support (seeking).
5. Progress is saved with `POST /api/progress`; notes with `POST /api/note`.

### HTTP API

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/` | SPA (`index.html`) |
| `GET` | `/static/*` | Frontend assets |
| `GET` | `/media/*` | Media files (with Range) |
| `GET` | `/api/library` | Category and course tree |
| `GET` | `/api/course?path=` | Course details (modules, lessons, progress) |
| `GET` | `/api/export?course=` | Download `.progress.json` |
| `POST` | `/api/progress` | Save position / mark as watched |
| `POST` | `/api/note` | Save a lesson note |
| `POST` | `/api/import?course=` | Import progress from a file |

---

## Project structure

```
_player/
├── serve.py          # HTTP server and API routing
├── scanner.py        # Course library scanning and classification
├── progress.py       # Per-course progress read/write
└── static/
    ├── index.html    # SPA shell
    ├── app.js        # All frontend logic (~1090 lines)
    ├── styles.css    # Styles (dark mode, responsive layout)
    └── vendor/
        ├── mpegts.min.js   # .ts file playback via MSE
        └── marked.min.js   # Markdown note preview
```

**Full stack:**

| Layer | Technology |
|-------|------------|
| Server | Python 3.8+ (stdlib) |
| Frontend | HTML5 + CSS3 + JavaScript ES6+ (no framework) |
| Native player | `<video>` / `<audio>` HTML5 |
| `.ts` player | mpegts.js v1.7.3 |
| Markdown | marked.js v9.1.6 |
| Persistence | `.progress.json` per course + `localStorage` (preferences) |

---

## Security

- Listens on `127.0.0.1` only — not accessible from the network.
- Path traversal protection on `/media/` and `/static/` routes (`..` validation).

---

## Troubleshooting

**Port already in use:**
```bash
python3 _player/serve.py --port 8778
```

**`.ts` videos won't play:**  
Make sure you are using a browser with MSE support (Chrome or Firefox recommended).

**Course not showing in the library:**  
Check that the folder follows the `Category/Course/` hierarchy and is not hidden (name starting with `.`).

**Progress lost after moving a course:**  
The `.progress.json` file must stay inside the course folder. Move it along with the course.
