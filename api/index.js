// One function, routed by ?a=<action>. Storage: Upstash Redis REST when env is set, else local .data.json.
const crypto = require('crypto');
const fs = require('fs');

const BUDGET = 500;
const MAX_ITEMS = 5;
const SHOP = /(^|\.)(takealot\.com|amazon\.[a-z.]+|temu\.com)$/;
// Vercel may prefix the integration's env vars (e.g. STORAGE_KV_REST_API_URL), so match on the suffix.
const env = (suffix) => process.env[Object.keys(process.env).find((k) => k.endsWith(suffix)) || ''];
const U = env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL');
const T = env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN');
const FILE = '.data.json';

const redis = (cmd) => fetch(U, { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: JSON.stringify(cmd) }).then((r) => r.json());
const readFile = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {});

async function get(k) {
  if (U) { const r = await redis(['GET', k]); return r.result ? JSON.parse(r.result) : null; }
  return readFile()[k] ?? null;
}
async function set(k, v) {
  if (U) return redis(['SET', k, JSON.stringify(v)]);
  const d = readFile(); d[k] = v; fs.writeFileSync(FILE, JSON.stringify(d));
}

async function del(k) {
  if (U) return redis(['DEL', k]);
  const d = readFile(); delete d[k]; fs.writeFileSync(FILE, JSON.stringify(d));
}

const rand = (n) => crypto.randomBytes(n).toString('hex');
const clean = (s, n) => String(s ?? '').trim().slice(0, n);

// Shuffle until nobody draws themselves or their partner. ponytail: retry loop, fine for party-sized groups.
const badPair = (couples) => (a, b) => a === b || couples.some((c) => c.includes(a) && c.includes(b));
function draw(names, couples) {
  const bad = badPair(couples);
  for (let t = 0; t < 5000; t++) {
    const to = names.map((_, i) => i);
    for (let i = to.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [to[i], to[j]] = [to[j], to[i]]; }
    if (names.every((n, i) => !bad(n, names[to[i]]))) return to;
  }
  return null;
}

async function load(t) {
  const id = String(t || '').split('.')[0];
  if (!/^[a-f0-9]{8}$/.test(id)) return null;
  const game = await get('g:' + id);
  if (!game) return null;
  const idx = game.players.findIndex((p) => p.token === t);
  return { game, host: game.hostToken === t, idx };
}
const state = async (game, i) => (await get(`s:${game.id}:${i}`)) || { items: [], revealed: false };

async function meView(game, idx) {
  const st = await state(game, idx);
  const out = { title: game.title, name: game.players[idx].name, names: game.players.map((p) => p.name), budget: BUDGET, maxItems: MAX_ITEMS, items: st.items, revealed: st.revealed };
  if (st.revealed) {
    const ti = game.players[idx].target;
    out.target = { name: game.players[ti].name, items: (await state(game, ti)).items };
  }
  return out;
}

const decode = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function meta(html, key) {
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html);
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i').exec(html);
  return decode((a || b || [])[1] || '');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// Bot-check and generic landing pages must never be saved as if they were the product.
const BLOCKED = /^(just a moment|attention required|access denied|page not found|robot check|sorry! something went wrong|amazon\.[a-z.]+\s*:\s*sorry|takealot\.com: online shopping|temu\b)/i;
const blocked = (t) => BLOCKED.test(t) || /^amazon\.[a-z.]+$/i.test(t);
const text = (html) => decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

