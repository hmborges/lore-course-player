/* ===================================================================
   app.js — Lore Course Player SPA
   =================================================================== */
'use strict';

// ─── Global state ─────────────────────────────────────────────────────────
const State = {
  library: [],            // category/course tree
  course: null,           // currently open course
  courseRel: '',          // relative path of the course
  flatLessons: [],        // flat list of all lessons in the course
  currentIndex: -1,       // index of the current lesson in flatLessons
  mpegtsPlayer: null,     // active mpegts.js instance
  speed: parseFloat(localStorage.getItem('playbackSpeed') || '1.0'),
  volume: parseFloat(localStorage.getItem('volume') || '1.0'),
  notesDebounce: null,
  saveDebounce: null,
  watchedThresholdFired: false,
  _metaListener: null,
  _errorListener: null,
};

// ─── DOM elements ─────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const video          = $('main-video');
const homeView       = $('home-view');
const courseView     = $('course-view');
const categoriesEl   = $('categories-container');
const playlistEl     = $('playlist');
const searchInput    = $('search-input');
const speedDisplay   = $('speed-display');
const speedControl   = $('speed-control');
const lessonTitle    = $('lesson-title-main');
const notesEditor    = $('notes-editor');
const notesPreview   = $('notes-preview');
const materialsList  = $('materials-list');
const materialsEmpty = $('materials-empty');
const loadingOverlay = $('loading-overlay');
const bufferingEl    = $('buffering-overlay');
const shortcutsOverlay = $('shortcuts-overlay');
const jumpCurrentBtn   = $('jump-current-btn');
const helpBtn          = $('help-btn');

// ─── Utils ────────────────────────────────────────────────────────────────

// Robust encoding for Unicode path names (replaces deprecated escape/unescape)
function encodeCoursePath(p) {
  try {
    return btoa(String.fromCharCode(...new TextEncoder().encode(p)));
  } catch {
    // fallback for long strings exceeding spread limit
    const bytes = new TextEncoder().encode(p);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
}
function decodeCoursePath(b64) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch { return ''; }
}

function fmtDuration(sec) {
  if (!sec || isNaN(sec)) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  if (b < 1024*1024*1024) return (b/1024/1024).toFixed(1) + ' MB';
  return (b/1024/1024/1024).toFixed(1) + ' GB';
}

function toast(msg, type='') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' '+type : '');
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
  setTimeout(() => loadingOverlay.style.display = 'none', 350);
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Material icon by file extension
function materialIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    pdf:'📄', html:'🌐', htm:'🌐', docx:'📝', doc:'📝', txt:'📃', md:'📃',
    pptx:'📊', ppsx:'📊', pps:'📊', xlsx:'📊', png:'🖼️', jpg:'🖼️', jpeg:'🖼️',
    zip:'🗜️', rar:'🗜️', epub:'📚', url:'🔗', lnk:'🔗', '3mf':'🖨️', stl:'🖨️',
  };
  return map[ext] || '📎';
}

// ─── Hash routing ─────────────────────────────────────────────────────────
function navigate(hash) {
  if (hash.startsWith('#/course/')) {
    const encoded = hash.slice('#/course/'.length);
    const rel = decodeCoursePath(encoded);
    if (rel) openCourse(rel);
  } else {
    showHome();
  }
}

window.addEventListener('hashchange', () => navigate(location.hash));

// ─── Home ──────────────────────────────────────────────────────────────────
function showHome() {
  _removeVideoListeners();
  destroyMpegts();
  video.pause();
  video.removeAttribute('src');
  video.load();

  homeView.classList.add('active');
  courseView.classList.remove('active');
  document.title = 'Lore';
  searchInput.style.display = '';

  // Render cached data immediately for instant feedback, then refresh
  if (State.library.length) renderHome(State.library);
  refreshLibrary();
}

async function loadLibrary() {
  try {
    const res = await fetch('/api/library');
    State.library = await res.json();
    renderHome(State.library);
    updateTopbarStats(State.library);
  } catch (e) {
    categoriesEl.innerHTML = `<p style="color:var(--danger);padding:24px">Failed to load library: ${e.message}</p>`;
  } finally {
    hideLoading();
  }
}

async function refreshLibrary() {
  try {
    const res = await fetch('/api/library');
    State.library = await res.json();
    renderHome(State.library);
    updateTopbarStats(State.library);
  } catch { /* silently keep showing cached data */ }
}

