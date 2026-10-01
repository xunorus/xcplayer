/* XC Player — vanilla JS. Tracks en IndexedDB (blobs mp3), orden en localStorage. */
'use strict';

const APP_VERSION = '1.14';

// Cliente de YouTube que no exige PO token (evita "403 Forbidden" al bajar el audio).
// Si YouTube lo rompe: probar otro (android_vr, tv, ios) y "Actualizar yt-dlp" en Ajustes.
const YTDLP_ARGS = ['--extractor-args', 'youtube:player_client=android_sdkless'];
// Ante un 403 la app se auto-recupera: actualiza yt-dlp, reintenta, y prueba estos clientes.
const FALLBACK_CLIENTS = ['android_vr', 'tv', 'ios'];

const $ = s => document.querySelector(s);
const Cap = window.Capacitor;
const IS_NATIVE = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const YT = (IS_NATIVE && Cap.Plugins && Cap.Plugins.YtDlp) ? Cap.Plugins.YtDlp : null;
const UPDATER = (IS_NATIVE && Cap.Plugins && Cap.Plugins.Updater) ? Cap.Plugins.Updater : null;
const MEDIA = (IS_NATIVE && Cap.Plugins && Cap.Plugins.MediaSession) ? Cap.Plugins.MediaSession : null;
const DEFAULT_SERVER = 'http://192.168.1.33:8977';
const UPDATE_BASE = 'https://xunorus.github.io/xcplayer/'; // página de distribución (version.json + apk cifrado)

// 'local' = yt-dlp embebido en el APK; 'server' = la Mac descarga
const downloadMode = () => (YT && localStorage.getItem('xc-mode') !== 'server') ? 'local' : 'server';

// En web servida por server.js el origen ya es el server; en APK (o file://) se usa la URL guardada.
function serverBase() {
  if (!IS_NATIVE && location.protocol.startsWith('http')) return '';
  return (localStorage.getItem('xc-server') || DEFAULT_SERVER).replace(/\/$/, '');
}

