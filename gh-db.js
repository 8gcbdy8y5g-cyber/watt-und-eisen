/* watt & eisen: Datenschicht für die Seite außerhalb von Claude.
   Ersetzt window.claude.use('db') durch JSON-Dateien im privaten GitHub-Repo.
   Eine Datei pro Sammlung: data/<sammlung>.json, Schlüssel = Dokument-ID.
   Der Zugriffs-Token liegt nur im localStorage dieses Geräts. */
(function () {
  if (window.claude) return;

  var OWNER = '8gcbdy8y5g-cyber', REPO = 'watt-und-eisen-daten', BRANCH = 'main';
  var TRAINER_URL = 'https://claude.ai/artifact/WQnUNSNSEaAunm3VJuYCEL';
  var TK = 'we-gh-token', POLL_MS = 45000;
  var API = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/data/';

  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (_) {} }
  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function stable(v) {
    if (Array.isArray(v)) return v.map(stable);
    if (isObj(v)) { var o = {}; Object.keys(v).sort().forEach(function (k) { o[k] = stable(v[k]); }); return o; }
    return v;
  }
  function b64e(s) {
    var b = new TextEncoder().encode(s), bin = '';
    for (var i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64d(s) {
    var bin = atob(String(s).replace(/\s/g, '')), b = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(b);
  }
  function merge(dst, patch) {
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (isObj(v) && v.__delete__ === true) delete dst[k];
      else if (isObj(v) && isObj(dst[k])) merge(dst[k], v);
      else dst[k] = clone(v);
    });
    return dst;
  }
  function err(code, message, status) { var e = new Error(message || code); e.code = code; if (status) e.status = status; return e; }

  // ---------- Zugriff ----------
  function token() { return lsGet(TK) || ''; }
  function headers() {
    return { Authorization: 'Bearer ' + token(), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  }
  function call(url, opt) {
    opt = opt || {};
    var h = headers(); if (opt.headers) Object.keys(opt.headers).forEach(function (k) { h[k] = opt.headers[k]; });
    return fetch(url, { method: opt.method || 'GET', headers: h, body: opt.body, cache: 'no-cache' }).then(function (r) {
      if (r.status === 401) { authFailed(); throw err('auth', 'Der Zugriff wurde abgelehnt.', 401); }
      if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') throw err('rate_limited', 'GitHub bremst gerade.', 403);
      return r;
    }, function () { throw err('network', 'Keine Verbindung.'); });
  }

  // ---------- Sammlungen ----------
  var cols = {};
  function col(name) {
    if (cols[name]) return cols[name];
    var c = cols[name] = { name: name, server: null, local: null, inflight: [], q: [], flushing: false, listeners: [], loading: null };
    var cached = lsGet('we-c-' + name);
    if (cached) { try { var p = JSON.parse(cached); c.server = { data: p.data || {}, sha: p.sha || null }; c.local = clone(c.server.data); } catch (_) {} }
    return c;
  }
  function saveCache(c) { if (c.server) lsSet('we-c-' + c.name, JSON.stringify({ data: c.server.data, sha: c.server.sha })); }
  function rebuild(c) {
    c.local = clone(c.server ? c.server.data : {});
    c.inflight.concat(c.q).forEach(function (m) { m.fn(c.local); });
  }
  function load(c) {
    if (c.loading) return c.loading;
    c.loading = call(API + c.name + '.json?ref=' + BRANCH).then(function (r) {
      if (r.status === 404) { c.server = { data: {}, sha: null }; return; }
      if (!r.ok) throw err('http', 'GitHub antwortet mit ' + r.status + '.', r.status);
      return r.json().then(function (j) {
        var txt = j.encoding === 'base64' && j.content ? Promise.resolve(b64d(j.content))
          : call(API + c.name + '.json?ref=' + BRANCH, { headers: { Accept: 'application/vnd.github.raw+json' } }).then(function (r2) { return r2.text(); });
        return txt.then(function (t) { c.server = { data: t.trim() ? JSON.parse(t) : {}, sha: j.sha }; });
      });
    }).then(function () { saveCache(c); rebuild(c); c.loading = null; notify(c); }, function (e) { c.loading = null; throw e; });
    return c.loading;
  }
  function ready(c) { return c.server ? Promise.resolve() : load(c); }

  function put(c, data, sha) {
    var body = { message: 'App: ' + c.name + ' ' + new Date().toISOString().slice(0, 16).replace('T', ' '), content: b64e(JSON.stringify(stable(data), null, 1) + '\n'), branch: BRANCH };
    if (sha) body.sha = sha;
    return call(API + c.name + '.json', { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }).then(function (r) {
      if (r.ok) return r.json().then(function (j) { return j.content.sha; });
      throw err(r.status === 409 || r.status === 422 ? 'conflict' : 'http', 'Speichern fehlgeschlagen (' + r.status + ').', r.status);
    });
  }
  function flush(c) {
    if (c.flushing) return; c.flushing = true;
    (function loop() {
      if (!c.q.length) { c.flushing = false; return; }
      var batch = c.inflight = c.q.splice(0), tries = 0;
      function done(e) {
        c.inflight = [];
        batch.forEach(function (m) { e ? m.rej(e) : m.res(); });
        if (e) { rebuild(c); notify(c); }
        loop();
      }
      (function attempt() {
        var base = clone(c.server.data);
        batch.forEach(function (m) { m.fn(base); });
        put(c, base, c.server.sha).then(function (sha) {
          c.server = { data: base, sha: sha }; saveCache(c); rebuild(c); notify(c); done();
        }, function (e) {
          if (e.code === 'conflict' && ++tries < 4) { c.loading = null; return load(c).then(attempt, done); }
          done(e);
        });
      })();
    })();
  }
  function write(name, fn) {
    var c = col(name);
    return ready(c).then(function () {
      return new Promise(function (res, rej) {
        c.q.push({ fn: fn, res: res, rej: rej });
        rebuild(c); notify(c); flush(c);
      });
    });
  }

  // ---------- Abfragen und Beobachter ----------
  function docSnap(id, data) { return { id: id, exists: data !== undefined, data: function () { return data === undefined ? undefined : clone(data); } }; }
  function querySnap(c, q) {
    var ids = Object.keys(c.local || {}), docs;
    if (q.field) {
      ids.sort(function (a, b) {
        var x = (c.local[a] || {})[q.field], y = (c.local[b] || {})[q.field];
        return x === y ? 0 : (x > y ? 1 : -1) * (q.dir === 'desc' ? -1 : 1);
      });
    } else ids.sort();
    if (q.max) ids = ids.slice(0, q.max);
    docs = ids.map(function (id) { return docSnap(id, c.local[id]); });
    return { docs: docs, size: docs.length, empty: !docs.length, forEach: function (f) { docs.forEach(f); } };
  }
  function notify(c) {
    c.listeners.slice().forEach(function (l) {
      var snap = l.make(), key = JSON.stringify(snap.docs ? snap.docs.map(function (d) { return [d.id, d.data()]; }) : [snap.id, snap.data()]);
      if (key === l.last) return; l.last = key;
      try { l.cb(snap); } catch (_) {}
    });
  }
  function listen(name, make, cb, onErr) {
    var c = col(name), l = { make: function () { return make(c); }, cb: cb, last: null };
    c.listeners.push(l);
    if (c.server) notify(c);
    load(c).then(null, function (e) { if (!c.server && onErr) onErr(e); });
    return function () { c.listeners = c.listeners.filter(function (x) { return x !== l; }); };
  }
  function poll() {
    if (document.visibilityState === 'hidden') return;
    Object.keys(cols).forEach(function (n) {
      var c = cols[n]; if (!c.listeners.length || c.flushing || c.q.length || c.loading) return;
      load(c).then(null, function () {});
    });
  }
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', poll);
  window.addEventListener('online', poll);

  function Query(name, o) {
    this.orderBy = function (f, d) { return new Query(name, { field: f, dir: d || 'asc', max: o.max }); };
    this.limit = function (n) { return new Query(name, { field: o.field, dir: o.dir, max: n }); };
    this.get = function () { var c = col(name); return ready(c).then(function () { return querySnap(c, o); }); };
    this.onSnapshot = function (cb, onErr) { return listen(name, function (c) { return querySnap(c, o); }, cb, onErr); };
  }
  function Doc(path) {
    var p = path.split('/'), name = p[0], id = p.slice(1).join('~');
    return {
      id: id,
      get: function () { var c = col(name); return ready(c).then(function () { return docSnap(id, c.local[id]); }); },
      set: function (data) { var d = clone(data); return write(name, function (m) { m[id] = clone(d); }); },
      update: function (patch) { var d = clone(patch); return write(name, function (m) { m[id] = merge(isObj(m[id]) ? m[id] : {}, d); }); },
      delete: function () { return write(name, function (m) { delete m[id]; }); },
      onSnapshot: function (cb, onErr) { return listen(name, function (c) { return docSnap(id, c.local[id]); }, cb, onErr); }
    };
  }
  var db = {
    collection: function (n) { return new Query(n, {}); },
    doc: function (path) { return Doc(path); }
  };

  // ---------- Datei sichern ----------
  var downloads = {
    save: function (o) {
      return new Promise(function (res, rej) {
        try {
          var blob = o.data instanceof Blob ? o.data : new Blob([typeof o.data === 'string' ? o.data : JSON.stringify(o.data)], { type: 'application/json' });
          var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = o.filename || 'datei.json';
          document.body.appendChild(a); a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000); res();
        } catch (e) { rej(err('unavailable', 'Sichern geht hier nicht.')); }
      });
    }
  };

  // ---------- Token-Abfrage ----------
  var overlay = null;
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function askToken(msg) {
    return new Promise(function (resolve) {
      if (overlay) overlay.remove();
      overlay = document.createElement('div');
      overlay.id = 'we-token'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0B1428;color:#fff;display:flex;align-items:center;justify-content:center;padding:24px;font-family:"Inter Tight",-apple-system,BlinkMacSystemFont,sans-serif';
      overlay.innerHTML = '<form style="max-width:420px;width:100%;display:grid;gap:14px">'
        + '<div style="font:800 26px/1.1 \'Inter Tight\',sans-serif;letter-spacing:-.01em">watt &amp; eisen</div>'
        + '<p style="margin:0;color:#A3AEC6;font-size:15px;line-height:1.45">' + esc(msg || 'Damit die App deine Daten laden kann, braucht sie einmal den Zugangs-Token für dein privates Datenrepo. Er bleibt nur auf diesem Gerät gespeichert.') + '</p>'
        + '<input name="t" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="github_pat_…" aria-label="Zugangs-Token" style="font:500 16px \'JetBrains Mono\',monospace;padding:14px;border-radius:12px;border:1px solid #3B4C73;background:#101B33;color:#fff;min-width:0">'
        + '<button type="submit" style="font:800 16px \'Inter Tight\',sans-serif;padding:14px;border:0;border-radius:12px;background:#F97316;color:#0B1428">Verbinden</button>'
        + '<div class="e" role="status" style="color:#FCA5A5;font-size:14px;min-height:18px"></div>'
        + '<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener" style="color:#A3AEC6;font-size:14px">Token bei GitHub erstellen</a>'
        + '</form>';
      document.body.appendChild(overlay);
      var f = overlay.querySelector('form'), e = overlay.querySelector('.e'), btn = f.querySelector('button');
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var t = f.t.value.trim(); if (!t) return;
        btn.disabled = true; e.textContent = 'Prüfe …';
        fetch('https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/data?ref=' + BRANCH, { headers: { Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json' }, cache: 'no-store' }).then(function (r) {
          btn.disabled = false;
          if (r.ok) { lsSet(TK, t); overlay.remove(); overlay = null; resolve(); }
          else e.textContent = r.status === 401 ? 'GitHub lehnt den Token ab. Prüfe, ob du ihn komplett kopiert hast.' : r.status === 404 ? 'Mit diesem Token ist das Datenrepo nicht erreichbar. Er braucht Zugriff auf watt-und-eisen-daten.' : 'GitHub antwortet mit ' + r.status + '.';
        }, function () { btn.disabled = false; e.textContent = 'Keine Verbindung. Versuch es gleich nochmal.'; });
      });
      setTimeout(function () { try { f.t.focus(); } catch (_) {} }, 50);
    });
  }
  var authPending = false;
  function authFailed() {
    if (authPending) return; authPending = true; lsDel(TK);
    askToken('Der Zugang wurde abgelehnt oder ist abgelaufen. Füge einen neuen Token ein.').then(function () { location.reload(); });
  }

  // ---------- Fähigkeiten, wie die Seite sie erwartet ----------
  var dbP = null;
  function useDb() {
    if (!dbP) dbP = (token() ? Promise.resolve() : (document.body ? askToken() : new Promise(function (r) { document.addEventListener('DOMContentLoaded', function () { askToken().then(r); }); }))).then(function () { return db; });
    return dbP;
  }
  window.claude = {
    use: function (name) {
      if (name === 'db') return useDb();
      if (name === 'downloads') return Promise.resolve(downloads);
      return Promise.resolve(null);
    }
  };
  window.weGh = { db: db };

  // ---------- Zusätze in der Seite ----------
  function addons() {
    var coach = document.getElementById('coach');
    if (coach && !coach.querySelector('.we-trainer')) {
      var p = document.createElement('p'); p.className = 'we-trainer'; p.style.cssText = 'margin:10px 0 0;font-size:14px;line-height:1.4;color:var(--ink2,#A3AEC6)';
      p.innerHTML = 'Fragen an den Trainer stellst du im Chat. <a href="' + TRAINER_URL + '" target="_blank" rel="noopener" style="color:var(--accent,#F97316);font-weight:700;white-space:nowrap">Trainer öffnen</a>';
      coach.appendChild(p);
    }
    var card = document.querySelector('#dataWrap .datacard');
    if (card && !card.querySelector('.we-conn')) {
      var d = document.createElement('div'); d.className = 'we-conn';
      d.innerHTML = '<h2 style="margin-top:8px">Verbindung</h2><p>Deine Daten liegen im privaten Repo <b>' + esc(REPO) + '</b>. Der Zugangs-Token ist nur auf diesem Gerät gespeichert.</p><button type="button" class="we-tok">Token ändern</button>';
      card.appendChild(d);
      d.querySelector('.we-tok').addEventListener('click', function () { askToken('Füge den neuen Token ein. Der alte wird ersetzt.').then(function () { location.reload(); }); });
    }
    var wrap = document.getElementById('dataWrap'); if (wrap) wrap.hidden = false;
  }
  window.addEventListener('DOMContentLoaded', function () { addons(); setTimeout(addons, 800); });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
