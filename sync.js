/* Cloud sync for Daily Life: keeps a copy of all the data in the user's own Firebase account (one private document).
   The pages keep working from localStorage; this file mirrors it to the cloud and pulls changes made on other devices.
   Shared by index.html (shows the sign-in box) and movies.html (just syncs when signed in). */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// local test copies must never touch the real cloud data
if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) throw new Error('Cloud sync is off on localhost');

var app = initializeApp({
  apiKey: 'AIzaSyA-1VegurJPDacGJzLNj3V04DuEi_R2V_8',
  authDomain: 'daily-daniels.firebaseapp.com',
  projectId: 'daily-daniels',
  storageBucket: 'daily-daniels.firebasestorage.app',
  messagingSenderId: '384636340656',
  appId: '1:384636340656:web:d99c02d27b4a463d7e6e75'
});
var auth = getAuth(app), db = getFirestore(app);

var LS = 'year-after-year-v1', LSA = 'year-after-year-acts-v1', LSN = 'year-after-year-notes-v1', MKEY = 'movies-and-series-v1';
var EKEY = 'daily-life-events-v1';
var WATCH = [LS, LSA, LSN, MKEY, EKEY], META = 'daily-life-sync-meta';
var rawSet = Storage.prototype.setItem;
var user = null, applying = false, rev = 0, timer = null, busy = Promise.resolve(), msg = '', msgErr = false;

function lsGet(k, fb) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch (e) { return fb; } }
function getMeta() { return lsGet(META, {}) || {}; }
function setMeta(m) { try { rawSet.call(localStorage, META, JSON.stringify(m)); } catch (e) {} }

/* local data as one object */
function readLocal() {
  var mv = lsGet(MKEY, null), ev = lsGet(EKEY, null);
  return { store: lsGet(LS, {}), acts: lsGet(LSA, []), notes: lsGet(LSN, []), movies: (mv && Array.isArray(mv.items)) ? mv.items : [], events: (ev && Array.isArray(ev.items)) ? ev.items : [] };
}
function fromCloud(c, local) {
  function p(s, fb) { try { var v = JSON.parse(s); return v == null ? fb : v; } catch (e) { return fb; } }
  // a copy saved before the calendar existed has no events: keep the ones on this device
  return { store: p(c.store, {}), acts: p(c.acts, []), notes: p(c.notes, []), movies: p(c.movies, []), events: c.events === undefined ? local.events : p(c.events, []) };
}
/* write to localStorage without triggering a push; returns true when something changed */
function applyLocal(d) {
  var changed = false;
  function put(k, v) { var s = JSON.stringify(v); if (localStorage.getItem(k) !== s) { rawSet.call(localStorage, k, s); changed = true; } }
  applying = true;
  try {
    put(LS, d.store); put(LSA, d.acts); put(LSN, d.notes);
    var evOld = lsGet(EKEY, null); evOld = (evOld && Array.isArray(evOld.items)) ? evOld.items : [];
    if (JSON.stringify(evOld) !== JSON.stringify(d.events)) put(EKEY, { items: d.events });
    var mv = lsGet(MKEY, null); if (!mv || !Array.isArray(mv.items)) mv = { items: [], tmdb: '' };
    var before = JSON.stringify(mv.items); mv.items = d.movies;
    if (JSON.stringify(mv.items) !== before) { rawSet.call(localStorage, MKEY, JSON.stringify(mv)); changed = true; }
  } finally { applying = false; }
  return changed;
}

/* merge two copies, never deleting anything; a wins ties */
function normMonth(o) {
  o = o || {};
  if (Object.keys(o).some(function (x) { return x !== 't' && x !== 'm' && x !== 'a' && x !== 'l'; })) return { t: o, m: {}, a: {}, l: {} };
  return { t: o.t || {}, m: o.m || {}, a: o.a || {}, l: o.l || {} };
}
function unionList(a, b, newer) {
  var out = (a || []).slice();
  (b || []).forEach(function (x) {
    if (!x || !x.id) return;
    var i = out.findIndex(function (y) { return y.id === x.id; });
    if (i === -1) out.push(x); else if (newer && (x.u || 0) > (out[i].u || 0)) out[i] = x;
  });
  return out;
}
function union(a, b) {
  var store = {};
  Object.keys(a.store).concat(Object.keys(b.store)).forEach(function (k) {
    if (store[k]) return;
    var x = normMonth(a.store[k]), y = normMonth(b.store[k]);
    ['t', 'm', 'a', 'l'].forEach(function (f) { Object.keys(y[f]).forEach(function (d) { if (!(d in x[f])) x[f][d] = y[f][d]; }); });
    store[k] = x;
  });
  return { store: store, acts: unionList(a.acts, b.acts), notes: unionList(a.notes, b.notes, true), movies: unionList(a.movies, b.movies, true), events: unionList(a.events, b.events, true) };
}