/* ---------------- IndexedDB ---------------- */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('xcplayer', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('tracks', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const idb = {
  all: () => new Promise((res, rej) => {
    const r = db.transaction('tracks').objectStore('tracks').getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }),
  put: t => new Promise((res, rej) => {
    const r = db.transaction('tracks', 'readwrite').objectStore('tracks').put(t);
    r.onsuccess = res; r.onerror = () => rej(r.error);
  }),
  del: id => new Promise((res, rej) => {
    const r = db.transaction('tracks', 'readwrite').objectStore('tracks').delete(id);
    r.onsuccess = res; r.onerror = () => rej(r.error);
  }),
};

/* ---------------- estado ---------------- */
const tracks = new Map();          // id -> {id,title,size,duration,blob}
let order = [];                    // ids de la biblioteca, en orden
let playlists = [];                // [{id,name,ids:[trackId]}] — referencias: el blob no se duplica
let activeList = null;             // null = biblioteca | id de playlist (lo que se está mirando)
let playingFrom = null;            // de qué lista salió lo que suena (cambiar de vista no corta la cola)
let currentId = null;
let shuffle = localStorage.getItem('xc-shuffle') === '1';
let repeat = localStorage.getItem('xc-repeat') || 'all';   // all | one | off
const audio = new Audio();
let objectUrl = null;

const saveOrder = () => localStorage.setItem('xc-order', JSON.stringify(order));
const savePlaylists = () => localStorage.setItem('xc-playlists', JSON.stringify(playlists));
const plById = id => playlists.find(p => p.id === id) || null;

// ids de una lista (null = biblioteca), sin los tracks que ya no existen
function listIds(id) {
  if (id === null) return order;
  const p = plById(id);
  return p ? p.ids.filter(x => tracks.has(x)) : order;
}
const viewIds = () => listIds(activeList);    // lo que se ve
const queue = () => listIds(playingFrom);     // lo que se escucha

/* ---------------- utils ---------------- */
function fmtTime(s) {
  if (!isFinite(s) || s <= 0) return '0:00';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
function fmtBytes(b) {
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function probeDuration(blob) {
  return new Promise(res => {
    const a = new Audio();
    const u = URL.createObjectURL(blob);
    a.preload = 'metadata';
    a.onloadedmetadata = () => { URL.revokeObjectURL(u); res(a.duration || 0); };
    a.onerror = () => { URL.revokeObjectURL(u); res(0); };
    a.src = u;
  });
}

/* ---------------- log de descarga ---------------- */
const logEl = $('#log');
function log(line) {
  logEl.hidden = false;
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
  log.last = Date.now();
}

// latido: si el log queda mudo (conversión de un video largo, espera de YouTube),
// mostrar que sigue vivo en vez de parecer colgado
function startHeartbeat() {
  log.last = Date.now();
  return setInterval(() => {
    if (Date.now() - log.last > 20000) log('⏳ sigue trabajando… (video largo o conversión)');
  }, 5000);
}

// mixes/radios de YouTube (list=RD…) son playlists infinitas autogeneradas:
// casi nunca es lo que se quiso pegar → bajar solo el video
function isMixUrl(url) {
  try {
    const u = new URL(url);
    return /youtu/i.test(u.hostname) && !!u.searchParams.get('v') && /^RD/.test(u.searchParams.get('list') || '');
  } catch { return false; }
}

let cancelDl = null; // función de cancelación de la descarga en curso (null = no hay)
function setDownloading(cancelFn) {
  const btn = $('#btnAdd');
  cancelDl = cancelFn;
  btn.textContent = cancelFn ? '✕' : 'Agregar';
  btn.disabled = false;
  btn.classList.toggle('cancel', !!cancelFn);
}

/* ---------------- agregar / importar ---------------- */
async function saveTrackFromServer(name) {
  if (tracks.has(name)) { log(`• ya está: ${name}`); return; }
  log(`⬇ guardando local: ${name}`);
  const r = await fetch(serverBase() + '/music/' + encodeURIComponent(name));
  if (!r.ok) { log(`✗ error ${r.status} en ${name}`); return; }
  const blob = await r.blob();
  await saveTrackBlob(name, blob);
}

async function saveTrackBlob(name, blob) {
  const duration = await probeDuration(blob);
  const track = {
    id: name,
    title: name.replace(/\.mp3$/i, ''),
    size: blob.size,
    duration,
    blob,
    addedAt: Date.now(),
  };
  await idb.put(track);
  tracks.set(name, track);
  order.push(name);
  saveOrder();
  // bajando con una playlist abierta, lo nuevo entra también ahí (es lo que uno espera)
  const p = plById(activeList);
  if (p && !p.ids.includes(name)) { p.ids.push(name); savePlaylists(); }
  render();
}

async function addUrlLocal(url) {
  logEl.textContent = ''; logEl.hidden = false;
  log('🪂 descargando en el teléfono…');
  const mixArgs = [];
  if (isMixUrl(url)) {
    mixArgs.push('--no-playlist');
    log('• link de mix/radio de YouTube: bajo solo este video (los mix son casi infinitos)');
  }
  let cancelled = false;
  setDownloading(() => { cancelled = true; log('✖ cancelando…'); YT.cancel(); });
  const beat = startHeartbeat();

  // yt-dlp imprime la ruta del mp3 apenas termina cada ítem (after_move) →
  // lo guardamos y agregamos a la playlist sin esperar al resto de la playlist.
  const grabbed = new Set();
  const pending = [];
  async function grabFile(p) {
    const name = p.split('/').pop();
    if (grabbed.has(name)) return;
    grabbed.add(name);
    if (tracks.has(name)) { log(`• ya está: ${name}`); }
    else {
      log(`⬇ guardando local: ${name}`);
      const blob = await (await fetch(Cap.convertFileSrc(p))).blob();
      await saveTrackBlob(name, blob);
    }
    await YT.removeFile({ path: p }); // no duplicar espacio
  }
  const sub = await YT.addListener('progress', ev => {
    const l = (ev.line || '').trim();
    if (!l) return;
    if (l.startsWith('/') && l.toLowerCase().endsWith('.mp3')) {
      pending.push(grabFile(l).catch(e => log(`✗ ${e.message || e}`)));
    } else {
      log(l);
    }
  });
  try {
    const tryDl = args => YT.download({
      url,
      args: [...args, ...mixArgs, '--print', 'after_move:filepath', '--no-quiet', '--no-simulate'],
    });
    let res;
    try {
      res = await tryDl(YTDLP_ARGS);
    } catch (e) {
      // YouTube quema clientes/binarios viejos cada tanto → auto-recuperación
      if (cancelled || !/403|forbidden/i.test(String(e.message || e))) throw e;
      log('⚠ YouTube bloqueó la descarga (403) — actualizando yt-dlp…');
      try { const u = await YT.update(); log(`• yt-dlp ${u.version || '?'} (${u.status})`); }
      catch (e2) { log('• no se pudo actualizar: ' + (e2.message || e2)); }
      res = null;
      if (cancelled) throw e;
      try { res = await tryDl(YTDLP_ARGS); }
      catch { log('⚠ sigue el 403 — probando clientes alternativos…'); }
      for (const c of FALLBACK_CLIENTS) {
        if (res || cancelled) break;
        log(`→ cliente ${c}…`);
        try { res = await tryDl(['--extractor-args', `youtube:player_client=${c}`]); } catch {}
      }
      if (!res) throw new Error(cancelled ? 'cancelado' : 'YouTube bloqueó todos los clientes; reintentá en un rato');
    }
    await Promise.all(pending);
    // red de seguridad: lo que no haya llegado como línea impresa
    for (const f of res.files) {
      if (grabbed.has(f.name)) {
        // re-descargado en un reintento y ya guardado antes: liberar espacio
        await YT.removeFile({ path: f.path }).catch(() => {});
        continue;
      }
      await grabFile(f.path).catch(e => log(`✗ ${e.message || e}`));
    }
    if (!res.files.length && !grabbed.size) log('⚠ no se generaron mp3 nuevos');
    else log(`✔ listo: ${grabbed.size} track(s)`);
    $('#urlInput').value = '';
  } catch (e) {
    await Promise.all(pending); // guardar lo que alcanzó a terminar antes del corte
    if (cancelled) log(`✖ cancelado — ${grabbed.size} track(s) quedaron guardados`);
    else log(`✗ ${e.message || e}`);
  } finally {
    clearInterval(beat);
    sub.remove();
    setDownloading(null);
  }
}

async function addUrl(url) {
  if (downloadMode() === 'local') return addUrlLocal(url);
  logEl.textContent = ''; logEl.hidden = false;
  log('🪂 descargando en la Mac…');
  const noPlaylist = isMixUrl(url);
  if (noPlaylist) log('• link de mix/radio de YouTube: bajo solo este video (los mix son casi infinitos)');
  let cancelled = false;
  const ctrl = new AbortController();
  // cortar la conexión mata el yt-dlp en el server (req.on('close') → proc.kill())
  setDownloading(() => { cancelled = true; log('✖ cancelando…'); ctrl.abort(); });
  const beat = startHeartbeat();
  try {
    const r = await fetch(serverBase() + '/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, noPlaylist }),
      signal: ctrl.signal,
    });
    if (!r.ok || !r.body) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || `HTTP ${r.status}`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', done = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        let msg; try { msg = JSON.parse(l); } catch { continue; }
        if (msg.type === 'log') log(msg.line);
        if (msg.type === 'file') await saveTrackFromServer(msg.name); // agrega apenas termina cada track
        if (msg.type === 'done') done = msg;
      }
    }
    if (!done) throw new Error('el server cortó la conexión');
    if (done.error) throw new Error(done.error);
    if (!done.files.length) { log('⚠ no se generaron mp3 nuevos (¿ya estaban descargados? probá "Importar" en ajustes)'); }
    // red de seguridad: lo que no haya llegado como evento 'file' (server viejo, línea perdida)
    for (const f of done.files) if (!tracks.has(f.name)) await saveTrackFromServer(f.name);
    log(`✔ listo: ${done.files.length} track(s) agregados`);
    $('#urlInput').value = '';
  } catch (e) {
    if (cancelled) log('✖ cancelado — lo ya guardado queda en la playlist');
    else log(`✗ ${e.message} — ¿está corriendo el server en la Mac? (${serverBase() || location.origin})`);
  } finally {
    clearInterval(beat);
    setDownloading(null);
  }
}

async function importFolder() {
  const msg = $('#settingsMsg');
  msg.textContent = 'importando…';
  try {
    const r = await fetch(serverBase() + '/api/library');
    const list = await r.json();
    const missing = list.filter(t => !tracks.has(t.name));
    if (!missing.length) { msg.textContent = 'Nada nuevo: la app ya tiene todo lo de la carpeta.'; return; }
    $('#dlgSettings').close();
    logEl.textContent = ''; logEl.hidden = false;
    for (const t of missing) await saveTrackFromServer(t.name);
    log(`✔ importados ${missing.length} track(s)`);
  } catch (e) {
    msg.textContent = 'Error: ' + e.message;
  }
}

/* ---------------- render ---------------- */
function render() {
  const ids = viewIds();
  const ul = $('#playlist');
  ul.innerHTML = '';
  for (const id of ids) {
    const t = tracks.get(id);
    if (!t) continue;
    const li = document.createElement('li');
    li.dataset.id = id;
    if (id === currentId) {
      li.classList.add('playing');
      if (audio.paused) li.classList.add('paused');
    }
    li.innerHTML = `
      <div class="eq"><i></i><i></i><i></i></div>
      <div class="tr-main">
        <div class="tr-title"></div>
        <div class="tr-meta">${fmtTime(t.duration)} · ${fmtBytes(t.size)}</div>
      </div>
      <button class="tr-btn tr-add" title="Agregar a playlist">＋</button>
      <button class="tr-btn tr-del" title="${activeList ? 'Quitar de la playlist' : 'Eliminar de la app'}">✕</button>
      <button class="tr-btn tr-handle" title="Arrastrar">≡</button>`;
    li.querySelector('.tr-title').textContent = t.title;
    li.querySelector('.tr-main').addEventListener('click', () => playId(id));
    li.querySelector('.tr-add').addEventListener('click', e => { e.stopPropagation(); openAddDlg(id); });
    li.querySelector('.tr-del').addEventListener('click', e => {
      e.stopPropagation();
      // en la biblioteca se borra el archivo; en una playlist sólo se lo saca de ahí
      if (activeList) removeFromList(activeList, id); else removeTrack(id);
    });
    enableDrag(li, li.querySelector('.tr-handle'), ul, onTrackDrop);
    ul.appendChild(li);
  }
  const em = $('#empty');
  em.style.display = ids.length ? 'none' : 'block';
  em.innerHTML = activeList
    ? 'Playlist vacía.<br>Sumale tracks desde la biblioteca con ＋'
    : 'Sin música todavía.<br>Pegá un link arriba para despegar 🪂';
  $('#listName').textContent = activeList ? (plById(activeList) || {}).name || 'Playlist' : 'Biblioteca';
  $('#listCount').textContent = ids.length === 1 ? '1 track' : ids.length + ' tracks';
  renderLists();
  updateStats();
  updateNowPlaying();
}

function updateStats() {
  let dur = 0, size = 0;
  for (const id of order) {
    const t = tracks.get(id);
    if (t) { dur += t.duration; size += t.size; }
  }
  $('#statTracks').textContent = order.length;
  $('#statDuration').textContent = fmtTime(dur);
  $('#statSize').textContent = fmtBytes(size);
}

const setIcon = (sel, name) => $(sel + ' use').setAttribute('href', '#i-' + name);

function updateNowPlaying() {
  const t = tracks.get(currentId);
  $('#npTitle').textContent = t ? t.title : '—';
  setIcon('#btnPlay', audio.paused ? 'play' : 'pause');
  setIcon('#btnRepeat', repeat === 'one' ? 'repeat1' : 'repeat');
  $('#btnShuffle').classList.toggle('on', shuffle);
  $('#btnRepeat').classList.toggle('on', repeat !== 'off');
}

/* ---------------- playlists ----------------
   Las playlists son sólo listas de ids en localStorage: el mp3 vive una sola vez
   en IndexedDB y puede estar en varias listas sin ocupar más lugar. */
function onTrackDrop(ids) {
  if (activeList) {
    const p = plById(activeList);
    if (p) { p.ids = ids; savePlaylists(); }
  } else {
    order = ids;
    saveOrder();
  }
  updateStats();
}

function renderLists() {
  const lib = $('#libRow');
  lib.innerHTML = '';
  lib.appendChild(listRow(null, 'Biblioteca', order.length));
  const ul = $('#lists');
  ul.innerHTML = '';
  for (const p of playlists) ul.appendChild(listRow(p.id, p.name, listIds(p.id).length));
  $('#noLists').hidden = !!playlists.length;
}

function listRow(id, name, n) {
  const li = document.createElement('li');
  li.className = 'pl' + (activeList === id ? ' on' : '');
  li.dataset.pl = id || '';
  li.innerHTML = `
    <span class="pl-ico">${id ? '🎵' : '🗂'}</span>
    <div class="pl-main">
      <div class="pl-name"></div>
      <div class="pl-meta">${n === 1 ? '1 track' : n + ' tracks'}</div>
    </div>` + (id ? `
    <button class="pl-btn pl-ren" title="Renombrar">✎</button>
    <button class="pl-btn pl-del" title="Borrar playlist">✕</button>
    <button class="pl-btn pl-handle" title="Arrastrar">≡</button>` : '');
  li.querySelector('.pl-name').textContent = name;
  li.querySelector('.pl-main').addEventListener('click', () => selectList(id));
  li.querySelector('.pl-ico').addEventListener('click', () => selectList(id));
  if (id) {
    li.querySelector('.pl-ren').addEventListener('click', e => { e.stopPropagation(); renameList(id); });
    li.querySelector('.pl-del').addEventListener('click', e => { e.stopPropagation(); deleteList(id); });
    enableDrag(li, li.querySelector('.pl-handle'), $('#lists'), ids => {
      playlists = ids.map(plById).filter(Boolean);
      savePlaylists();
    });
  }
  return li;
}

function selectList(id) {
  activeList = id;
  localStorage.setItem('xc-list', id || '');
  setSide(false);
  render();
  $('#scroll').scrollTop = 0;
}

function newList(seed) {
  const name = (prompt('Nombre de la playlist:') || '').trim();
  if (!name) return null;
  const p = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    ids: seed ? [seed] : [],
  };
  playlists.push(p);
  savePlaylists();
  return p;
}