async function preview(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('That is not a link'); }
  if (!/^https?:$/.test(u.protocol) || !SHOP.test(u.hostname)) throw new Error('Only takealot.com, amazon and temu links are allowed');
  const item = { url: u.href, title: '', image: '', description: '', price: 0 };
  const plid = /PLID(\d+)/i.exec(u.pathname)?.[1];
  try {
    if (plid && /takealot\.com$/.test(u.hostname)) {
      // Takealot's site sits behind a bot check, but its product API answers plain requests.
      const d = await fetch(`https://api.takealot.com/rest/v-1-11-0/product-details/PLID${plid}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) }).then((r) => r.json());
      item.title = d.core?.title || d.title || '';
      item.image = String(d.gallery?.images?.[0] || '').replace('{size}', 'pdpxl');
      item.description = text(d.description?.html);
      item.price = Number(d.buybox?.items?.[0]?.price) || 0;
    } else {
      const r = await fetch(u.href, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-ZA,en;q=0.9' }, signal: AbortSignal.timeout(8000) });
      if (SHOP.test(new URL(r.url).hostname)) {
        const html = (await r.text()).slice(0, 1500000);
        const pageTitle = decode((/<title[^>]*>([^<]*)/i.exec(html) || [])[1] || '').trim();
        if (!blocked(pageTitle)) {
          item.title = text((/id="productTitle"[^>]*>([\s\S]*?)<\/span>/i.exec(html) || [])[1]) || meta(html, 'og:title') || pageTitle;
          item.image = meta(html, 'og:image') || (/"hiRes":"(https:[^"]+)"/.exec(html) || /id="landingImage"[^>]*src="([^"]+)"/i.exec(html) || [])[1] || '';
          item.description = meta(html, 'og:description') || meta(html, 'description');
          // Only trust a scraped price when it is certainly Rand (amazon.com is dollars).
          if (/amazon\.co\.za$/.test(u.hostname)) item.price = Number((/a-offscreen">\s*R\s?([\d\s,]+(?:\.\d+)?)/.exec(html) || [])[1]?.replace(/[\s,]/g, '')) || 0;
        }
      }
    }
  } catch { /* blocked or slow: fall back to the link name below, and the person can edit it */ }
  if (blocked(item.title)) { item.title = ''; item.image = ''; item.description = ''; }
  const asin = /amazon\./.test(u.hostname) && /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/.exec(u.pathname)?.[1];
  if (asin && !item.image) {
    try {
      const url = `https://images-na.ssl-images-amazon.com/images/P/${asin}.01.LZZZZZZZ.jpg`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if ((r.headers.get('content-type') || '').startsWith('image/jpeg') && (await r.arrayBuffer()).byteLength > 1000) item.image = url; // a missing product returns a 43-byte blank gif
    } catch { /* no photo: the person can paste one */ }
  }  if (!item.title) {
    const seg = u.pathname.split('/').filter((s) => s && !/^(dp|gp|product|goods\.html)$/i.test(s) && !/^(PLID|B0)\w+$/i.test(s) && !/^ref=/i.test(s)).sort((x, y) => y.length - x.length)[0] || '';
    item.title = seg ? decodeURIComponent(seg).replace(/-g-\d+\.html$/i, '').replace(/[-_]+/g, ' ') : (asin ? 'Amazon item' : 'Item') + ' (add name)';
  }
  item.title = item.title.split(' | ')[0].replace(/\s*-\s*Temu.*$/i, '').slice(0, 200);
  item.description = item.description.slice(0, 400);
  if (!/^https?:\/\//.test(item.image)) item.image = '';
  return item;
}
const send = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };

async function body(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  let s = ''; for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

module.exports = async (req, res) => {
  try {
    const q = new URL(req.url, 'http://x').searchParams;
    const a = q.get('a');
    const b = req.method === 'POST' ? await body(req) : {};

    if (a === 'create') {
      const names = [...new Set((b.names || []).map((n) => clean(n, 40)).filter(Boolean))];
      if (names.length < 3 || names.length > 40) return send(res, 400, { error: 'Need between 3 and 40 different names' });
      const couples = [];
      for (const c of b.couples || []) {
        const pair = c.map((n) => clean(n, 40));
        const miss = pair.find((n) => !names.includes(n));
        if (pair.length < 2 || miss) return send(res, 400, { error: `Couple names must match the name list: ${miss || pair.join(' + ')}` });
        couples.push(pair);
      }
      const to = draw(names, couples);
      if (!to) return send(res, 400, { error: 'No valid draw exists with those couples' });
      const id = rand(4);
      const game = { id, title: clean(b.title, 60) || 'Secret Santa', couples, hostToken: id + '.h' + rand(8), players: names.map((name, i) => ({ name, token: id + '.' + rand(8), target: to[i] })) };
      await set('g:' + id, game);
      return send(res, 200, { host: game.hostToken });
    }

    if (a === 'preview') {
      if (!(await load(q.get('t')))) return send(res, 403, { error: 'Bad link' });
      return send(res, 200, await preview(q.get('url')));
    }

    const ctx = await load(q.get('t') || b.t);
    if (!ctx) return send(res, 403, { error: 'Bad link' });
    const { game, host, idx } = ctx;

    // Remove the game and every player's saved state for good. Host link only.
    if (a === 'delete') {
      if (!host) return send(res, 403, { error: 'Host only' });
      await Promise.all([del('g:' + game.id), ...game.players.map((_, i) => del(`s:${game.id}:${i}`))]);
      return send(res, 200, { ok: true });
    }

    if (a === 'host') {
      if (!host) return send(res, 403, { error: 'Host only' });
      const players = await Promise.all(game.players.map(async (p, i) => {
        const st = await state(game, i);
        return { name: p.name, token: p.token, gives: game.players[p.target].name, revealed: st.revealed, items: st.items };
      }));
      return send(res, 200, { title: game.title, players, budget: BUDGET });
    }

    // Add someone after the draw: splice them into the ring (A->B becomes A->new->B) so nobody else's draw changes.
    if (a === 'add') {
      if (!host) return send(res, 403, { error: 'Host only' });
      const name = clean(b.name, 40), partners = (b.partners || []).map((n) => clean(n, 40));
      if (!name || game.players.length >= 40 || game.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) return send(res, 400, { error: 'Name is missing or already in the group' });
      if (partners.some((n) => !game.players.some((p) => p.name === n))) return send(res, 400, { error: 'Partners must already be in the group' });
      const couples = [...(game.couples || []), ...(partners.length ? [[name, ...partners]] : [])];
      const bad = badPair(couples);
      const states = await Promise.all(game.players.map((_, i) => state(game, i)));
      const spots = game.players.map((_, i) => i).filter((i) => !states[i].revealed && !bad(game.players[i].name, name) && !bad(name, game.players[game.players[i].target].name));
      if (!spots.length) return send(res, 400, { error: 'No safe spot (people have already spun). Use Redraw instead.' });
      const i = spots[Math.floor(Math.random() * spots.length)];
      game.players.push({ name, token: game.id + '.' + rand(8), target: game.players[i].target });
      game.players[i].target = game.players.length - 1;
      game.couples = couples;
      await set('g:' + game.id, game);
      return send(res, 200, { ok: true });
    }

    // Fresh draw for everyone; wish lists are kept, spins are reset.
    if (a === 'redraw') {
      if (!host) return send(res, 403, { error: 'Host only' });
      const to = draw(game.players.map((p) => p.name), game.couples || []);
      if (!to) return send(res, 400, { error: 'No valid draw exists with those couples' });
      game.players.forEach((p, i) => { p.target = to[i]; });
      await set('g:' + game.id, game);
      await Promise.all(game.players.map(async (_, i) => set(`s:${game.id}:${i}`, { ...(await state(game, i)), revealed: false })));
      return send(res, 200, { ok: true });
    }

    if (idx < 0) return send(res, 403, { error: 'Players only' });

    if (a === 'me') return send(res, 200, await meView(game, idx));

    if (a === 'reveal') {
      const st = await state(game, idx);
      st.revealed = true;
      await set(`s:${game.id}:${idx}`, st);
      return send(res, 200, await meView(game, idx));
    }

    if (a === 'items') {
      const st = await state(game, idx);
      st.items = (b.items || []).slice(0, MAX_ITEMS).map((i) => {
        const u = new URL(i.url);
        if (!/^https?:$/.test(u.protocol) || !SHOP.test(u.hostname)) throw new Error('Bad item link');
        return { url: u.href, title: clean(i.title, 200), image: /^https?:\/\//.test(i.image) ? clean(i.image, 600) : '', description: clean(i.description, 400), price: Math.max(0, Number(i.price) || 0) };
      });
      await set(`s:${game.id}:${idx}`, st);
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'Unknown action' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
};