function updateTopbarStats(library) {
  const statsEl = $('library-stats');
  if (!statsEl) return;
  const total  = library.reduce((s, cat) => s + cat.courses.length, 0);
  const inProg = library.flatMap(c => c.courses)
                        .filter(c => c.progressPct > 0 && c.progressPct < 100).length;
  if (total === 0) { statsEl.textContent = ''; return; }
  statsEl.textContent = inProg > 0
    ? `${total} course${total !== 1 ? 's' : ''} · ${inProg} in progress`
    : `${total} course${total !== 1 ? 's' : ''}`;
}

// Category gradient palette (name hash → colour)
const CATEGORY_PALETTES = [
  'linear-gradient(135deg,#6c8cff,#a06bff)',
  'linear-gradient(135deg,#ff6b6b,#ff9a56)',
  'linear-gradient(135deg,#3fb95f,#56d4a0)',
  'linear-gradient(135deg,#f7b731,#fa8231)',
  'linear-gradient(135deg,#26c6da,#4fc3f7)',
  'linear-gradient(135deg,#ec407a,#f48fb1)',
  'linear-gradient(135deg,#ab47bc,#7e57c2)',
  'linear-gradient(135deg,#26a69a,#80cbc4)',
];
function catGradient(catTitle) {
  let hash = 0;
  for (let i = 0; i < catTitle.length; i++) hash = (hash * 31 + catTitle.charCodeAt(i)) >>> 0;
  return CATEGORY_PALETTES[hash % CATEGORY_PALETTES.length];
}

// Extracts the primary colour from a gradient string for the card glow
function extractGlowColor(gradient) {
  const match = gradient.match(/#([0-9a-fA-F]{6})/);
  if (!match) return 'rgba(108,140,255,.22)';
  const hex = match[1];
  const r = parseInt(hex.slice(0,2),16);
  const g = parseInt(hex.slice(2,4),16);
  const b = parseInt(hex.slice(4,6),16);
  return `rgba(${r},${g},${b},.28)`;
}

function renderHome(library) {
  categoriesEl.innerHTML = '';
  if (!library.length) {
    categoriesEl.innerHTML = '<div class="empty-state" style="margin-top:60px"><span>No courses found in the library.</span></div>';
    return;
  }

  // "Continue watching" section
  const continueAccent = 'linear-gradient(135deg,#6c8cff,#a06bff)';
  const inProgress = library
    .flatMap(cat => cat.courses.map(c => ({ ...c, catTitle: cat.title })))
    .filter(c => c.progressPct > 0 && c.progressPct < 100)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, 6);

  if (inProgress.length) {
    const sec = document.createElement('section');
    sec.id = 'continue-section';
    sec.className = 'category-section';

    const header = buildCategoryHeader('Continue watching', inProgress.length, continueAccent);
    sec.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'courses-grid';
    inProgress.forEach((c, i) => {
      const grad = catGradient(c.catTitle);
      grid.appendChild(buildCourseCard(c, grad, i));
    });
    sec.appendChild(grid);
    categoriesEl.appendChild(sec);
  }

  // Categories
  let globalCardIndex = 0;
  for (const cat of library) {
    categoriesEl.appendChild(buildCategorySection(cat, globalCardIndex));
    globalCardIndex += cat.courses.length;
  }
}

function buildCategoryHeader(title, count, gradient) {
  const header = document.createElement('div');
  header.className = 'category-header';

  const bar = document.createElement('span');
  bar.className = 'category-bar';
  bar.style.background = gradient;
  header.appendChild(bar);

  const h2 = document.createElement('h2');
  h2.className = 'category-title';
  h2.textContent = title;
  header.appendChild(h2);

  const cnt = document.createElement('span');
  cnt.className = 'category-count';
  cnt.textContent = count + (count === 1 ? ' course' : ' courses');
  header.appendChild(cnt);

  return header;
}

function buildCategorySection(cat, startIndex = 0) {
  const sec = document.createElement('section');
  sec.className = 'category-section';
  sec.dataset.category = cat.title;

  const grad = catGradient(cat.title);
  sec.appendChild(buildCategoryHeader(cat.title, cat.courses.length, grad));

  const grid = document.createElement('div');
  grid.className = 'courses-grid';
  cat.courses.forEach((course, i) => {
    grid.appendChild(buildCourseCard(course, grad, startIndex + i));
  });
  sec.appendChild(grid);
  return sec;
}

