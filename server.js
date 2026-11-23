'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!DATABASE_URL || !ADMIN_PASSWORD) {
  console.error('Missing DATABASE_URL or ADMIN_PASSWORD environment variable.');
  process.exit(1);
}
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('crm|' + ADMIN_PASSWORD).digest('hex');

const useSsl = process.env.PGSSL ? process.env.PGSSL !== 'false' : /\.render\.com/.test(DATABASE_URL);
const pool = new Pool({ connectionString: DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : false });

// ---------- small helpers ----------
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const rid = () => crypto.randomBytes(10).toString('hex');
const wrap = (f) => (req, res, next) => f(req, res, next).catch(next);

function parseCookies(h) {
  const o = {};
  (h || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) { try { o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (e) { /* ignore */ } }
  });
  return o;
}
function setCookie(req, res, name, value, maxAgeSec) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + maxAgeSec];
  if (req.secure) flags.push('Secure');
  res.append('Set-Cookie', name + '=' + encodeURIComponent(value) + '; ' + flags.join('; '));
}

// ---------- data rules ----------
const COLLECTIONS = ['registrations', 'sessions', 'documents'];
const PUBLIC_READ = ['sessions', 'documents'];
const FIELDS = {
  registrations: ['name', 'ministry', 'phone', 'role', 'accom', 'status', 'created', 'self', 'd1', 'd2', 'd3'],
  sessions: ['date', 'time', 'title', 'speaker', 'track', 'venue', 'order'],
  documents: ['title', 'desc', 'assetId', 'url', 'order'],
};
function clean(coll, d) {
  const o = {};
  d = d || {};
  for (const k of FIELDS[coll]) {
    const v = d[k];
    if (typeof v === 'string') o[k] = v.slice(0, 500);
    else if (typeof v === 'number' || typeof v === 'boolean') o[k] = v;
  }
  if (coll === 'registrations' && 'status' in o && !['Confirmed', 'Pending'].includes(o.status)) o.status = 'Pending';
  return o;
}
async function getDoc(coll, id) {
  const r = await pool.query('select data from docs where coll=$1 and id=$2', [coll, id]);
  return r.rows[0] ? r.rows[0].data : null;
}
async function putDoc(coll, id, data) {
  await pool.query(
    'insert into docs(coll,id,data) values($1,$2,$3) on conflict(coll,id) do update set data=excluded.data',
    [coll, id, data]
  );
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use(express.json({ limit: '100kb' }));

// Who is this visitor? Anonymous signed visitor id + optional organiser session.
app.use((req, res, next) => {
  const c = parseCookies(req.headers.cookie);
  let vid = null;
  if (c.crm_vid) {
    const [id, sig] = c.crm_vid.split('.');
    if (id && sig && safeEq(sig, hmac('vid|' + id))) vid = id;
  }
  if (!vid) {
    vid = crypto.randomBytes(16).toString('hex');
    setCookie(req, res, 'crm_vid', vid + '.' + hmac('vid|' + vid), 60 * 60 * 24 * 365);
  }
  req.vid = vid;
  req.admin = false;
  if (c.crm_admin) {
    const [exp, sig] = c.crm_admin.split('.');
    if (exp && sig && Number(exp) > Date.now() && safeEq(sig, hmac('admin|' + exp))) req.admin = true;
  }
  next();
});

// Basic CSRF guard: every write must come from our own page script.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'crm') return res.status(403).json({ error: 'Request blocked.' });
  next();
});
const adminOnly = (req, res, next) => (req.admin ? next() : res.status(403).json({ error: 'Organisers only.' }));

// Login attempts limiter (per IP)
const attempts = new Map();
function loginLimiter(req, res, next) {
  const now = Date.now();
  let a = attempts.get(req.ip);
  if (!a || a.reset < now) a = { n: 0, reset: now + 15 * 60 * 1000 };
  if (a.n >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  a.n++;
  attempts.set(req.ip, a);
  next();
}

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/api/me', wrap(async (req, res) => {
  let name = '';
  if (req.admin) name = 'Organiser';
  else {
    const r = await getDoc('registrations', req.vid);
    if (r && r.name) name = r.name;
  }
  res.set('Cache-Control', 'no-store').json({ id: req.vid, name, admin: req.admin });
}));

app.post('/api/login', loginLimiter, (req, res) => {
  if (!safeEq(String((req.body || {}).password || ''), ADMIN_PASSWORD)) return res.status(401).json({ error: 'Incorrect password.' });
  const exp = String(Date.now() + 3 * 24 * 3600 * 1000);
  setCookie(req, res, 'crm_admin', exp + '.' + hmac('admin|' + exp), 3 * 24 * 3600);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  setCookie(req, res, 'crm_admin', '', 0);
  res.json({ ok: true });
});

