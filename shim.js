/* Replaces claude.ai's built-in db / user / assets with this site's own server. */
(function () {
  'use strict';
  const HDR = { 'X-Requested-With': 'crm' };
  async function api(path, opt) {
    opt = opt || {};
    const r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opt, { headers: Object.assign({}, HDR, opt.headers || {}) }));
    if (!r.ok) {
      let m = 'Something went wrong. Please try again.';
      try { m = (await r.json()).error || m; } catch (e) { /* keep default */ }
      const err = new Error(m); err.status = r.status; throw err;
    }
    return r.json();
  }
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  // Live updates: poll every 5s, only call back when data really changed.
  const runners = new Set();
  const refreshAll = () => runners.forEach((f) => f());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
  function watch(fetcher, cb, errcb) {
    let last = null;
    const run = async () => {
      try {
        const x = await fetcher(), s = JSON.stringify(x);
        if (s !== last) { last = s; cb(x); }
      } catch (e) { if (errcb) errcb(e); }
    };
    run();
    const t = setInterval(() => { if (!document.hidden) run(); }, 5000);
    runners.add(run);
    return () => { clearInterval(t); runners.delete(run); };
  }
  const write = async (p) => { const r = await p; refreshAll(); return r; };

  const db = {
    collection: (name) => ({
      add: (data) => write(api('/api/c/' + name, json('POST', data))),
      onSnapshot: (cb, err) => watch(
        () => api('/api/c/' + name),
        (rows) => cb({ docs: rows.map((r) => ({ id: r.id, data: () => r.data })) }),
        err
      ),
    }),
    doc: (path) => {
      const [coll, id] = path.split('/');
      const url = '/api/d/' + coll + '/' + encodeURIComponent(id);
      return {
        set: (data) => write(api(url, json('PUT', data))),
        update: (data) => write(api(url, json('PATCH', data))),
        delete: () => write(api(url, { method: 'DELETE' })),
        onSnapshot: (cb, err) => watch(
          () => api(url),
          (r) => cb({ exists: !!r.id, id: r.id || id, data: () => r.data }),
          err
        ),
      };
    },
  };

  let meP = null;
  const me = () => (meP = meP || api('/api/me'));
  const usr = {
    canEdit: async () => !!(await me()).admin,
    me: async () => { const m = await me(); return { id: m.id, name: m.name }; },
  };

  const assets = {
    upload: (file) => write(api('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name || 'document.pdf') },
      body: file,
    })),
    delete: (id) => write(api('/api/file/' + id, { method: 'DELETE' })),
  };

  window.claude = { use: async (n) => ({ db, user: usr, assets }[n]) };

  // ----- organiser login / logout, and install button -----
  document.addEventListener('click', async (e) => {
    const a = e.target.closest && e.target.closest('[data-act="login"],[data-act="logout"],[data-act="install"]');
    if (!a) return;
    const k = a.dataset.act, er = document.getElementById('le');
    try {
      if (k === 'login') {
        const pw = document.getElementById('pw');
        await api('/api/login', json('POST', { password: pw ? pw.value : '' }));
        location.reload();
      } else if (k === 'logout') {
        await api('/api/logout', json('POST'));
        location.hash = '#dash'; location.reload();
      } else if (k === 'install' && window.__installEvt) {
        window.__installEvt.prompt(); window.__installEvt = null; a.remove();
      }
    } catch (x) { if (er) er.textContent = x.message; }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.id === 'pw') {
      const b = document.querySelector('[data-act="login"]'); if (b) b.click();
    }
  });

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.__installEvt = e; });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