function buildCourseCard(course, catGrad, cardIndex = 0) {
  const pct     = course.progressPct || 0;
  const done    = pct >= 100;
  const started = pct > 0 && pct < 100;
  const glow    = extractGlowColor(catGrad);

  const card = document.createElement('article');
  card.className = 'course-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Open course: ${course.title}`);
  card.dataset.coursePath = course.path;
  card.style.setProperty('--card-index', cardIndex);
  card.style.setProperty('--card-glow', glow);

  // Colour stripe at the top
  const accent = document.createElement('div');
  accent.className = 'card-accent';
  accent.style.background = catGrad;
  card.appendChild(accent);

  // Body
  const body = document.createElement('div');
  body.className = 'card-body';

  const titleEl = document.createElement('div');
  titleEl.className = 'card-title';
  titleEl.textContent = course.title;
  titleEl.title = course.title;
  body.appendChild(titleEl);

  const metaEl = document.createElement('div');
  metaEl.className = 'card-meta';
  metaEl.textContent = `${course.lessonCount} lesson${course.lessonCount !== 1 ? 's' : ''}`;
  body.appendChild(metaEl);

  // Footer: progress bar + % + badge
  const footer = document.createElement('div');
  footer.className = 'card-footer';

  const barWrap = document.createElement('div');
  barWrap.className = 'card-progress-bar';
  const barFill = document.createElement('div');
  barFill.className = 'card-progress-fill';
  barFill.style.width = pct + '%';
  barFill.style.background = catGrad;
  barWrap.appendChild(barFill);
  footer.appendChild(barWrap);

  const pctEl = document.createElement('span');
  pctEl.className = 'card-pct';
  pctEl.textContent = pct + '%';
  footer.appendChild(pctEl);

  if (done || started) {
    const badge = document.createElement('span');
    badge.className = 'card-badge ' + (done ? 'done' : 'in-progress');
    badge.textContent = done ? '✓' : '…';
    footer.appendChild(badge);
  }

  body.appendChild(footer);
  card.appendChild(body);

  const open = () => { location.hash = '#/course/' + encodeCoursePath(course.path); };
  card.addEventListener('click', open);
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return card;
}

// ─── Home search ──────────────────────────────────────────────────────────
searchInput.addEventListener('input', () => {
  const q = searchInput.value.toLowerCase().trim();
  document.querySelectorAll('.course-card').forEach(card => {
    const label = (card.getAttribute('aria-label') || '').toLowerCase();
    card.style.display = (!q || label.includes(q)) ? '' : 'none';
  });
  document.querySelectorAll('.category-section').forEach(sec => {
    const visible = [...sec.querySelectorAll('.course-card')].some(c => c.style.display !== 'none');
    sec.style.display = visible ? '' : 'none';
  });
});

// ─── Course view ───────────────────────────────────────────────────────────
async function openCourse(courseRel) {
  homeView.classList.remove('active');
  courseView.classList.add('active');
  searchInput.style.display = 'none';

  destroyMpegts();
  State.course = null;
  State.flatLessons = [];
  State.currentIndex = -1;
  State.watchedThresholdFired = false;
  playlistEl.innerHTML = '<li style="padding:16px;color:var(--muted);font-size:.82rem">Loading…</li>';
  jumpCurrentBtn.classList.remove('visible');

  try {
    const res = await fetch(`/api/course?path=${encodeURIComponent(courseRel)}`);
    if (!res.ok) throw new Error('Course not found');
    const course = await res.json();
    State.course    = course;
    State.courseRel = courseRel;

    document.title = course.title + ' — Lore';
    applyTheaterPreference();
    buildFlatLessons(course);
    renderSidebar(course);

    const lastLesson = findLastLesson(course);
    if (lastLesson !== -1) playLesson(lastLesson);
  } catch (e) {
    playlistEl.innerHTML = `<li style="padding:16px;color:var(--danger);font-size:.82rem">${e.message}</li>`;
  }
}

function findLastLesson(course) {
  let bestIdx = 0;
  let bestTime = '';
  for (let i = 0; i < State.flatLessons.length; i++) {
    const l = State.flatLessons[i];
    if (!l.watched && l.position > 5) {
      const t = l.updatedAt || '';
      if (!bestTime || t > bestTime) { bestTime = t; bestIdx = i; }
    }
  }
  if (!bestTime) {
    for (let i = 0; i < State.flatLessons.length; i++) {
      if (!State.flatLessons[i].watched) return i;
    }
    return 0;
  }
  return bestIdx;
}