function renameList(id) {
  const p = plById(id);
  if (!p) return;
  const name = (prompt('Nombre de la playlist:', p.name) || '').trim();
  if (!name) return;
  p.name = name;
  savePlaylists();
  render();
}

function deleteList(id) {
  const p = plById(id);
  if (!p) return;
  if (!confirm(`¿Borrar la playlist «${p.name}»?\n(Los tracks quedan en la biblioteca)`)) return;
  playlists = playlists.filter(x => x !== p);
  savePlaylists();
  if (activeList === id) { activeList = null; localStorage.setItem('xc-list', ''); }
  if (playingFrom === id) playingFrom = null;   // la cola vuelve a la biblioteca sin cortar lo que suena
  render();
}

function removeFromList(listId, trackId) {
  const p = plById(listId);
  if (!p) return;
  p.ids = p.ids.filter(x => x !== trackId);
  savePlaylists();
  render();
}

/* diálogo "agregar a playlist": cada fila suma o quita */
let addTrackId = null;
function openAddDlg(id) {
  addTrackId = id;
  const t = tracks.get(id);
  $('#dlgAddTrack').textContent = t ? t.title : '';
  renderAddDlg();
  $('#dlgAdd').showModal();
}

function renderAddDlg() {
  const ul = $('#pickList');
  ul.innerHTML = '';
  for (const p of playlists) {
    const inIt = p.ids.includes(addTrackId);
    const li = document.createElement('li');
    li.innerHTML = `<button class="pick-row${inIt ? ' on' : ''}">
      <span class="pick-ck">${inIt ? '✓' : '＋'}</span>
      <span class="pick-name"></span>
      <span class="pick-n">${p.ids.length}</span></button>`;
    li.querySelector('.pick-name').textContent = p.name;
    li.querySelector('.pick-row').addEventListener('click', () => {
      if (inIt) p.ids = p.ids.filter(x => x !== addTrackId);
      else p.ids.push(addTrackId);
      savePlaylists();
      renderAddDlg();
      render();
    });
    ul.appendChild(li);
  }
  $('#pickEmpty').hidden = !!playlists.length;
}

