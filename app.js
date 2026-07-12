/* XC Player — vanilla JS. Tracks en IndexedDB (blobs mp3), orden en localStorage. */
'use strict';

const APP_VERSION = '1.8';

// Cliente de YouTube que no exige PO token (evita "403 Forbidden" al bajar el audio).
// Si YouTube lo rompe: probar otro (android_vr, tv, ios) y "Actualizar yt-dlp" en Ajustes.
const YTDLP_ARGS = ['--extractor-args', 'youtube:player_client=android_sdkless'];
// Ante un 403 la app se auto-recupera: actualiza yt-dlp, reintenta, y prueba estos clientes.
const FALLBACK_CLIENTS = ['android_vr', 'tv', 'ios'];

const $ = s => document.querySelector(s);
const Cap = window.Capacitor;
const IS_NATIVE = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const YT = (IS_NATIVE && Cap.Plugins && Cap.Plugins.YtDlp) ? Cap.Plugins.YtDlp : null;
const DEFAULT_SERVER = 'http://192.168.1.33:8977';

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
let order = [];                    // ids en orden de playlist
let currentId = null;
let shuffle = localStorage.getItem('xc-shuffle') === '1';
let repeat = localStorage.getItem('xc-repeat') || 'all';   // all | one | off
const audio = new Audio();
let objectUrl = null;

const saveOrder = () => localStorage.setItem('xc-order', JSON.stringify(order));

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
  const ul = $('#playlist');
  ul.innerHTML = '';
  for (const id of order) {
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
      <button class="tr-btn tr-del" title="Eliminar">✕</button>
      <button class="tr-btn tr-handle" title="Arrastrar">≡</button>`;
    li.querySelector('.tr-title').textContent = t.title;
    li.querySelector('.tr-main').addEventListener('click', () => playId(id));
    li.querySelector('.tr-del').addEventListener('click', e => { e.stopPropagation(); removeTrack(id); });
    enableDrag(li, li.querySelector('.tr-handle'));
    ul.appendChild(li);
  }
  $('#empty').style.display = order.length ? 'none' : 'block';
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

function updateNowPlaying() {
  const t = tracks.get(currentId);
  $('#npTitle').textContent = t ? t.title : '—';
  $('#btnPlay').textContent = audio.paused ? '▶' : '⏸';
  $('#btnShuffle').classList.toggle('on', shuffle);
  $('#btnRepeat').classList.toggle('on', repeat !== 'off');
  $('#btnRepeat').textContent = repeat === 'one' ? '🔂' : '🔁';
}

/* ---------------- reproducción ---------------- */
function playId(id) {
  const t = tracks.get(id);
  if (!t) return;
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
  if (!order.length) return;
  if (shuffle && dir === 1 && order.length > 1) {
    let id;
    do { id = order[Math.floor(Math.random() * order.length)]; } while (id === currentId);
    return playId(id);
  }
  const i = order.indexOf(currentId);
  let n = i === -1 ? 0 : i + dir;
  if (n < 0) n = order.length - 1;
  if (n >= order.length) {
    if (repeat === 'off' && dir === 1) { audio.pause(); updateNowPlaying(); return; }
    n = 0;
  }
  playId(order[n]);
}

function togglePlay() {
  if (!currentId) { if (order.length) playId(order[0]); return; }
  if (!audio.src) return playId(currentId);
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

/* ---------------- eliminar ---------------- */
async function removeTrack(id) {
  const t = tracks.get(id);
  if (!t) return;
  if (!confirm(`¿Eliminar «${t.title}» de la app?\n(El archivo queda en la carpeta de la Mac)`)) return;
  if (id === currentId) { audio.pause(); audio.src = ''; currentId = null; }
  await idb.del(id);
  tracks.delete(id);
  order = order.filter(x => x !== id);
  saveOrder();
  render();
}

/* ---------------- reordenar (drag en el handle) ---------------- */
function enableDrag(li, handle) {
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    const list = $('#playlist');
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
      order = [...list.children].map(x => x.dataset.id);
      saveOrder();
      updateStats();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
  });
}

/* ---------------- ajustes ---------------- */
const dlg = $('#dlgSettings');
$('#btnSettings').addEventListener('click', () => {
  $('#serverInput').value = localStorage.getItem('xc-server') || DEFAULT_SERVER;
  $('#settingsMsg').textContent = '';
  $('#modeRow').hidden = !YT;
  $('#btnUpdateYt').hidden = !YT;
  $('#modeServer').checked = downloadMode() === 'server';
  if (YT) YT.version()
    .then(r => { $('#btnUpdateYt').textContent = `Actualizar yt-dlp (${r.version})`; })
    .catch(() => {});
  dlg.showModal();
});
$('#modeServer').addEventListener('change', e => {
  localStorage.setItem('xc-mode', e.target.checked ? 'server' : 'local');
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
$('#btnCloseSettings').addEventListener('click', () => {
  const v = $('#serverInput').value.trim();
  if (v) localStorage.setItem('xc-server', v);
  dlg.close();
});
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
  const last = localStorage.getItem('xc-last');
  if (last && tracks.has(last)) currentId = last;
  render();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
})();