function buildFlatLessons(course) {
  State.flatLessons = [];
  for (const mod of course.modules) {
    for (const lesson of mod.lessons) {
      State.flatLessons.push({ ...lesson, moduleName: mod.title });
    }
  }
}

function renderSidebar(course) {
  $('course-title-sidebar').textContent = course.title;
  updateCourseProgress(course);

  playlistEl.innerHTML = '';
  for (let mi = 0; mi < course.modules.length; mi++) {
    const mod = course.modules[mi];
    const modEl = document.createElement('li');
    modEl.className = 'module-group';

    const watched = mod.lessons.filter(l => l.watched).length;
    const total   = mod.lessons.length;
    const modPct  = total ? Math.round(watched / total * 100) : 0;

    modEl.innerHTML = `
      <div class="module-header" role="button" tabindex="0" aria-expanded="true">
        <span style="flex:0 0 auto">${escHtml(mod.title)}</span>
        <div class="module-prog-bar" title="${watched}/${total} watched">
          <div class="module-prog-fill" style="width:${modPct}%"></div>
        </div>
        <span class="module-chevron">▾</span>
      </div>
      <ol class="module-lessons"></ol>`;

    const header = modEl.querySelector('.module-header');
    const lessonsList = modEl.querySelector('.module-lessons');

    header.addEventListener('click', () => {
      modEl.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', !modEl.classList.contains('collapsed'));
    });
    header.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); header.click(); }
    });

    for (let li = 0; li < mod.lessons.length; li++) {
      const lesson = mod.lessons[li];
      const flatIdx = State.flatLessons.findIndex(l => l.id === lesson.id);
      lessonsList.appendChild(buildLessonItem(lesson, flatIdx));
    }

    playlistEl.appendChild(modEl);
  }
}

function buildLessonItem(lesson, flatIdx) {
  const li = document.createElement('li');
  li.className = 'lesson-item';
  li.dataset.lessonId  = lesson.id;
  li.dataset.flatIndex = flatIdx;

  const checkEl = document.createElement('span');
  checkEl.className = 'lesson-check' + (lesson.watched ? ' watched' : '');
  checkEl.title = lesson.watched ? 'Mark as unwatched' : 'Mark as watched';
  checkEl.innerHTML = lesson.watched ? '✓' : '';
  checkEl.addEventListener('click', e => {
    e.stopPropagation();
    toggleWatched(flatIdx, lesson.id);
  });

  const titleEl = document.createElement('span');
  titleEl.className = 'lesson-title-text';
  titleEl.textContent = lesson.title;
  titleEl.title = lesson.name;

  const durEl = document.createElement('span');
  durEl.className = 'lesson-duration';
  durEl.dataset.lessonId = lesson.id;
  if (lesson.duration) durEl.textContent = fmtDuration(lesson.duration);

  li.appendChild(checkEl);
  li.appendChild(titleEl);
  li.appendChild(durEl);
  li.addEventListener('click', () => playLesson(flatIdx));
  return li;
}

function updateCourseProgress(course) {
  const pct = course.progressPct || 0;
  $('sidebar-progress-fill').style.width = pct + '%';
  $('sidebar-progress-pct').textContent  = pct + '%';
  $('sidebar-progress-text').textContent =
    `${course.watchedCount} of ${course.lessonCount} watched`;
}

function setActiveLessonInPlaylist(flatIdx) {
  document.querySelectorAll('.lesson-item').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.flatIndex) === flatIdx);
  });
  const activeEl = playlistEl.querySelector('.lesson-item.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  // Show "Jump to current lesson" button
  jumpCurrentBtn.classList.add('visible');
}

