/* xcplayer-shop — vende XC Player por 1 dólar en cripto, sin intermediarios.
 *
 * Dos vías de pago, las dos sobre Base:
 *   · USDC (estable, sin cotización): transferencia ERC-20 a SELLER_ADDRESS.
 *   · ETH nativo por el equivalente a 1 USD: es la única que ChatWallet sabe
 *     prellenar (su formato ?pay=1 usa formatEther y exige una red nativa), así
 *     que el botón "Pagar con ChatWallet" va por acá, de un toque.
 *
 * El comprador paga desde la wallet que quiera y pega el hash; el Worker lo
 * verifica contra la cadena y entrega un enlace de descarga de un solo uso.
 * El APK vive en R2 y nunca es público: sólo sale por /dl con un token válido.
 */

// En pruebas: `wrangler dev --var ALLOWED_ORIGIN:http://localhost:8099`
const DEFAULT_ORIGIN = 'https://xunorus.github.io';
const RPC_URL = 'https://mainnet.base.org';
const CHAIN_ID = 8453;                                     // Base mainnet
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // USDC nativo, 6 decimales
const USDC_DECIMALS = 6;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SLIPPAGE = 0.98;      // el precio de ETH se mueve entre que cotizamos y que pagan
const QUOTE_HOURS = 2;      // cotizaciones que siguen valiendo al momento de verificar

// Mismo freno que en el Worker de métricas: esto es público y hace llamadas RPC.
const MAX_PER_MIN = 60;
let bucketMin = 0, bucketCount = 0;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), env);
    if (!ready(env)) return cors(json({ error: 'tienda no configurada' }, 503), env);
    if (req.method === 'GET' && url.pathname === '/price') return cors(await price(env), env);
    if (req.method === 'POST' && url.pathname === '/claim') return cors(await claim(req, env), env);
    if (req.method === 'GET' && url.pathname === '/dl') return download(url, env);
    return new Response('xcplayer-shop', { status: 404 });
  },
};

const ready = env => /^0x[0-9a-fA-F]{40}$/.test(env.SELLER_ADDRESS || '');
const seller = env => env.SELLER_ADDRESS.toLowerCase();

function cors(res, env) {
  res.headers.set('Access-Control-Allow-Origin', (env && env.ALLOWED_ORIGIN) || DEFAULT_ORIGIN);
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return res;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function rpc(method, params) {
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const out = await r.json();
  if (out.error) throw new Error(out.error.message || 'error de RPC');
  return out.result;
}

const big = hex => BigInt(hex || '0x0');
const addrFromTopic = t => '0x' + t.slice(-40).toLowerCase();

/* ---------------- precio ---------------- */

// Precio de ETH en USD. Dos fuentes: si la primera falla o devuelve algo raro,
// la segunda. Si fallan las dos, la vía USDC sigue funcionando igual.
async function ethUsd() {
  try {
    const r = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
    const v = Number((await r.json()).data.amount);
    if (v > 0) return v;
  } catch {}
  const r = await fetch('https://api.kraken.com/0/public/Ticker?pair=ETHUSD');
  const d = await r.json();
  const v = Number(Object.values(d.result)[0].c[0]);
  if (!(v > 0)) throw new Error('sin precio de ETH');
  return v;
}

const usdcUnits = env => BigInt(Math.round(Number(env.PRICE_USDC || '1') * 10 ** USDC_DECIMALS));

async function price(env) {
  const usd = Number(env.PRICE_USDC || '1');
  const out = {
    seller: seller(env),
    price_usd: usd,
    usdc: { chain: 'base', chainId: CHAIN_ID, address: USDC, decimals: USDC_DECIMALS, units: usdcUnits(env).toString() },
  };
  try {
    const rate = await ethUsd();
    const wei = BigInt(Math.round((usd / rate) * 1e18));
    const ref = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO quotes (ref, wei, rate, created) VALUES (?,?,?,?)')
      .bind(ref, wei.toString(), rate, Date.now()).run();
    out.eth = { chainId: CHAIN_ID, wei: wei.toString(), rate, ref };
    // Formato de solicitud de pago de ChatWallet: abre la app con todo cargado
    // (destino, red, monto) y le manda el resultado por XMTP a `reply`.
    out.chatwallet = 'https://chatwallet.org/dapp?pay=1'
      + '&to=' + seller(env) + '&chainId=' + CHAIN_ID + '&value=' + wei
      + '&reply=' + seller(env) + '&ref=' + ref
      + '&memo=' + encodeURIComponent('XC Player — licencia (' + usd + ' USD)');
  } catch {} // sin cotización: queda sólo la vía USDC
  return json(out);
}

/* ---------------- verificación del pago ---------------- */

async function claim(req, env) {
  const min = Math.floor(Date.now() / 60000);
  if (min !== bucketMin) { bucketMin = min; bucketCount = 0; }
  if (++bucketCount > MAX_PER_MIN) return json({ error: 'demasiados intentos, probá en un minuto' }, 429);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'pedido inválido' }, 400); }
  const tx = String(body.tx || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(tx)) return json({ error: 'Eso no parece un hash de transacción' }, 400);

  // ¿ya se usó? se devuelve la misma licencia: reclamar dos veces no es un error
  const prev = await env.DB.prepare('SELECT dl_token, uses_left, expires FROM orders WHERE tx = ?').bind(tx).first();
  if (prev) return json({ ok: true, again: true, dl: dlUrl(req, prev.dl_token), uses: prev.uses_left, expires: prev.expires });

  let receipt;
  try { receipt = await rpc('eth_getTransactionReceipt', [tx]); }
  catch { return json({ error: 'No pude consultar la cadena, probá de nuevo en un momento' }, 502); }
  if (!receipt) return json({ error: 'No encuentro esa transacción en Base. ¿Ya confirmó? ¿Era otra red?' }, 404);
  if (big(receipt.status) !== 1n) return json({ error: 'Esa transacción falló en la cadena' }, 400);

  const head = big(await rpc('eth_blockNumber'));
  const confs = head - big(receipt.blockNumber) + 1n;
  const need = BigInt(env.MIN_CONFIRMATIONS || '2');
  if (confs < need) return json({ error: `Recién confirmando (${confs}/${need}). Probá en unos segundos.`, retry: true }, 409);

  const paid = await checkUsdc(receipt, env) || await checkEth(tx, env);
  if (!paid) return json({ error: 'Esa transacción no es un pago válido a esta tienda (revisá destino, red y monto)' }, 400);

  const dl_token = crypto.randomUUID().replace(/-/g, '');
  const now = Date.now();
  const expires = now + Number(env.DOWNLOAD_DAYS || '30') * 864e5;
  const uses = Number(env.DOWNLOAD_USES || '3');
  try {
    await env.DB.prepare(
      'INSERT INTO orders (tx, payer, amount, token, chain, dl_token, uses_left, created, expires) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(tx, paid.payer, paid.amount, paid.token, 'base', dl_token, uses, now, expires).run();
  } catch {
    // carrera: dos claims del mismo hash a la vez — gana el primero
    const row = await env.DB.prepare('SELECT dl_token, uses_left, expires FROM orders WHERE tx = ?').bind(tx).first();
    if (row) return json({ ok: true, again: true, dl: dlUrl(req, row.dl_token), uses: row.uses_left, expires: row.expires });
    return json({ error: 'No pude registrar la compra, probá de nuevo' }, 500);
  }
  return json({ ok: true, dl: dlUrl(req, dl_token), uses, expires, token: paid.token });
}

