/* xcplayer-stats — cuenta descargas del APK sin saber quién descarga.
 *
 * Lo único que sale del navegador es el tipo de evento; el Worker le suma el día,
 * el país (que Cloudflare ya trae en request.cf) y una plataforma gruesa derivada
 * del user-agent, que se mira y se tira. No se guarda IP, ni user-agent, ni
 * referer, ni nada que sobreviva a recargar la página.
 */

// De dónde se aceptan eventos. En pruebas locales se sobreescribe sin tocar el
// código: `wrangler dev --var ALLOWED_ORIGIN:http://localhost:8099`.
const DEFAULT_ORIGIN = 'https://xunorus.github.io';
const EVENTS = new Set(['page_view', 'dl_start', 'dl_ok', 'dl_badpass', 'dl_err',
                        'buy_view', 'buy_ok', 'buy_fail']);
const SRCS = new Set(['invite', 'manual']);

// Freno anti-spam: el endpoint es público y el repo también, así que cualquiera
// puede inflar los números. Esto no lo impide, sólo evita que una avalancha se
// coma la cuota de D1. Vive en el isolate: se reinicia solo y no guarda a nadie.
const MAX_PER_MIN = 240;
let bucketMin = 0, bucketCount = 0;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), env);
    if (req.method === 'POST' && url.pathname === '/e') return cors(await collect(req, env), env);
    if (req.method === 'GET' && url.pathname === '/stats') return dashboard(url, env);
    return new Response('xcplayer-stats', { status: 404 });
  },
};

function cors(res, env) {
  res.headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || DEFAULT_ORIGIN);
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  res.headers.set('Access-Control-Max-Age', '86400');
  return res;
}

// YYYY-MM-DD en hora argentina (UTC-3 fijo, Argentina no tiene horario de verano)
const artDay = ts => new Date(ts - 3 * 3600e3).toISOString().slice(0, 10);

const clean = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);

function platform(ua) {
  if (!ua) return 'other';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Windows|Macintosh|X11|Linux/i.test(ua)) return 'desktop';
  return 'other';
}

async function collect(req, env) {
  const min = Math.floor(Date.now() / 60000);
  if (min !== bucketMin) { bucketMin = min; bucketCount = 0; }
  if (++bucketCount > MAX_PER_MIN) return new Response(null, { status: 429 });

  let body;
  try { body = await req.json(); } catch { return new Response(null, { status: 400 }); }
  if (!body || !EVENTS.has(body.ev)) return new Response(null, { status: 400 });

  const ts = Date.now();
  const ms = Number.isFinite(body.ms) ? Math.min(Math.max(0, Math.round(body.ms)), 36e5) : null;

  try {
    await env.DB.prepare(
      'INSERT INTO ev (ts, day, ev, ver, src, plat, country, sid, ms) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(
      ts,
      artDay(ts),
      body.ev,
      clean(body.ver, /^[0-9][0-9.]{0,9}$/),
      SRCS.has(body.src) ? body.src : null,
      platform(req.headers.get('user-agent')),
      clean(req.cf && req.cf.country, /^[A-Z]{2}$/),
      clean(body.sid, /^[a-z0-9]{1,16}$/),
      ms
    ).run();
  } catch {
    return new Response(null, { status: 500 }); // la página ignora el error igual
  }
  return new Response(null, { status: 204 });
}

/* ---------------- dashboard ---------------- */

// Comparación de largo constante: que un token equivocado no filtre cuánto acertó.
function tokenOk(given, real) {
  if (typeof given !== 'string' || !real || given.length !== real.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ real.charCodeAt(i);
  return diff === 0;
}

const q = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).all().then(r => r.results || []);