// ─── "Jump to current lesson" button ──────────────────────────────────────
jumpCurrentBtn.addEventListener('click', () => {
  const activeEl = playlistEl.querySelector('.lesson-item.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

// ─── Player ────────────────────────────────────────────────────────────────
function playLesson(flatIdx) {
  if (flatIdx < 0 || flatIdx >= State.flatLessons.length) return;

  if (State.currentIndex >= 0 && State.currentIndex !== flatIdx) {
    saveCurrentPosition(true);
  }

  State.currentIndex          = flatIdx;
  State.watchedThresholdFired = false;
  const lesson = State.flatLessons[flatIdx];

  setActiveLessonInPlaylist(flatIdx);
  lessonTitle.textContent = lesson.title;
  document.title = lesson.title + ' — Lore';

  loadMedia(lesson);
  loadNote(lesson);
  loadMaterials(lesson);
  updateNavButtons();
}

function _removeVideoListeners() {
  if (State._metaListener)  { video.removeEventListener('loadedmetadata', State._metaListener); State._metaListener = null; }
  if (State._errorListener) { video.removeEventListener('error', State._errorListener);         State._errorListener = null; }
}

function loadMedia(lesson) {
  const ext = lesson.name.split('.').pop().toLowerCase();
  const url  = '/media/' + encodeMediaPath(lesson.id.startsWith('/') ? lesson.id : State.courseRel + '/' + lesson.id);

  _removeVideoListeners();
  destroyMpegts();
  hideVideoUnsupported();
  hideBuffering();

  video.pause();
  video.removeAttribute('src');
  video.load();
  video.volume = State.volume;

  if (ext === 'ts') {
    loadWithMpegts(url, lesson);
  } else {
    State._metaListener  = onMetadataLoaded;
    State._errorListener = onVideoError;
    video.addEventListener('loadedmetadata', State._metaListener,  { once: true });
    video.addEventListener('error',          State._errorListener, { once: true });
    video.src = url;
    video.load();
    video.play().catch(() => {});
  }
}

function encodeMediaPath(relPath) {
  return relPath.split('/').map(part => encodeURIComponent(part)).join('/');
}

function loadWithMpegts(url, lesson) {
  if (!window.mpegts || !mpegts.isSupported()) {
    showVideoUnsupported('mpegts.js is not available or MSE is not supported in this browser.');
    return;
  }
  try {
    const player = mpegts.createPlayer({ type: 'mpegts', isLive: false, url });
    player.attachMediaElement(video);
    player.load();
    State.mpegtsPlayer = player;
    player.on(mpegts.Events.ERROR, (type, detail) => {
      console.warn('[mpegts] error:', type, detail);
      _removeVideoListeners();
      showVideoUnsupported('Error playing .ts file: ' + (detail?.msg || type));
    });
    State._metaListener  = onMetadataLoaded;
    State._errorListener = onVideoError;
    video.addEventListener('loadedmetadata', State._metaListener,  { once: true });
    video.addEventListener('error',          State._errorListener, { once: true });
    video.play().catch(() => {});
  } catch (e) {
    showVideoUnsupported('Error initializing mpegts.js: ' + e.message);
  }
}

function destroyMpegts() {
  if (State.mpegtsPlayer) {
    try {
      State.mpegtsPlayer.pause();
      State.mpegtsPlayer.unload();
      State.mpegtsPlayer.detachMediaElement();
      State.mpegtsPlayer.destroy();
    } catch { /* ignore */ }
    State.mpegtsPlayer = null;
  }
}

function showVideoUnsupported(msg) {
  $('unsupported-msg').textContent = msg || 'Format not supported in this browser.';
  $('video-unsupported').classList.add('show');
  video.style.display = 'none';
}
function hideVideoUnsupported() {
  $('video-unsupported').classList.remove('show');
  video.style.display = '';
}

// ─── Buffering indicator ──────────────────────────────────────────────────
function showBuffering() { bufferingEl.classList.add('show'); }
function hideBuffering()  { bufferingEl.classList.remove('show'); }

video.addEventListener('waiting',  showBuffering);
video.addEventListener('playing',  hideBuffering);
video.addEventListener('canplay',  hideBuffering);
video.addEventListener('ended',    hideBuffering);

// ─── Metadata / error ─────────────────────────────────────────────────────
function onMetadataLoaded() {
  const lesson = State.flatLessons[State.currentIndex];
  if (!lesson) return;

  applySpeed();

  if (video.duration && !isNaN(video.duration)) {
    lesson.duration = video.duration;
    updateDurationInPlaylist(lesson.id, video.duration);
  }

  const pos = lesson.position || 0;
  if (pos > 5 && video.duration && pos < video.duration - 15) {
    video.currentTime = pos;
  }
}

function onVideoError() {
  const err = video.error;
  if (!err) return;
  const msgs = {
    1: 'Loading aborted.',
    2: 'Network error while loading video.',
    3: 'Decoding error. Codec may not be supported.',
    4: 'Format or codec not supported in this browser.',
  };
  showVideoUnsupported(msgs[err.code] || 'Unknown error during playback.');
}

function updateDurationInPlaylist(lessonId, dur) {
  document.querySelectorAll(`.lesson-duration[data-lesson-id="${CSS.escape(lessonId)}"]`)
    .forEach(el => { el.textContent = fmtDuration(dur); });
}

// ─── Save position ────────────────────────────────────────────────────────
function saveCurrentPosition(force = false) {
  const lesson = State.flatLessons[State.currentIndex];
  if (!lesson || !State.courseRel) return;
  if (!video.src && !State.mpegtsPlayer) return;

  navigator.sendBeacon('/api/progress', JSON.stringify({
    course:      State.courseRel,
    lessonId:    lesson.id,
    position:    video.currentTime,
    duration:    video.duration || lesson.duration || undefined,
    courseTitle: State.course?.title || '',
  }));
}

// Throttle save every 5s during playback
video.addEventListener('timeupdate', () => {
  if (State.saveDebounce) return;
  State.saveDebounce = setTimeout(() => {
    State.saveDebounce = null;
    checkAutoWatched();
    saveCurrentPosition();
  }, 5000);
});

video.addEventListener('pause',  () => saveCurrentPosition());
video.addEventListener('ended',  onVideoEnded);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveCurrentPosition();
});
window.addEventListener('beforeunload', () => saveCurrentPosition());

function checkAutoWatched() {
  if (State.watchedThresholdFired) return;
  const lesson = State.flatLessons[State.currentIndex];
  if (!lesson || lesson.watched) return;
  const dur = video.duration;
  if (!dur || isNaN(dur)) return;
  if (video.currentTime / dur >= 0.9) {
    State.watchedThresholdFired = true;
    markWatched(State.currentIndex, lesson.id, true);
  }
}

function onVideoEnded() {
  hideBuffering();
  const lesson = State.flatLessons[State.currentIndex];
  if (lesson) markWatched(State.currentIndex, lesson.id, true);
  const next = State.currentIndex + 1;
  if (next < State.flatLessons.length) playLesson(next);
}

// ─── Mark as watched ──────────────────────────────────────────────────────
function toggleWatched(flatIdx, lessonId) {
  const lesson = State.flatLessons[flatIdx];
  if (!lesson) return;
  markWatched(flatIdx, lessonId, !lesson.watched);
}

function markWatched(flatIdx, lessonId, watched) {
  const lesson = State.flatLessons[flatIdx];
  if (!lesson) return;
  lesson.watched = watched;

  fetch('/api/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      course:      State.courseRel,
      lessonId:    lessonId,
      watched:     watched,
      courseTitle: State.course?.title || '',
    }),
  }).catch(() => {});

  updateCheckInPlaylist(lessonId, watched);
  refreshCourseProgress();
  toast(watched ? 'Marked as watched ✓' : 'Unmarked', watched ? 'success' : '');
}