// List a collection
app.get('/api/c/:coll', wrap(async (req, res) => {
  const coll = req.params.coll;
  if (!COLLECTIONS.includes(coll)) return res.status(404).json({ error: 'Not found.' });
  if (!PUBLIC_READ.includes(coll) && !req.admin) return res.status(403).json({ error: 'Organisers only.' });
  const r = await pool.query('select id,data from docs where coll=$1', [coll]);
  res.set('Cache-Control', 'no-store').json(r.rows.map((x) => ({ id: x.id, data: x.data })));
}));

// Add to a collection (organisers)
app.post('/api/c/:coll', adminOnly, wrap(async (req, res) => {
  const coll = req.params.coll;
  if (!COLLECTIONS.includes(coll)) return res.status(404).json({ error: 'Not found.' });
  const data = clean(coll, req.body);
  const id = rid();
  await putDoc(coll, id, data);
  res.json({ id });
}));

// One document
app.get('/api/d/:coll/:id', wrap(async (req, res) => {
  const { coll, id } = req.params;
  if (!COLLECTIONS.includes(coll)) return res.status(404).json({ error: 'Not found.' });
  const allowed = PUBLIC_READ.includes(coll) || req.admin || (coll === 'registrations' && id === req.vid);
  if (!allowed) return res.status(403).json({ error: 'Not allowed.' });
  const data = await getDoc(coll, id);
  res.set('Cache-Control', 'no-store').json(data ? { id, data } : { id: null });
}));

app.put('/api/d/:coll/:id', wrap(async (req, res) => {
  const { coll, id } = req.params;
  if (!COLLECTIONS.includes(coll)) return res.status(404).json({ error: 'Not found.' });
  if (req.admin) {
    await putDoc(coll, id, clean(coll, req.body));
    return res.json({ ok: true });
  }
  // Attendees may only create/update their OWN registration, and only name/ministry/phone.
  if (coll !== 'registrations' || id !== req.vid) return res.status(403).json({ error: 'Not allowed.' });
  const b = clean('registrations', req.body);
  if (!b.name || !b.ministry) return res.status(400).json({ error: 'Enter your name and your ministry or church.' });
  const old = (await getDoc('registrations', id)) || {};
  await putDoc('registrations', id, {
    ...old,
    name: b.name,
    ministry: b.ministry,
    phone: b.phone || '',
    status: old.status || 'Pending',
    created: old.created || Date.now(),
    self: true,
  });
  res.json({ ok: true });
}));

app.patch('/api/d/:coll/:id', adminOnly, wrap(async (req, res) => {
  const { coll, id } = req.params;
  if (!COLLECTIONS.includes(coll)) return res.status(404).json({ error: 'Not found.' });
  const old = await getDoc(coll, id);
  if (!old) return res.status(404).json({ error: 'Not found.' });
  await putDoc(coll, id, { ...old, ...clean(coll, req.body) });
  res.json({ ok: true });
}));

app.delete('/api/d/:coll/:id', adminOnly, wrap(async (req, res) => {
  const { coll, id } = req.params;
  if (!COLLECTIONS.includes(coll)) return res.status(404).json({ error: 'Not found.' });
  await pool.query('delete from docs where coll=$1 and id=$2', [coll, id]);
  res.json({ ok: true });
}));

// PDF files
app.post('/api/upload', adminOnly, express.raw({ type: 'application/pdf', limit: '25mb' }), wrap(async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.slice(0, 4).toString() !== '%PDF') {
    return res.status(400).json({ error: 'Only PDF files can be uploaded.' });
  }
  let name = 'document.pdf';
  try { name = decodeURIComponent(req.get('X-Filename') || name).slice(0, 200); } catch (e) { /* keep default */ }
  const id = rid();
  await pool.query('insert into files(id,name,mime,data) values($1,$2,$3,$4)', [id, name, 'application/pdf', buf]);
  res.json({ id, url: '/files/' + id });
}));
app.delete('/api/file/:id', adminOnly, wrap(async (req, res) => {
  await pool.query('delete from files where id=$1', [req.params.id]);
  res.json({ ok: true });
}));
app.get('/files/:id', wrap(async (req, res) => {
  const r = await pool.query('select mime,data from files where id=$1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).send('Not found');
  res.set({ 'Content-Type': r.rows[0].mime, 'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store' });
  res.send(r.rows[0].data);
}));

// Static site (the app itself)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, p) { if (/sw\.js$/.test(p)) res.set('Cache-Control', 'no-cache'); },
}));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

(async () => {
  await pool.query(`create table if not exists docs(
    coll text not null, id text not null, data jsonb not null,
    created_at timestamptz default now(), primary key(coll,id))`);
  await pool.query(`create table if not exists files(
    id text primary key, name text, mime text, data bytea not null,
    created_at timestamptz default now())`);
  app.listen(PORT, () => console.log('CRM app listening on ' + PORT));
})().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
