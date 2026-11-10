/* Automatic copies of all the data, kept on this device (IndexedDB), so a bad sync or a mistake can be undone.
   - kind d: one copy a day, made the first time the app is opened that day (the last 14 are kept)
   - kind p: a copy just before a sync changes this device's data, at most one every 30 minutes (the last 3 are kept)
   - kind r: a copy just before a copy is restored (the last 3 are kept)
   Plain script, no network: it works offline and does not depend on the cloud sync. */
(function () {
  var KEYS = ['year-after-year-v1', 'year-after-year-acts-v1', 'year-after-year-notes-v1', 'movies-and-series-v1', 'daily-life-events-v1', 'skincare-v1', 'meals-v1'];
  var META = 'daily-life-sync-meta', DBN = 'daily-life-backups', ST = 's', KEEP = { d: 14, p: 3, r: 3 };

  function dbOpen(cb) {
    try {
      var r = indexedDB.open(DBN, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(ST, { keyPath: 'id' }); };
      r.onsuccess = function () { cb(null, r.result); };
      r.onerror = function () { cb(r.error || new Error('idb')); };
    } catch (e) { cb(e); }
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function collect() {   // what is on this device right now, exactly as stored
    var o = {}, n = 0;
    KEYS.forEach(function (k) { try { var v = localStorage.getItem(k); if (v != null) { o[k] = v; n++; } } catch (e) {} });
    return n ? o : null;
  }
  function pj(s, fb) { try { var v = JSON.parse(s); return v == null ? fb : v; } catch (e) { return fb; } }
  function count(data) {   // a short description of what a copy holds
    var s = {}, st = pj(data['year-after-year-v1'], {}), j = 0, m = 0;
    Object.keys(st).forEach(function (k) { if (/^\d{4}-\d{2}$/.test(k) && st[k]) { j += Object.keys(st[k].t || {}).length; m += Object.keys(st[k].m || {}).length; } });
    s.j = j; s.m = m;
    s.n = pj(data['year-after-year-notes-v1'], []).filter(function (x) { return x && !x.k && !x.del; }).length;
    s.e = (pj(data['daily-life-events-v1'], {}).items || []).length;
    s.f = (pj(data['movies-and-series-v1'], {}).items || []).length;
    s.p = (pj(data['skincare-v1'], {}).prods || []).length;
    s.r = (pj(data['meals-v1'], {}).recipes || []).filter(function (x) { return x && !x.del; }).length;
    return s;
  }

  function take(kind, cb) {
    var data = collect(), now = Date.now(), d = new Date(now);
    if (!data) { if (cb) cb(false); return; }   // nothing to keep yet
    var id = kind === 'd' ? 'd-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) : kind + '-' + now;
    dbOpen(function (e, db) {
      if (e) { if (cb) cb(false); return; }
      var tx = db.transaction(ST, 'readwrite'), s = tx.objectStore(ST), q = s.getAll(), made = false;
      q.onsuccess = function () {
        var all = q.result || [];
        if (kind === 'd' && all.some(function (x) { return x.id === id; })) return;   // already made today
        if (kind === 'p' && all.some(function (x) { return x.k === 'p' && now - x.at < 18e5; })) return;   // one every 30 minutes at most
        s.put({ id: id, k: kind, at: now, sum: count(data), data: data }); made = true;
        all.push({ id: id, k: kind, at: now });
        all.filter(function (x) { return x.k === kind; }).sort(function (a, b) { return b.at - a.at; }).slice(KEEP[kind] || 3).forEach(function (x) { s.delete(x.id); });
      };
      tx.oncomplete = function () { db.close(); if (cb) cb(made); };
      tx.onerror = tx.onabort = function () { try { db.close(); } catch (x) {} if (cb) cb(false); };
    });
  }
  function list(cb) {   // newest first, without the data itself
    dbOpen(function (e, db) {
      if (e) { cb([]); return; }
      var q = db.transaction(ST).objectStore(ST).getAll();
      q.onsuccess = function () { db.close(); cb((q.result || []).map(function (x) { return { id: x.id, k: x.k, at: x.at, sum: x.sum }; }).sort(function (a, b) { return b.at - a.at; })); };
      q.onerror = function () { try { db.close(); } catch (x) {} cb([]); };
    });
  }
  /* put a copy back on this device. The sync is told to send it to the cloud as it is (not merge it), so the other devices follow. */
  function restore(id, cb) {
    dbOpen(function (e, db) {
      if (e) { cb(false); return; }
      var q = db.transaction(ST).objectStore(ST).get(id);
      q.onsuccess = function () {
        db.close();
        var rec = q.result; if (!rec || !rec.data) { cb(false); return; }
        take('r', function () {   // first keep what is here now
          try {
            KEYS.forEach(function (k) { if (rec.data[k] != null) localStorage.setItem(k, rec.data[k]); else localStorage.removeItem(k); });
            var m = pj(localStorage.getItem(META), {}); m.force = Date.now(); m.dirty = true; localStorage.setItem(META, JSON.stringify(m));
            cb(true);
          } catch (x) { cb(false); }
        });
      };
      q.onerror = function () { try { db.close(); } catch (x) {} cb(false); };
    });
  }

  window.DLBackup = { take: take, list: list, restore: restore, KEYS: KEYS };
  setTimeout(function () { take('d'); }, 300);   // before the sync has had time to change anything
})();