function updateCheckInPlaylist(lessonId, watched) {
  document.querySelectorAll(`.lesson-item[data-lesson-id="${CSS.escape(lessonId)}"] .lesson-check`).forEach(el => {
    el.classList.toggle('watched', watched);
    el.innerHTML = watched ? '✓' : '';
    el.title = watched ? 'Mark as unwatched' : 'Mark as watched';
  });
}

function refreshCourseProgress() {
  if (!State.course) return;
  const total   = State.flatLessons.length;
  const watched = State.flatLessons.filter(l => l.watched).length;
  State.course.lessonCount  = total;
  State.course.watchedCount = watched;
  State.course.progressPct  = total ? Math.round(watched / total * 100) : 0;
  updateCourseProgress(State.course);

  document.querySelectorAll('.module-group').forEach((modEl, mi) => {
    const mod = State.course.modules[mi];
    if (!mod) return;
    const wCount = mod.lessons.filter(l => {
      const fl = State.flatLessons.find(f => f.id === l.id);
      return fl ? fl.watched : l.watched;
    }).length;
    const pct = mod.lessons.length ? Math.round(wCount / mod.lessons.length * 100) : 0;
    const fill = modEl.querySelector('.module-prog-fill');
    if (fill) fill.style.width = pct + '%';
  });
}

// ─── Prev/next navigation ─────────────────────────────────────────────────
$('prev-btn').addEventListener('click', () => {
  if (State.currentIndex > 0) playLesson(State.currentIndex - 1);
});
$('next-btn').addEventListener('click', () => {
  if (State.currentIndex < State.flatLessons.length - 1) playLesson(State.currentIndex + 1);
});
$('mark-btn').addEventListener('click', () => {
  const lesson = State.flatLessons[State.currentIndex];
  if (lesson) toggleWatched(State.currentIndex, lesson.id);
});

function updateNavButtons() {
  $('prev-btn').disabled = State.currentIndex <= 0;
  $('next-btn').disabled = State.currentIndex >= State.flatLessons.length - 1;
}