const dlUrl = (req, t) => new URL('/dl?t=' + t, req.url).toString();

// Vía 1: transferencia de USDC a la dirección de cobro, por al menos el precio.
async function checkUsdc(receipt, env) {
  const want = usdcUnits(env);
  for (const log of receipt.logs || []) {
    if (log.address.toLowerCase() !== USDC) continue;
    if ((log.topics[0] || '').toLowerCase() !== TRANSFER_TOPIC) continue;
    if (addrFromTopic(log.topics[2]) !== seller(env)) continue;
    const amount = big(log.data);
    if (amount < want) continue;
    return { payer: addrFromTopic(log.topics[1]), amount: Number(amount), token: 'USDC' };
  }
  return null;
}

// Vía 2: ETH nativo por el equivalente al precio. Se acepta contra la cotización
// que le dimos al comprador (las de las últimas horas) o contra la de ahora, con
// una tolerancia: entre que cotizamos y que paga, el precio se mueve.
async function checkEth(tx, env) {
  const t = await rpc('eth_getTransactionByHash', [tx]);
  if (!t || (t.to || '').toLowerCase() !== seller(env)) return null;
  const value = big(t.value);
  if (value === 0n) return null;

  const since = Date.now() - QUOTE_HOURS * 3600e3;
  const q = await env.DB.prepare('SELECT MIN(CAST(wei AS INTEGER)) m FROM quotes WHERE created >= ?').bind(since).first();
  let need = q && q.m ? BigInt(q.m) : null;
  if (need === null) {
    try {
      const rate = await ethUsd();
      need = BigInt(Math.round((Number(env.PRICE_USDC || '1') / rate) * 1e18));
    } catch { return null; }
  }
  need = need * BigInt(Math.round(SLIPPAGE * 1000)) / 1000n;
  if (value < need) return null;
  return { payer: (t.from || '').toLowerCase(), amount: Number(value / 1000000000n), token: 'ETH' };
}

/* ---------------- entrega ---------------- */

async function download(url, env) {
  const t = (url.searchParams.get('t') || '').trim();
  if (!/^[0-9a-f]{32}$/.test(t)) return new Response('enlace inválido', { status: 400 });

  const row = await env.DB.prepare('SELECT uses_left, expires FROM orders WHERE dl_token = ?').bind(t).first();
  if (!row) return new Response('enlace inválido', { status: 404 });
  if (Date.now() > row.expires) return new Response('el enlace venció — escribime y te lo renuevo', { status: 410 });
  if (row.uses_left <= 0) return new Response('el enlace ya se usó — escribime y te lo renuevo', { status: 410 });

  const obj = await env.APK.get('xcplayer.apk');
  if (!obj) return new Response('el archivo no está disponible', { status: 503 });

  // se descuenta recién cuando hay archivo para entregar
  await env.DB.prepare('UPDATE orders SET uses_left = uses_left - 1 WHERE dl_token = ? AND uses_left > 0').bind(t).run();

  return new Response(obj.body, {
    headers: {
      'content-type': 'application/vnd.android.package-archive',
      'content-disposition': 'attachment; filename="xcplayer.apk"',
      'content-length': String(obj.size),
      'cache-control': 'no-store',
    },
  });
}