async function dashboard(url, env) {
  if (!tokenOk(url.searchParams.get('k'), env.STATS_TOKEN))
    return new Response('nope', { status: 401 });

  const today = artDay(Date.now());
  const since = n => artDay(Date.now() - n * 864e5);

  const [totals, d7, d30, daily, bySrc, byVer, byCountry, byPlat, times, starts, oks] = await Promise.all([
    q(env, "SELECT ev, COUNT(*) n FROM ev GROUP BY ev"),
    q(env, "SELECT ev, COUNT(*) n FROM ev WHERE day >= ? GROUP BY ev", since(6)),
    q(env, "SELECT ev, COUNT(*) n FROM ev WHERE day >= ? GROUP BY ev", since(29)),
    q(env, "SELECT day, SUM(ev='page_view') visitas, SUM(ev='dl_start') iniciadas, SUM(ev='dl_ok') ok" +
           " FROM ev WHERE day >= ? GROUP BY day ORDER BY day DESC", since(29)),
    q(env, "SELECT COALESCE(src,'—') src, COUNT(*) n FROM ev WHERE ev='dl_ok' GROUP BY src ORDER BY n DESC"),
    q(env, "SELECT COALESCE(ver,'—') ver, COUNT(*) n FROM ev WHERE ev='dl_ok' GROUP BY ver ORDER BY n DESC"),
    q(env, "SELECT COALESCE(country,'—') c, COUNT(*) n FROM ev WHERE ev='dl_ok' GROUP BY country ORDER BY n DESC LIMIT 12"),
    q(env, "SELECT COALESCE(plat,'—') p, COUNT(*) n FROM ev WHERE ev='dl_ok' GROUP BY plat ORDER BY n DESC"),
    q(env, "SELECT ms FROM ev WHERE ev='dl_ok' AND ms > 0 ORDER BY ts DESC LIMIT 200"),
    q(env, "SELECT DISTINCT sid FROM ev WHERE ev='dl_start' AND sid IS NOT NULL AND day >= ?", since(29)),
    q(env, "SELECT DISTINCT sid FROM ev WHERE ev='dl_ok' AND sid IS NOT NULL AND day >= ?", since(29)),
  ]);

  const n = (rows, ev) => (rows.find(r => r.ev === ev) || {}).n || 0;
  const pct = (a, b) => (b ? Math.round(a / b * 100) + '%' : '—');

  const msList = times.map(r => r.ms).sort((a, b) => a - b);
  const median = msList.length ? msList[Math.floor(msList.length / 2)] : 0;

  const done = new Set(oks.map(r => r.sid));
  const abandoned = starts.filter(r => !done.has(r.sid)).length;

  const maxDay = Math.max(1, ...daily.map(d => d.visitas));
  const rows = daily.map(d => `<tr${d.day === today ? ' class="hoy"' : ''}>
      <td>${d.day}${d.day === today ? ' <span class="tag">hoy</span>' : ''}</td>
      <td class="bar"><i style="width:${d.visitas / maxDay * 100}%"></i>${d.visitas}</td>
      <td>${d.iniciadas}</td><td class="ok">${d.ok}</td>
      <td>${pct(d.ok, d.visitas)}</td></tr>`).join('');

  const list = (arr, key) => arr.length
    ? arr.map(r => `<li><b>${esc(String(r[key]))}</b> <span>${r.n}</span></li>`).join('')
    : '<li class="dim">todavía nada</li>';

  const html = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>XC Player · descargas</title>
<style>
:root{--bg:#0b1220;--card:#121c2e;--line:#24344f;--fg:#e8eefc;--dim:#8ba0c4;--accent:#4da3ff;--ok:#3ddc97}
*{box-sizing:border-box}
body{margin:0;padding:18px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,sans-serif}
h1{font-size:1.1rem;margin:0 0 2px}
.sub{color:var(--dim);font-size:.78rem;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.kpi b{display:block;font-size:1.6rem;line-height:1.2}
.kpi span{color:var(--dim);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px;overflow-x:auto}
h2{font-size:.82rem;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;margin:0 0 10px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:left;color:var(--dim);font-weight:500;font-size:.72rem;padding:4px 8px 4px 0}
td{padding:4px 8px 4px 0;border-top:1px solid var(--line);white-space:nowrap}
td.bar{position:relative;min-width:110px}
td.bar i{position:absolute;left:0;top:3px;bottom:3px;background:#1d3b63;border-radius:3px;z-index:0}
td.bar{z-index:1}
td.ok{color:var(--ok)}
.hoy td{background:#16233a}
.tag{color:var(--accent);font-size:.68rem}
ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}
li{background:#0e1728;border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:.8rem}
li span{color:var(--dim)}
.dim{color:var(--dim)}
.note{color:var(--dim);font-size:.72rem;line-height:1.6;margin-top:18px}
</style>
<h1>XC Player · descargas</h1>
<div class="sub">horario argentino · ${esc(today)}</div>

<div class="grid">
  <div class="kpi"><b class="ok">${n(totals, 'dl_ok')}</b><span>descargas totales</span></div>
  <div class="kpi"><b>${n(d30, 'dl_ok')}</b><span>últimos 30 días</span></div>
  <div class="kpi"><b>${n(d7, 'dl_ok')}</b><span>últimos 7 días</span></div>
  <div class="kpi"><b>${pct(n(totals, 'dl_ok'), n(totals, 'page_view'))}</b><span>visita → descarga</span></div>
  <div class="kpi"><b>${median ? (median / 1000).toFixed(0) + 's' : '—'}</b><span>tiempo mediano</span></div>
  <div class="kpi"><b>${abandoned}</b><span>iniciadas sin completar (30d)</span></div>
  <div class="kpi"><b>${n(totals, 'dl_badpass')}</b><span>contraseña incorrecta</span></div>
  <div class="kpi"><b>${n(totals, 'dl_err')}</b><span>errores de descarga</span></div>
</div>

<div class="card">
  <h2>Por día (30 días)</h2>
  <table>
    <tr><th>día</th><th>visitas</th><th>iniciadas</th><th>completadas</th><th>conv.</th></tr>
    ${rows || '<tr><td colspan="5" class="dim">todavía nada</td></tr>'}
  </table>
</div>

<div class="card"><h2>Invitación vs. manual</h2><ul>${list(bySrc, 'src')}</ul></div>
<div class="card"><h2>Versión descargada</h2><ul>${list(byVer, 'ver')}</ul></div>
<div class="card"><h2>País</h2><ul>${list(byCountry, 'c')}</ul></div>
<div class="card"><h2>Plataforma</h2><ul>${list(byPlat, 'p')}</ul></div>

<p class="note">
  Sin IP, sin user-agent guardado, sin id de dispositivo: las "abandonadas" se
  calculan con un número al azar que la página genera en cada carga y se olvida al
  recargar. El endpoint es público, así que los números son de buena fe.
</p>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