// ─── Speed ────────────────────────────────────────────────────────────────
const SPEED_MIN = 0.5, SPEED_MAX = 3.0, SPEED_STEP = 0.1;

function setSpeed(v) {
  v = Math.round(Math.max(SPEED_MIN, Math.min(SPEED_MAX, v)) * 10) / 10;
  State.speed = v;
  localStorage.setItem('playbackSpeed', v);
  applySpeed();
  speedDisplay.textContent = v.toFixed(1) + 'x';
  // Visual highlight when speed differs from 1.0x
  speedControl.classList.toggle('speed-active', v !== 1.0);
}

function applySpeed() {
  try { video.playbackRate = State.speed; } catch { /* degrade gracefully */ }
}

$('speed-dec').addEventListener('click', () => setSpeed(State.speed - SPEED_STEP));
$('speed-inc').addEventListener('click', () => setSpeed(State.speed + SPEED_STEP));

setSpeed(State.speed); // initialize display

// ─── Persistent volume ────────────────────────────────────────────────────
video.volume = State.volume;
video.addEventListener('volumechange', () => {
  State.volume = video.volume;
  localStorage.setItem('volume', video.volume);
});

// ─── Keyboard shortcuts ───────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT') return;

  // Close overlay with Escape
  if (e.key === 'Escape') {
    if (shortcutsOverlay.classList.contains('show')) {
      closeShortcutsOverlay();
      return;
    }
  }

  switch (e.key) {
    case '?':
      e.preventDefault();
      toggleShortcutsOverlay();
      break;
    case ' ':
      e.preventDefault();
      video.paused ? video.play() : video.pause();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      video.currentTime = Math.max(0, video.currentTime - 10);
      break;
    case 'ArrowRight':
      e.preventDefault();
      video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
      break;
    case 'ArrowUp':
      e.preventDefault();
      video.volume = Math.min(1, video.volume + 0.05);
      break;
    case 'ArrowDown':
      e.preventDefault();
      video.volume = Math.max(0, video.volume - 0.05);
      break;
    case 'n': case 'N':
      if (State.currentIndex < State.flatLessons.length - 1) playLesson(State.currentIndex + 1);
      break;
    case 'p': case 'P':
      if (State.currentIndex > 0) playLesson(State.currentIndex - 1);
      break;
    case 'm': case 'M': {
      const lesson = State.flatLessons[State.currentIndex];
      if (lesson) toggleWatched(State.currentIndex, lesson.id);
      break;
    }
    case 'f': case 'F':
      if (video.requestFullscreen) video.requestFullscreen();
      break;
    case '.': case ']':
      setSpeed(State.speed + SPEED_STEP);
      break;
    case ',': case '[':
      setSpeed(State.speed - SPEED_STEP);
      break;
    case '0':
      setSpeed(1.0);
      break;
    case 't': case 'T':
      setTheater(!courseView.classList.contains('theater'));
      break;
  }
});

// ─── Shortcuts overlay ────────────────────────────────────────────────────
function toggleShortcutsOverlay() {
  shortcutsOverlay.classList.toggle('show');
}
function closeShortcutsOverlay() {
  shortcutsOverlay.classList.remove('show');
}

helpBtn.addEventListener('click', toggleShortcutsOverlay);

// Close on backdrop click
shortcutsOverlay.addEventListener('click', e => {
  if (e.target === shortcutsOverlay) closeShortcutsOverlay();
});
$('shortcuts-close-btn').addEventListener('click', closeShortcutsOverlay);

// ─── Notes ────────────────────────────────────────────────────────────────
let notesShowingPreview = false;

function loadNote(lesson) {
  notesEditor.value = lesson.note || '';
  notesPreview.innerHTML = '';
  if (notesShowingPreview) renderNotePreview();
  $('notes-status').textContent = '';
}

notesEditor.addEventListener('input', () => {
  clearTimeout(State.notesDebounce);
  $('notes-status').textContent = 'Saving…';
  State.notesDebounce = setTimeout(saveNote, 800);
  if (notesShowingPreview) renderNotePreview();
});

// Save immediately on blur
notesEditor.addEventListener('blur', () => {
  clearTimeout(State.notesDebounce);
  if (notesEditor.value !== (State.flatLessons[State.currentIndex]?.note || '')) {
    saveNote();
  }
});

