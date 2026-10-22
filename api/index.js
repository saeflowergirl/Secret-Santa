// One function, routed by ?a=<action>. Storage: Upstash Redis REST when env is set, else local .data.json.
const crypto = require('crypto');
const fs = require('fs');

const BUDGET = 500;
const MAX_ITEMS = 5;
const SHOP = /(^|\.)(takealot\.com|amazon\.[a-z.]+|temu\.com)$/;
const U = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const T = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
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

async function preview(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('That is not a link'); }
  if (!/^https?:$/.test(u.protocol) || !SHOP.test(u.hostname)) throw new Error('Only takealot.com and amazon links are allowed');
  const item = { url: u.href, title: '', image: '', description: '', price: 0 };
  try {
    const r = await fetch(u.href, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'accept-language': 'en' }, signal: AbortSignal.timeout(8000) });
    if (SHOP.test(new URL(r.url).hostname)) {
      const html = (await r.text()).slice(0, 600000);
      item.title = meta(html, 'og:title') || decode((/<title[^>]*>([^<]*)/i.exec(html) || [])[1] || '');
      item.image = meta(html, 'og:image');
      item.description = meta(html, 'og:description') || meta(html, 'description');
      // Only trust a scraped price on takealot (Rand); amazon.com is usually dollars.
      if (/takealot\.com$/.test(u.hostname)) item.price = Number(meta(html, 'product:price:amount') || (/"price"\s*:\s*"?(\d+(\.\d+)?)/.exec(html) || [])[1]) || 0;
    }
  } catch { /* blocked or slow: fall back to the link slug below */ }
  if (!item.title) {
    const seg = u.pathname.split('/').filter((s) => s && !/^(dp|gp|product)$/i.test(s) && !/^(PLID|B0)\w+$/i.test(s)).sort((x, y) => y.length - x.length)[0] || u.hostname;
    item.title = decodeURIComponent(seg).replace(/-g-\d+\.html$/i, '').replace(/[-_]+/g, ' ');
  }
  item.title = item.title.split(' | ')[0].replace(/\s*-\s*Temu.*$/i, '').slice(0, 200); item.description = item.description.slice(0, 400);
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
        if (pair.length !== 2 || miss) return send(res, 400, { error: `Couple names must match the name list: ${miss || pair.join(' + ')}` });
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
      const name = clean(b.name, 40), partner = clean(b.partner, 40);
      if (!name || game.players.length >= 40 || game.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) return send(res, 400, { error: 'Name is missing or already in the group' });
      if (partner && !game.players.some((p) => p.name === partner)) return send(res, 400, { error: 'Partner must already be in the group' });
      const couples = [...(game.couples || []), ...(partner ? [[name, partner]] : [])];
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
        return { url: u.href, title: clean(i.title, 200), image: clean(i.image, 600), description: clean(i.description, 400), price: Math.max(0, Number(i.price) || 0) };
      });
      await set(`s:${game.id}:${idx}`, st);
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'Unknown action' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
};