/* ---------------- barra lateral (botón o swipe) ---------------- */
const sideEl = $('#side'), scrimEl = $('#scrim');
const sideOpen = () => document.body.classList.contains('side-open');
function setSide(open) {
  sideEl.classList.remove('dragging');
  scrimEl.classList.remove('dragging');
  sideEl.style.transform = '';   // fuera el inline del gesto: manda el CSS otra vez
  scrimEl.style.opacity = '';
  document.body.classList.toggle('side-open', open);
}

(function sideSwipe() {
  const EDGE = 28;   // cerrada sólo agarra desde el borde derecho; abierta, en cualquier parte
  const MIN = 8;     // px para decidir si el gesto es horizontal o es scroll
  let x0 = 0, y0 = 0, dx = 0, w = 300, tracking = false, axis = '';

  // no robarle el dedo al seek, al handle de arrastre ni a un diálogo abierto
  const skip = el => !!(el && el.closest && el.closest('input, dialog, .tr-handle, .pl-handle'));
  const pos = () => Math.max(0, Math.min(w, (sideOpen() ? 0 : w) + dx));

  document.addEventListener('touchstart', e => {
    tracking = false;
    if (e.touches.length !== 1 || skip(e.target)) return;
    const t = e.touches[0];
    if (!sideOpen() && t.clientX < window.innerWidth - EDGE) return;
    x0 = t.clientX; y0 = t.clientY; dx = 0; axis = ''; tracking = true;
    w = sideEl.getBoundingClientRect().width || 300;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!tracking) return;
    const t = e.touches[0];
    dx = t.clientX - x0;
    const dy = t.clientY - y0;
    if (!axis) {
      if (Math.abs(dx) < MIN && Math.abs(dy) < MIN) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis === 'y') { tracking = false; return; }   // era scroll vertical: soltar
      sideEl.classList.add('dragging');
      scrimEl.classList.add('dragging');
    }
    e.preventDefault();   // el dedo maneja la barra, no el scroll de la página
    const x = pos();
    sideEl.style.transform = `translateX(${x}px)`;
    scrimEl.style.opacity = String(1 - x / w);
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!tracking) return;
    tracking = false;
    if (axis !== 'x') return;
    // gesto rápido: manda la dirección; gesto corto: dónde quedó la barra
    setSide(Math.abs(dx) > 60 ? dx < 0 : pos() < w / 2);
  });
  document.addEventListener('touchcancel', () => {
    if (!tracking) return;
    tracking = false;
    setSide(sideOpen());
  });
})();