function saveNote() {
  const lesson = State.flatLessons[State.currentIndex];
  if (!lesson) return;
  const text = notesEditor.value;
  lesson.note = text;
  fetch('/api/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ course: State.courseRel, lessonId: lesson.id, text }),
  }).then(() => {
    $('notes-status').textContent = 'Saved ✓';
    setTimeout(() => { $('notes-status').textContent = ''; }, 1500);
  }).catch(() => {
    $('notes-status').textContent = 'Error saving';
  });
}

$('notes-toggle-btn').addEventListener('click', () => {
  notesShowingPreview = !notesShowingPreview;
  $('notes-toggle-btn').textContent = notesShowingPreview ? 'Edit' : 'Preview';
  if (notesShowingPreview) {
    notesEditor.style.display = 'none';
    notesPreview.classList.add('show');
    renderNotePreview();
  } else {
    notesEditor.style.display = '';
    notesPreview.classList.remove('show');
  }
});

function renderNotePreview() {
  const text = notesEditor.value;
  if (window.marked) {
    notesPreview.innerHTML = marked.parse(text);
  } else {
    notesPreview.textContent = text;
  }
}

// ─── Materials ────────────────────────────────────────────────────────────
function loadMaterials(lesson) {
  materialsList.innerHTML = '';
  const mod  = findModuleForLesson(lesson.id);
  const mats = mod ? mod.materials : [];

  if (!mats || mats.length === 0) {
    materialsList.style.display = 'none';
    materialsEmpty.style.display = '';
  } else {
    materialsList.style.display = '';
    materialsEmpty.style.display = 'none';
    for (const mat of mats) {
      const url = '/media/' + encodeMediaPath(State.courseRel + '/' + mat.path);
      const li = document.createElement('li');
      li.innerHTML = `
        <a class="material-item" href="${url}" target="_blank" rel="noopener">
          <span class="material-icon">${materialIcon(mat.name)}</span>
          <span class="material-name" title="${escHtml(mat.name)}">${escHtml(mat.name)}</span>
          <span class="material-size">${fmtBytes(mat.size)}</span>
        </a>`;
      materialsList.appendChild(li);
    }
  }
}

function findModuleForLesson(lessonId) {
  if (!State.course) return null;
  for (const mod of State.course.modules) {
    if (mod.lessons.some(l => l.id === lessonId)) return mod;
  }
  return null;
}

// ─── Tabs ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  });
});

// ─── Back button ───────────────────────────────────────────────────────────
$('back-btn').addEventListener('click', () => {
  saveCurrentPosition(true);
  location.hash = '#/';
});

// ─── Export progress ──────────────────────────────────────────────────────
$('sidebar-export-btn').addEventListener('click', () => {
  if (!State.courseRel) return;
  const url = '/api/export?course=' + encodeURIComponent(State.courseRel);
  const a = document.createElement('a');
  a.href     = url;
  a.download = '.progress.json';
  a.click();
  toast('Progress exported!', 'success');
});

// ─── Import progress ──────────────────────────────────────────────────────
const importFileInput = $('import-file-input');

$('sidebar-import-btn').addEventListener('click', () => {
  if (!State.courseRel) return;
  importFileInput.value = '';
  importFileInput.click();
});

importFileInput.addEventListener('change', async () => {
  const file = importFileInput.files[0];
  if (!file) return;

  if (!confirm(`Import progress from "${file.name}"?\nThis will be merged with the course's current progress.`)) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await fetch('/api/import?course=' + encodeURIComponent(State.courseRel), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Import failed');
    toast('Progress imported! Reloading...', 'success');
    // Reload course to reflect new progress
    setTimeout(() => openCourse(State.courseRel), 800);
  } catch (e) {
    toast('Failed to import: ' + e.message, 'error');
  }
});

// ─── Theatre mode ─────────────────────────────────────────────────────────
function setTheater(on) {
  courseView.classList.toggle('theater', on);
  localStorage.setItem('theaterMode', on ? '1' : '');
}

$('theater-btn').addEventListener('click', () => {
  setTheater(!courseView.classList.contains('theater'));
});

function applyTheaterPreference() {
  setTheater(!!localStorage.getItem('theaterMode'));
}

// ─── Topbar logo → home ───────────────────────────────────────────────────
$('topbar-logo').addEventListener('click', () => { location.hash = '#/'; });
$('topbar-logo').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = '#/'; }
});

// ─── Init ──────────────────────────────────────────────────────────────────
(async () => {
  await loadLibrary();
  navigate(location.hash || '#/');
})();