/* talking to the cloud */
function ref() { return doc(db, 'users', user.uid); }
async function push(d) {
  var r0 = rev, at = Date.now();
  var body = { updated: at, store: JSON.stringify(d.store), acts: JSON.stringify(d.acts), notes: JSON.stringify(d.notes), movies: JSON.stringify(d.movies), events: JSON.stringify(d.events) };
  if (body.store.length + body.acts.length + body.notes.length + body.movies.length + body.events.length > 900000) throw new Error('too big');
  await setDoc(ref(), body);
  setMeta({ uid: user.uid, at: at, dirty: rev !== r0 });
}
async function sync(reloadOk) {
  if (!user) return;
  var snap = await getDoc(ref()), cloud = snap.exists() ? snap.data() : null, local = readLocal(), meta = getMeta();
  var merged = local, changed = false;
  if (!cloud) { /* first sync of this account: upload what is here */ }
  else if (meta.uid !== user.uid) { merged = union(local, fromCloud(cloud, local)); changed = applyLocal(merged); }
  else if (cloud.updated > (meta.at || 0)) {
    merged = meta.dirty ? union(local, fromCloud(cloud, local)) : fromCloud(cloud, local);
    changed = applyLocal(merged);
    if (!meta.dirty) { setMeta({ uid: user.uid, at: cloud.updated, dirty: false }); }
  }
  var needPush = !cloud || meta.uid !== user.uid || meta.dirty;
  if (needPush) await push(merged);
  if (changed && reloadOk && !sessionStorage.getItem('daily-life-synced')) { try { sessionStorage.setItem('daily-life-synced', '1'); } catch (e) {} location.reload(); }
}
function run(reloadOk) {
  busy = busy.then(async function () {
    if (!user) return;
    say('Syncing…'); status('busy', 'Syncing…');
    try { await sync(reloadOk); var ok = 'Synced ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); say(ok); status('ok', ok); }
    catch (e) { var bad = navigator.onLine ? (e && e.message === 'too big' ? 'Too much data to sync' : 'Sync failed. Will try again') : 'Offline. Will sync when back online'; say(bad, true); status(navigator.onLine ? 'err' : 'off', bad); }
  });
  return busy;
}
function schedule() { clearTimeout(timer); timer = setTimeout(function () { run(false); }, 2000); }

/* any write to the app's keys marks the data as changed */
Storage.prototype.setItem = function (k, v) {
  rawSet.call(this, k, v);
  if (this === localStorage && !applying && WATCH.indexOf(k) !== -1) {
    rev++;
    var m = getMeta(); m.dirty = true; setMeta(m);
    if (user) schedule();
  }
};
window.addEventListener('online', function () { if (user) run(false); });
document.addEventListener('visibilitychange', function () {
  if (!user) return;
  if (document.hidden) { if (getMeta().dirty) { clearTimeout(timer); run(false); } }
  else { var a = document.activeElement; if (!a || !/^(TEXTAREA|INPUT)$/.test(a.tagName)) { try { sessionStorage.removeItem('daily-life-synced'); } catch (e) {} run(true); } }
});

/* sign-in box on the home page */
var box = document.getElementById('syncbox');
function say(t, err) { msg = t; msgErr = !!err; paint(); }
function paint() {
  if (!box) return;
  var st = box.querySelector('.sy-msg'); if (st) { st.textContent = msg; st.className = 'sy-msg' + (msgErr ? ' err' : ''); }
}
function errText(e) {
  var c = (e && e.code) || '';
  if (c === 'auth/invalid-credential' || c === 'auth/wrong-password' || c === 'auth/user-not-found') return 'Wrong email or password';
  if (c === 'auth/email-already-in-use') return 'That email already has an account. Use Sign in';
  if (c === 'auth/weak-password') return 'Password needs at least 6 characters';
  if (c === 'auth/invalid-email') return 'That email does not look right';
  if (c === 'auth/too-many-requests') return 'Too many tries. Wait a bit and try again';
  if (c === 'auth/network-request-failed') return 'No connection';
  return 'Could not sign in';
}
function draw() {
  if (!box) return;
  box.innerHTML = '';
  var wrap = document.createElement('div'); wrap.className = 'sy';
  var h = document.createElement('div'); h.className = 'sy-h'; h.textContent = 'Cloud sync';
  wrap.appendChild(h);
  if (user) {
    var who = document.createElement('div'); who.className = 'sy-who'; who.textContent = user.email; wrap.appendChild(who);
    var s = document.createElement('div'); s.className = 'sy-msg'; wrap.appendChild(s);
    var row = document.createElement('div'); row.className = 'sy-row';
    var b1 = document.createElement('button'); b1.textContent = 'Sync now'; b1.onclick = function () { try { sessionStorage.removeItem('daily-life-synced'); } catch (e) {} run(true); };
    var b2 = document.createElement('button'); b2.textContent = 'Sign out'; b2.onclick = function () { signOut(auth); };
    row.appendChild(b1); row.appendChild(b2); wrap.appendChild(row);
  } else {
    var em = document.createElement('input'); em.type = 'email'; em.placeholder = 'Email'; em.autocomplete = 'username'; em.setAttribute('autocapitalize', 'none'); em.setAttribute('autocorrect', 'off');
    var pw = document.createElement('input'); pw.type = 'password'; pw.placeholder = 'Password (6+ characters)'; pw.autocomplete = 'current-password';
    var s2 = document.createElement('div'); s2.className = 'sy-msg';
    var row2 = document.createElement('div'); row2.className = 'sy-row';
    function go(create) {
      var e = em.value.trim(), p = pw.value;
      if (!e || !p) { say('Enter email and password', true); return; }
      say(create ? 'Creating account…' : 'Signing in…');
      (create ? createUserWithEmailAndPassword : signInWithEmailAndPassword)(auth, e, p).catch(function (x) { say(errText(x), true); });
    }
    var i1 = document.createElement('button'); i1.textContent = 'Sign in'; i1.onclick = function () { go(false); };
    var i2 = document.createElement('button'); i2.textContent = 'Create account'; i2.onclick = function () { pw.autocomplete = 'new-password'; go(true); };
    var i3 = document.createElement('button'); i3.textContent = 'Forgot password'; i3.onclick = function () {
      var e = em.value.trim();
      if (!e) { say('Type your email above first', true); return; }
      say('Sending…');
      sendPasswordResetEmail(auth, e).then(function () { say('If that email has an account, a link to reset the password is on its way. Check your inbox and spam.'); }, function (x) { say(errText(x), true); });
    };
    row2.appendChild(i1); row2.appendChild(i2); row2.appendChild(i3);
    wrap.appendChild(em); wrap.appendChild(pw); wrap.appendChild(s2); wrap.appendChild(row2);
  }
  box.appendChild(wrap); paint();
}
if (box) {
  var css = document.createElement('style');
  css.textContent = '.acpanel .sy{margin:0;box-shadow:0 18px 40px -18px var(--shadow)}' +
    '.sy{margin:14px 0 0;padding:16px;border-radius:22px;background:var(--paper);border:1px solid var(--line)}' +
    '.sy-h{font-weight:600;font-size:15px;margin-bottom:6px}.sy-who{font-size:13px;color:var(--mute);margin-bottom:4px;word-break:break-all}' +
    '.sy input{display:block;width:100%;margin:8px 0 0;padding:11px 16px;border-radius:999px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:400 14px var(--font-text)}' +
    '.sy-msg{min-height:18px;margin:8px 2px 0;font-size:12.5px;color:var(--mute)}.sy-msg.err{color:#B3445A}' +
    '.sy-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.sy-row button{padding:9px 16px;border-radius:999px;background:var(--accent);border:0;color:var(--accent-ink);font:500 13px var(--font-text);cursor:pointer}' +
    '.sy-row button+button{background:var(--paper);border:1px solid var(--line);color:var(--mute)}';
  document.head.appendChild(css);
  draw();
}

onAuthStateChanged(auth, function (u) {
  var was = user; user = u;
  if (box && (!!was !== !!u || (was && u && was.uid !== u.uid))) draw();
  var dt = document.querySelector('.acdot'); if (dt) dt.hidden = !u;
  if (u) run(true); else { say(''); status('out', 'Not signed in. Tap to sign in'); }
});
/* the home page shows this under the greeting */
function status(state, text) {
  window.__dailySync = { state: state, text: text };
  try { window.dispatchEvent(new CustomEvent('daily-sync')); } catch (e) {}
}