/* ---------------- reproducción ---------------- */
function playId(id, from) {
  const t = tracks.get(id);
  if (!t) return;
  playingFrom = from === undefined ? activeList : from;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(t.blob);
  currentId = id;
  localStorage.setItem('xc-last', id);
  audio.src = objectUrl;
  audio.play().catch(() => {});
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: 'XC Player' });
  }
  render();
}

function step(dir) {
  const q = queue();
  if (!q.length) return;
  if (shuffle && dir === 1 && q.length > 1) {
    let id;
    do { id = q[Math.floor(Math.random() * q.length)]; } while (id === currentId);
    return playId(id, playingFrom);
  }
  const i = q.indexOf(currentId);
  let n = i === -1 ? 0 : i + dir;
  if (n < 0) n = q.length - 1;
  if (n >= q.length) {
    if (repeat === 'off' && dir === 1) { audio.pause(); updateNowPlaying(); return; }
    n = 0;
  }
  playId(q[n], playingFrom);
}

function togglePlay() {
  if (!currentId) { const q = viewIds(); if (q.length) playId(q[0]); return; }
  if (!audio.src) return playId(currentId, playingFrom);
  if (audio.paused) audio.play(); else audio.pause();
}

audio.addEventListener('ended', () => {
  if (repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  step(1);
});
audio.addEventListener('play', render);
audio.addEventListener('pause', render);
audio.addEventListener('timeupdate', () => {
  if (!seeking && audio.duration) $('#seek').value = (audio.currentTime / audio.duration) * 1000;
  $('#tCur').textContent = fmtTime(audio.currentTime);
  $('#tTot').textContent = fmtTime(audio.duration);
});

let seeking = false;
$('#seek').addEventListener('input', () => { seeking = true; });
$('#seek').addEventListener('change', e => {
  if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration;
  seeking = false;
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
  navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
}

/* ---------------- controles en el sistema (notificación / Bluetooth) ----------------
   El WebView de Android NO publica navigator.mediaSession al sistema (eso solo lo hace
   Chrome como navegador), así que el plugin nativo MediaSession espeja este <audio> en
   una MediaSessionCompat real y devuelve los botones del sistema como eventos.        */
let lastMediaPush = 0;
function pushMedia(force) {
  if (!MEDIA) return;
  const t = tracks.get(currentId);
  if (!t) return;
  // el estado nativo extrapola la posición solo; con refrescarlo cada tanto alcanza
  const now = Date.now();
  if (!force && now - lastMediaPush < 5000) return;
  lastMediaPush = now;
  MEDIA.update({
    title: t.title,
    artist: 'XC Player',
    duration: isFinite(audio.duration) ? audio.duration : (t.duration || 0),
    position: audio.currentTime || 0,
    playing: !audio.paused,
  }).catch(() => {});
}

if (MEDIA) {
  ['play', 'pause', 'loadedmetadata', 'seeked'].forEach(ev =>
    audio.addEventListener(ev, () => pushMedia(true)));
  audio.addEventListener('timeupdate', () => pushMedia(false));

  MEDIA.addListener('mediaAction', ev => {
    switch (ev.action) {
      case 'play': audio.play().catch(() => {}); break;
      case 'pause': audio.pause(); break;
      case 'next': step(1); break;
      case 'prev': step(-1); break;
      case 'stop': audio.pause(); MEDIA.stop().catch(() => {}); break;
      case 'seek': if (isFinite(audio.duration)) audio.currentTime = ev.position; break;
    }
    render();
  });

  MEDIA.requestPermission().catch(() => {});
}

/* ---------------- eliminar ---------------- */
async function removeTrack(id) {
  const t = tracks.get(id);
  if (!t) return;
  if (!confirm(`¿Eliminar «${t.title}» de la app?\n(El archivo queda en la carpeta de la Mac)`)) return;
  if (id === currentId) {
    audio.pause(); audio.src = ''; currentId = null;
    if (MEDIA) MEDIA.stop().catch(() => {});
  }
  await idb.del(id);
  tracks.delete(id);
  order = order.filter(x => x !== id);
  saveOrder();
  let inSome = false;
  for (const p of playlists) {
    const n = p.ids.length;
    p.ids = p.ids.filter(x => x !== id);
    if (p.ids.length !== n) inSome = true;
  }
  if (inSome) savePlaylists();
  render();
}

/* ---------------- reordenar (drag en el handle) ----------------
   Sirve igual para los tracks de la lista y para las playlists de la barra:
   el que llama pasa el contenedor y qué hacer con el orden nuevo. */
function enableDrag(li, handle, list, onDrop) {
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    li.classList.add('drag');
    const move = ev => {
      const y = ev.clientY;
      const sibs = [...list.children].filter(x => x !== li);
      const next = sibs.find(s => { const r = s.getBoundingClientRect(); return y < r.top + r.height / 2; });
      list.insertBefore(li, next || null);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      li.classList.remove('drag');
      onDrop([...list.children].map(x => x.dataset.id || x.dataset.pl));
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
  });
}

/* ---------------- auto-actualización de la app ---------------- */
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function checkAppUpdate(manual) {
  if (!UPDATER) return;
  const b = $('#btnAppUpdate');
  b.hidden = false;
  if (manual) { b.disabled = true; b.textContent = '🔄 buscando…'; }
  try {
    const r = await fetch(UPDATE_BASE + 'version.json?t=' + Date.now());
    const info = await r.json();
    if (cmpVer(info.version, APP_VERSION) > 0) {
      b.dataset.ver = info.version;
      b.textContent = `⬆ Actualizar app a v${info.version}`;
    } else {
      delete b.dataset.ver;
      b.textContent = `✔ App al día (v${APP_VERSION})`;
    }
  } catch { // sin red o sin página
    delete b.dataset.ver;
    b.textContent = '🔄 Buscar actualización';
    if (manual) $('#settingsMsg').textContent = '✗ no se pudo consultar la página de descargas (¿sin internet?)';
  } finally {
    b.disabled = false;
  }
}

$('#btnAppUpdate').addEventListener('click', async () => {
  const msg = $('#settingsMsg');
  if (!$('#btnAppUpdate').dataset.ver) { checkAppUpdate(true); return; }
  const perm = await UPDATER.canInstall();
  if (!perm.ok) {
    msg.textContent = 'Permití "instalar apps desconocidas" para XC Player y volvé a tocar el botón.';
    await UPDATER.openInstallSettings();
    return;
  }
  const pass = localStorage.getItem('xc-dl-pass')
    || prompt('Contraseña de descarga (la de la página web):');
  if (!pass) return;
  const sub = await UPDATER.addListener('updateProgress', ev => {
    msg.textContent = (ev.phase === 'download' ? '⬇ bajando' : '🔓 descifrando') +
      (ev.pct >= 0 ? ` ${ev.pct}%` : '…');
  });
  $('#btnAppUpdate').disabled = true;
  try {
    await UPDATER.downloadAndInstall({ url: UPDATE_BASE + 'xcplayer.apk.enc', password: pass.trim() });
    localStorage.setItem('xc-dl-pass', pass.trim());
    msg.textContent = '✔ listo — confirmá la instalación de Android';
  } catch (e) {
    const m = String(e.message || e);
    if (/contraseña/i.test(m)) localStorage.removeItem('xc-dl-pass');
    msg.textContent = '✗ ' + m;
  } finally {
    sub.remove();
    $('#btnAppUpdate').disabled = false;
  }
});

/* ---------------- ajustes ---------------- */
const dlg = $('#dlgSettings');
/* con yt-dlp en el teléfono los controles de server (URL/probar/importar)
   no aplican — solo se muestran si el modo server está activo (o en web) */
function syncServerSection() {
  $('#serverSection').hidden = !!YT && downloadMode() !== 'server';
}
$('#btnSettings').addEventListener('click', () => {
  $('#serverInput').value = localStorage.getItem('xc-server') || DEFAULT_SERVER;
  $('#settingsMsg').textContent = '';
  $('#modeRow').hidden = !YT;
  $('#btnUpdateYt').hidden = !YT;
  $('#modeServer').checked = downloadMode() === 'server';
  syncServerSection();
  if (YT) YT.version()
    .then(r => { $('#btnUpdateYt').textContent = `Actualizar yt-dlp (${r.version})`; })
    .catch(() => {});
  checkAppUpdate();
  dlg.showModal();
});
$('#modeServer').addEventListener('change', e => {
  localStorage.setItem('xc-mode', e.target.checked ? 'server' : 'local');
  syncServerSection();
});
$('#btnUpdateYt').addEventListener('click', async () => {
  const msg = $('#settingsMsg');
  msg.textContent = 'actualizando yt-dlp… (puede tardar)';
  try {
    const r = await YT.update();
    msg.textContent = `✔ yt-dlp ${r.version || ''} (${r.status})`;
  } catch (e) {
    msg.textContent = '✗ ' + (e.message || e);
  }
});
dlg.addEventListener('close', () => {
  const v = $('#serverInput').value.trim();
  if (v) localStorage.setItem('xc-server', v);
});
$('#btnCloseSettings').addEventListener('click', () => dlg.close());
$('#btnTest').addEventListener('click', async () => {
  const v = $('#serverInput').value.trim().replace(/\/$/, '');
  if (v) localStorage.setItem('xc-server', v);
  const msg = $('#settingsMsg');
  msg.textContent = 'probando…';
  try {
    const r = await fetch((serverBase() || '') + '/api/ping');
    const j = await r.json();
    msg.textContent = j.app === 'xcplayer' ? '✔ conectado al server' : '✗ responde pero no es XC Player';
  } catch {
    msg.textContent = '✗ sin conexión — ¿corre "node server.js" en la Mac y están en la misma red?';
  }
});
$('#btnImport').addEventListener('click', importFolder);

/* ---------------- eventos de playlists ---------------- */
$('#btnLists').addEventListener('click', () => setSide(!sideOpen()));
$('#scrim').addEventListener('click', () => setSide(false));
$('#btnNewList').addEventListener('click', () => {
  const p = newList();
  if (p) selectList(p.id);   // recién creada, se abre: es lo que se venía a hacer
});
$('#btnPickNew').addEventListener('click', () => {
  if (newList(addTrackId)) { renderAddDlg(); render(); }
});
$('#btnPickClose').addEventListener('click', () => $('#dlgAdd').close());
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sideOpen()) setSide(false); });

/* Botón atrás de Android. Capacitor no lo reenvía al WebView, así que lo
   engancha MainActivity: si acá hay algo abierto lo cierra y devuelve true;
   si no, Android hace lo suyo (salir de la app). */
window.xcBack = function () {
  const open = document.querySelector('dialog[open]');
  if (open) { open.close(); return true; }
  if (sideOpen()) { setSide(false); return true; }
  return false;
};

/* ---------------- eventos UI ---------------- */
$('#btnAdd').addEventListener('click', () => {
  if (cancelDl) { const c = cancelDl; cancelDl = null; $('#btnAdd').disabled = true; c(); return; }
  const url = $('#urlInput').value.trim();
  if (!/^https?:\/\//i.test(url)) { log('✗ pegá un link válido (http/https)'); return; }
  addUrl(url);
});
$('#urlInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnAdd').click(); });
$('#btnPlay').addEventListener('click', togglePlay);
$('#btnPrev').addEventListener('click', () => step(-1));
$('#btnNext').addEventListener('click', () => step(1));
$('#btnShuffle').addEventListener('click', () => {
  shuffle = !shuffle;
  localStorage.setItem('xc-shuffle', shuffle ? '1' : '0');
  updateNowPlaying();
});
$('#btnRepeat').addEventListener('click', () => {
  repeat = repeat === 'all' ? 'one' : repeat === 'one' ? 'off' : 'all';
  localStorage.setItem('xc-repeat', repeat);
  updateNowPlaying();
});

/* ---------------- init ---------------- */
(async function init() {
  $('#appVer').textContent = 'v' + APP_VERSION;
  $('#appVer2').textContent = 'v' + APP_VERSION;
  db = await openDB();
  const all = await idb.all();
  for (const t of all) tracks.set(t.id, t);
  try { order = JSON.parse(localStorage.getItem('xc-order')) || []; } catch { order = []; }
  order = order.filter(id => tracks.has(id));
  for (const t of all) if (!order.includes(t.id)) order.push(t.id);
  saveOrder();
  try { playlists = JSON.parse(localStorage.getItem('xc-playlists')) || []; } catch { playlists = []; }
  if (!Array.isArray(playlists)) playlists = [];
  playlists = playlists
    .filter(p => p && typeof p.id === 'string' && typeof p.name === 'string')
    .map(p => ({ id: p.id, name: p.name, ids: Array.isArray(p.ids) ? p.ids : [] }));
  const savedList = localStorage.getItem('xc-list');
  activeList = savedList && plById(savedList) ? savedList : null;
  playingFrom = activeList;
  const last = localStorage.getItem('xc-last');
  if (last && tracks.has(last)) currentId = last;
  render();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
})();
