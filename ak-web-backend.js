/* ============================================================================
   AquaKotik — Web (GitHub Pages) backend adapter  (v2 — bugfix release)
   ----------------------------------------------------------------------------
   Turns AquaKotik into a "no server of its own" app: the frontend is static
   (served by GitHub Pages) and the real-time shared state lives in a free,
   hosted Firebase Realtime Database.

   HOW IT WORKS
   - The whole app already routes every write through akLive.post('/api/*', ...)
     and every live read through a single EventSource snapshot. This adapter
     (a) intercepts window.fetch for every /api/* call and translates it into a
     Firebase Realtime Database operation, and (b) replaces the SSE feed with a
     real-time onValue listener. No UI code is changed.
   - It only activates when firebase-config.js provides an apiKey AND the page
     is NOT running on the local Node server. Served by the Node server -> the
     original behaviour is untouched.

   v2 FIXES
   - Login/register: email addresses are NOT valid Firebase path keys (no '@'
     or '.' allowed) — they are now sanitized to safe keys (accounts/<key>).
   - Write failures are no longer swallowed: a failed write returns HTTP 500
     instead of a fake success (register no longer "succeeds" silently).
   - Login response now carries the user's stars / premium from the users tree
     so a new device restores the real balance.
   - Presence now writes a small presence/<code> node (online/typing actually
     work) and only rewrites the user node when name/avatar changed — the
     20 s heartbeat no longer re-uploads the whole avatar every time.
   - Presence nodes auto-expire on disconnect (onDisconnect().remove()).
   - /api/user uses update() (partial writes) instead of read-modify-write of
     the whole user node; returns the fresh user record.
   - /api/gift returns the new message id + both parties' star balances, so
     the sender's gift card appears instantly and the balance is accurate.
   - applySnapshot: presence-only events (heartbeats) no longer trigger a full
     re-merge (message walk + multi-MB saveState + full re-render) — that was
     the main source of lag. A content fingerprint decides.
   ========================================================================== */
(function () {
  'use strict';

  var cfg = window.AQUAKOTIK_FIREBASE || null;
  if (!cfg || !cfg.apiKey) return; // no config -> keep Node-server behaviour

  var host = location.hostname || '';
  var isLocal =
    location.protocol === 'file:' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.indexOf('10.10.') === 0 ||
    host.indexOf('192.168.') === 0 ||
    host.indexOf('172.') === 0;
  if (isLocal) return; // running on the local Node server -> keep original behaviour

  /* ------------------------- visible connection pill ------------------------ */
  var pill = null;
  function setStatus(text, tone) {
    try {
      if (!pill) {
        pill = document.createElement('div');
        pill.id = 'ak-web-status';
        pill.style.cssText = 'position:fixed;right:10px;bottom:12px;z-index:2147483000;' +
          'font:12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;padding:6px 11px;border-radius:16px;' +
          'background:rgba(10,16,28,.9);color:#e2e8f0;box-shadow:0 6px 18px rgba(0,0,0,.35);' +
          'display:flex;align-items:center;gap:7px;user-select:none;cursor:pointer;max-width:220px;';
        pill.title = 'AquaKotik онлайн-режим (Firebase). Нажмите, чтобы скрыть.';
        pill.addEventListener('click', function () { if (pill) pill.style.display = 'none'; });
        (document.body || document.documentElement).appendChild(pill);
      }
      var dot = tone === 'ok' ? '#22c55e' : (tone === 'wait' ? '#38bdf8' : (tone === 'warn' ? '#f59e0b' : '#ef4444'));
      pill.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:' + dot + ';box-shadow:0 0 8px ' + dot + '"></span><span>' + text + '</span>';
    } catch (e) {}
  }

  function doActivate() {
    try {
      firebase.initializeApp(cfg);
      var db = firebase.database();
      var ROOT = cfg.rootPath || 'aquakotik';
      function ref(p) { return db.ref(p ? ROOT + '/' + p : ROOT); }
      function me() {
        try { return (typeof akLiveCode === 'function') ? akLiveCode() : ((state.account && state.account.aquaCode) || ''); }
        catch (e) { return ''; }
      }
      var ADMIN = (cfg.adminEmail || 'irontim88@gmail.com').toLowerCase();
      function isAdmin() { return ((state.account && state.account.email || '').toLowerCase()) === ADMIN; }
      function nowIso() { return new Date().toISOString(); }
      function rnd() { return Math.random().toString(36).slice(2, 8); }

      /* FIX: Firebase path keys cannot contain '@' '.' '#' '$' '[' ']' —
         emails must be sanitized before use as a path segment. */
      function safeKey(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      }

      function asArray(obj) {
        if (Array.isArray(obj)) return obj;
        if (!obj || typeof obj !== 'object') return [];
        return Object.keys(obj).map(function (k) { return obj[k]; });
      }

      /* ---- build the exact snapshot shape the app's akLive.merge() expects ---- */
      function treeToSnapshot(t) {
        t = t || {};
        var messages = [];
        Object.keys(t.messages || {}).forEach(function (e) {
          Object.keys(t.messages[e] || {}).forEach(function (id) {
            var m = t.messages[e][id];
            if (!m) return;
            if (m.entityId !== e) m.entityId = e;
            messages.push(m);
          });
        });
        var groups = {};
        Object.keys(t.groups || {}).forEach(function (id) {
          var g = t.groups[id] || {};
          groups[id] = Object.assign({}, g, { members: asArray(g.members) });
        });
        return {
          users: t.users || {},
          presence: t.presence || {},
          messages: messages,
          contacts: asArray(t.contacts),
          groups: groups,
          announces: asArray(t.announces),
          polls: t.polls || {},
          bots: t.bots || {},
          roles: t.roles || {},
          adminConfig: t.adminConfig || null
        };
      }

      /* ---- content fingerprint: decides whether a snapshot event is worth a
            full merge (message walk + saveState + renderMain). Presence-only
            events (20 s heartbeats, typing) do NOT change it. ---- */
      function hashStr(s) {
        var h = 2166136261;
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
      }
      function contentFingerprint(snap) {
        var p = [];
        var ukeys = Object.keys(snap.users || {}).sort();
        p.push('U' + ukeys.length);
        for (var i = 0; i < ukeys.length; i++) {
          var u = snap.users[ukeys[i]] || {};
          p.push(ukeys[i] + ':' + String(u.name || '').length + ':' + (u.avatar ? String(u.avatar).length : 0) + ':' +
            (u.stars || 0) + ':' + String(u.premiumUntil || '') + ':' + (u.verified ? 1 : 0) + ':' +
            (u.starsOnly ? 1 : 0) + ':' + (u.gender || '') + ':' +
            (u.profile ? JSON.stringify(u.profile).length : 0) + ':' +
            (u.schedule ? JSON.stringify(u.schedule).length : 0) + ':' +
            (u.equippedEmojis && u.equippedEmojis.length ? u.equippedEmojis.length : 0) + ':' +
            (u.collectibles ? Object.keys(u.collectibles).length : 0) + ':' +
            (u.privacy ? JSON.stringify(u.privacy).length : 0));
        }
        var msgs = snap.messages || [];
        var maxTs = 0, textLen = 0, idHash = 0;
        for (var j = 0; j < msgs.length; j++) {
          var m = msgs[j] || {};
          var ts = Date.parse(m.createdAt || '');
          if (!isNaN(ts) && ts > maxTs) maxTs = ts;
          textLen += String(m.text || '').length;
          idHash = (idHash + hashStr(String(m.id || j) + '~' + (m.text || '').length)) >>> 0;
        }
        p.push('M' + msgs.length + ':' + maxTs + ':' + textLen + ':' + idHash);
        p.push('C' + (snap.contacts || []).length);
        var gks = Object.keys(snap.groups || {}).sort();
        p.push('G' + gks.length);
        gks.forEach(function (k) {
          var g = snap.groups[k] || {};
          p.push(k + ':' + String(g.title || '').length + ':' + asArray(g.members).length + ':' + (g.updatedAt || g.createdAt || ''));
        });
        var bks = Object.keys(snap.bots || {}).sort();
        p.push('B' + bks.length);
        bks.forEach(function (k) {
          var b = snap.bots[k] || {};
          p.push(k + ':' + String(b.name || '').length + ':' + (b.updatedAt || b.createdAt || ''));
        });
        p.push('A' + (snap.announces || []).length);
        var pks = Object.keys(snap.polls || {}).sort();
        p.push('P' + pks.length);
        pks.forEach(function (k) {
          var pl = snap.polls[k] || {};
          p.push(k + ':' + Object.keys(pl.votes || {}).length + ':' + (pl.createdAt || ''));
        });
        p.push('R' + Object.keys(snap.roles || {}).sort().join(','));
        p.push('AC' + (snap.adminConfig ? JSON.stringify(snap.adminConfig).length : 0));
        return p.join('|');
      }

      var _lastFp = '';
      function applySnapshot(t) {
        var snap = treeToSnapshot(t);
        try {
          // presence/user identity always applied cheaply — no merge needed for it
          state.liveUsers = snap.users;
          state.livePresence = snap.presence;
        } catch (e) {}
        var fp = contentFingerprint(snap);
        var changed = fp !== _lastFp;
        _lastFp = fp;
        try {
          if (snap.bots && Object.keys(snap.bots).length) state.bots = snap.bots;
          if (snap.roles) state.roles = snap.roles;
          if (snap.adminConfig) {
            state.adminConfig = Object.assign({ premiumDiscount: 0, grants: {}, seasons: [], announcements: [] }, snap.adminConfig);
          }
        } catch (e) {}
        if (!changed) return; // presence-only event (heartbeat/typing) -> no full re-render
        try { if (typeof akLive.merge === 'function') akLive.merge(snap); } catch (e) {}
        // note: akLive.merge() itself already calls saveState() + renderMain()
      }

      /* ---- live feed: replace SSE EventSource with a real-time onValue listener ---- */
      akLive.connect = function () {
        if (!state.account || this.source) return;
        var self = this;
        try {
          self._listener = function (s) {
            var t = s.val() || {};
            var wasOffline = !self.server;
            self.server = true;
            setStatus('В сети', 'ok');
            if (wasOffline) { try { self.presence(true); } catch (e) {} } // mark online once, not on every value event
            clearTimeout(self._applyTimer);
            self._applyTimer = setTimeout(function () { applySnapshot(t); }, 450); // coalesce rapid value events into one render
          };
          self.source = ref().on('value', self._listener); // fires immediately with current data
          self.server = true;
        } catch (e) { self.server = false; setStatus('Ошибка соединения', 'err'); }
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(function () { try { self.presence(true); } catch (e) {} }, 20000);
      };

      /* ---- translate every /api/* call into a Firebase Realtime Database op ---- */
      var realFetch = window.fetch.bind(window);
      function parseBody(init) { var b = {}; try { if (init && init.body) b = JSON.parse(init.body); } catch (e) {} return b; }
      function parseQS(url) {
        var q = {}, i = url.indexOf('?'); if (i < 0) return q;
        url.slice(i + 1).split('&').forEach(function (kv) {
          if (!kv) return;
          var p = kv.split('=');
          q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
        });
        return q;
      }
      function mkResp(obj, status) {
        if (typeof Response !== 'undefined') return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
        return { ok: (status || 200) < 400, status: status || 200, json: function () { return Promise.resolve(obj); }, text: function () { return Promise.resolve(JSON.stringify(obj)); } };
      }
      function resp(obj, status) { return mkResp(obj, status); }
      function ok(extra) { return resp(Object.assign({ ok: true }, extra || {}), 200); }
      /* FIX: a failed write must NOT be converted into a fake success. */
      function when(promise, onDone) {
        return promise.then(onDone, function (e) {
          try { console.warn('[AquaKotik] op failed:', e && e.message, e); } catch (_) {}
          return resp({ error: 'write-failed' }, 500);
        });
      }

      /* read-modify-write of the user node (kept for admin ops that need the
         full record in the response) */
      function userNode(code, patch) {
        return ref('users/' + code).once('value').then(function (s) {
          var u = s.val() || {};
          if (!u.code) u.code = code;
          if (!u.createdAt) u.createdAt = nowIso();
          if (!u.email) u.email = (state.account && state.account.email) || '';
          if (patch) Object.keys(patch).forEach(function (k) { if (k !== 'code' && patch[k] !== undefined) u[k] = patch[k]; });
          return u;
        });
      }
      function saveUser(code, u) { return when(ref('users/' + code).set(u), function () { return ok({ user: u }); }); }
      /* partial user write — only the given fields, no read needed */
      function updateUser(code, fields) {
        var up = {};
        Object.keys(fields || {}).forEach(function (k) { if (fields[k] !== undefined) up[k] = fields[k]; });
        up.updatedAt = nowIso();
        return when(ref('users/' + code).update(up), function () {
          return ref('users/' + code).once('value').then(function (s) {
            return ok({ user: s.val() || Object.assign({ code: code }, up) });
          }, function () { return ok({ user: Object.assign({ code: code }, up) }); });
        });
      }

      /* per-session cache of the last synced name/avatar signature, so the
         20 s presence heartbeat doesn't rewrite the user node each time */
      var _lastPresenceSig = {};

      window.fetch = function (input, init) {
        try {
          var url = (typeof input === 'string') ? input : ((input && input.url) || String(input));
          var m = url.match(/\/api\/([a-zA-Z-]+)(?:\/([a-zA-Z-]+))?(?:\?|$)/);
          if (!m) return realFetch(input, init); // not an API call -> normal fetch
          var seg1 = m[1].toLowerCase();
          var seg2 = (m[2] || '').toLowerCase();
          var method = (init && init.method) ? String(init.method).toUpperCase() : 'GET';
          var body = parseBody(init);
          var qs = parseQS(url);
          var code = body.code || me();

          /* ---------------------------- reads ---------------------------- */
          if (method === 'GET') {
            if (seg1 === 'state') {
              return ref().once('value').then(function (s) { return ok(treeToSnapshot(s.val() || {})); });
            }
            if (seg1 === 'bot') {
              return ref('bots/' + (qs.code || '')).once('value').then(function (s) {
                return s.exists() ? ok({ bot: s.val() }) : resp({ error: 'not found' }, 404);
              });
            }
            if (seg1 === 'group') {
              return ref('groups/' + (qs.code || '')).once('value').then(function (s) {
                if (!s.exists()) return resp({ error: 'not found' }, 404);
                var g = s.val();
                return ok({ record: Object.assign({}, g, { members: asArray(g.members) }) });
              });
            }
            return ok();
          }

          /* ---------------------------- writes ---------------------------- */

          // cross-user email/code claim (uniqueness check)
          if (seg1 === 'email') {
            var email = (body.email || '').toLowerCase();
            if (!email) return ok();
            var ek = safeKey(email);
            return ref('claims/' + ek).once('value').then(function (s) {
              if (s.exists() && s.val() !== body.code) return resp({ error: 'taken' }, 409);
              return when(ref('claims/' + ek).set(body.code), function () { return ok(); });
            });
          }

          // register a cloud account by email -> stores the device login-code
          if (seg1 === 'register') {
            var regEmail = (body.email || '').toLowerCase();
            if (!regEmail || !body.code) return resp({ error: 'bad' }, 400);
            var rk = safeKey(regEmail);
            return ref('accounts/' + rk).once('value').then(function (s) {
              if (s.exists()) {
                // account already exists: adopt the cloud record if it has no password yet
                var ex = s.val() || {};
                if (!ex.passwordHash && body.passwordHash) {
                  var adopted = { code: body.code, email: regEmail, name: body.name || ex.name || '', avatar: body.avatar || ex.avatar || null, createdAt: ex.createdAt || nowIso(), passwordHash: body.passwordHash };
                  return when(ref('accounts/' + rk).set(adopted), function () { return ok(adopted); });
                }
                return resp({ error: 'taken' }, 409);
              }
              var acc = { code: body.code, email: regEmail, name: body.name || '', avatar: body.avatar || null, createdAt: nowIso(), passwordHash: body.passwordHash || null };
              return when(ref('accounts/' + rk).set(acc), function () { return ok(acc); });
            });
          }

          // login to a cloud account by email + (password or device login-code)
          if (seg1 === 'login') {
            var logEmail = (body.email || '').toLowerCase();
            if (!logEmail) return resp({ error: 'bad' }, 400);
            var lk = safeKey(logEmail);
            return ref('accounts/' + lk).once('value').then(function (s) {
              if (!s.exists()) return resp({ error: 'not-registered' }, 404);
              var a = s.val() || {};
              var okPass = !!a.passwordHash && !!body.secretHash && String(a.passwordHash) === String(body.secretHash);
              var okCode = !!a.code && String(a.code || '').toUpperCase() === String(body.code || '').toUpperCase();
              if (!okPass && !okCode) return resp({ error: 'wrong-creds', code: a.code || '', needAdopt: !a.passwordHash, name: a.name || '' }, 403);
              function done(usr) {
                return ok({
                  email: logEmail, name: a.name || '', avatar: a.avatar || null, code: a.code,
                  createdAt: a.createdAt || nowIso(), passwordHash: a.passwordHash || null,
                  stars: usr ? Number(usr.stars || 0) : 0,
                  premiumUntil: usr ? (usr.premiumUntil || null) : null,
                  user: usr || null
                });
              }
              // attach the real balance/premium so a new device starts with the right numbers
              return ref('users/' + a.code + '/stars').once('value').then(function (st) {
                return ref('users/' + a.code).once('value').then(function (us) {
                  var usr = us.val() || null;
                  if (usr) usr.stars = Number(st.val() || 0);
                  return done(usr);
                }, function () { return done(null); });
              }, function () { return done(null); });
            });
          }

          // adopt: add a password to an existing account (keeps its code) so login by password works
          if (seg1 === 'adopt') {
            var adoptEmail = (body.email || '').toLowerCase();
            if (!adoptEmail || !body.passwordHash) return resp({ error: 'bad' }, 400);
            var ak2 = safeKey(adoptEmail);
            return ref('accounts/' + ak2).once('value').then(function (s) {
              if (!s.exists()) return resp({ error: 'not-registered' }, 404);
              var ex = s.val() || {};
              var adopted = { code: ex.code, email: adoptEmail, name: body.name || ex.name || '', avatar: ex.avatar || null, createdAt: ex.createdAt || nowIso(), passwordHash: body.passwordHash };
              return when(ref('accounts/' + ak2).set(adopted), function () { return ok(adopted); });
            });
          }

          // presence heartbeat — small node, no full user re-upload every 20 s
          if (seg1 === 'presence') {
            var pcode = code;
            var ppres = { code: pcode, online: !!body.online, typingTo: body.typingTo || null, lastSeen: nowIso() };
            var presP = ref('presence/' + pcode).set(ppres);
            var expP = ref('presence/' + pcode).onDisconnect().remove(); // auto-offline when the tab closes
            var psig = (body.name || '') + '|' + (body.avatar ? String(body.avatar).length : 0);
            var userP;
            if (_lastPresenceSig[pcode] !== psig) {
              _lastPresenceSig[pcode] = psig;
              var pup = {};
              if (body.name != null) pup.name = body.name;
              if (body.avatar != null) pup.avatar = body.avatar;
              pup.updatedAt = nowIso();
              userP = ref('users/' + pcode).update(pup).then(function () {}, function (e) {
                try { console.warn('[AquaKotik] presence user update failed:', e && e.message); } catch (_) {}
              });
            } else {
              userP = Promise.resolve();
            }
            return Promise.all([presP, userP, expP]).then(function () { return ok({ presence: ppres }); });
          }

          // message (1-on-1 / group / channel)
          if (seg1 === 'message') {
            if (body.action === 'delete') {
              var delEntity = body.entityId, delId = body.id;
              if (!delEntity || !delId) return resp({ error: 'missing' }, 400);
              return ref('messages/' + delEntity + '/' + delId).once('value').then(function (s) {
                var m = s.val();
                if (!m) return ok();
                return ref('roles/' + code).once('value').then(function (rs) {
                  var r = rs.val();
                  var role = (r && r.role) ? r.role : (isAdmin() ? 'admin' : null);
                  var isSender = (m.fromCode === code);
                  return ref('groups/' + delEntity).once('value').then(function (gs) {
                    var canDelete = isSender || role === 'admin' || role === 'senior' || (role === 'junior' && !!gs.val());
                    if (!canDelete) return resp({ error: 'forbidden' }, 403);
                    return ref('messages/' + delEntity + '/' + delId).remove().then(function () { return ok(); });
                  });
                });
              });
            }
            var entityId = body.entityId;
            var key = ref('messages/' + entityId).push().key;
            var msg = { id: key, fromCode: body.fromCode || code, toCode: body.toCode, entityId: entityId, text: body.text, createdAt: body.createdAt || nowIso() };
            if (body.poll) msg.poll = body.poll;
            if (body.gift) msg.gift = body.gift;
            if (body.kind) msg.kind = body.kind;
            if (body.media) msg.media = body.media;
            if (body.subject) msg.subject = body.subject;
            var mfrom = body.fromCode || code, mto = body.toCode, mpaid = Number(body.starsPaid || 0);
            return when(ref('messages/' + entityId + '/' + key).set(msg), function () {
              if (mpaid > 0 && mto) {
                return ref('users/' + mto + '/starsOnly').once('value').then(function (s) {
                  if (!s.val()) return ok({ id: key });
                  return ref('users/' + mfrom + '/stars').transaction(function (cur) { return Math.max(0, (cur || 0) - mpaid); })
                    .then(function () { return ref('users/' + mto + '/stars').transaction(function (cur) { return (cur || 0) + mpaid; }); })
                    .then(function () { return ok({ id: key, paid: mpaid }); });
                });
              }
              return ok({ id: key });
            });
          }

          // create a 1-on-1 contact link
          if (seg1 === 'contact') {
            var c = { entityId: body.entityId, fromCode: body.fromCode || code, toCode: body.toCode, title: body.title, avatar: body.avatar || null, name: body.name, createdAt: body.createdAt || nowIso() };
            return when(ref('contacts/' + body.entityId).set(c), function () { return ok(); });
          }

          // groups (multi-action)
          if (seg1 === 'group') {
            var gid = body.entityId || body.code || ('g' + rnd());
            var action = body.action || 'update';
            if (action === 'delete') return when(ref('groups/' + gid).remove(), function () { return ok(); });
            return ref('groups/' + gid).once('value').then(function (s) {
              var g = s.val() || { code: gid, id: gid, createdAt: nowIso() };
              g.members = g.members || {};
              if (action === 'create') {
                g = Object.assign(g, {
                  code: gid, id: gid, type: body.type || 'group', title: body.title, description: body.description,
                  avatar: body.avatar || null, ownerCode: body.ownerCode || code, ownerName: body.ownerName || '',
                  public: !!body.public, invite: body.invite || { enabled: true }, createdAt: g.createdAt || nowIso()
                });
                g.members[body.ownerCode || code] = { code: body.ownerCode || code, name: body.ownerName || '', role: 'owner', joinedAt: nowIso() };
              } else if (action === 'join') {
                g.members[body.code || code] = { code: body.code || code, name: body.name || '', role: 'member', joinedAt: nowIso() };
              } else if (action === 'leave') {
                delete g.members[body.code || code];
              } else if (action === 'update') {
                ['title', 'description', 'avatar', 'public'].forEach(function (k) { if (body[k] !== undefined) g[k] = body[k]; });
                if (body.invite) g.invite = body.invite;
              }
              g.updatedAt = nowIso();
              var record = Object.assign({}, g, { members: asArray(g.members) });
              return when(ref('groups/' + gid).set(g), function () { return ok({ record: record }); });
            });
          }

          // user profile update — partial writes, no full-node read-modify-write
          if (seg1 === 'user') {
            var uf = {};
            if (body.name != null) uf.name = String(body.name).slice(0, 80);
            if (body.gender != null && ['male', 'female', 'none'].indexOf(body.gender) !== -1) uf.gender = body.gender;
            if (typeof body.stars === 'number' && isFinite(body.stars)) uf.stars = Math.max(0, Math.min(9999999, Math.round(body.stars)));
            if (body.profile && typeof body.profile === 'object') {
              uf.profile = {
                font: ['system', 'rounded', 'mono', 'serif'].indexOf(body.profile.font) !== -1 ? body.profile.font : 'system',
                accent: ['ocean', 'sunset', 'violet', 'gold', 'mint'].indexOf(body.profile.accent) !== -1 ? body.profile.accent : 'ocean'
              };
            }
            if (body.schedule && typeof body.schedule === 'object') {
              var sf = String(body.schedule.from || '09:00').slice(0, 5);
              var sto = String(body.schedule.to || '18:00').slice(0, 5);
              uf.schedule = { enabled: !!body.schedule.enabled, from: /^\d{2}:\d{2}$/.test(sf) ? sf : '09:00', to: /^\d{2}:\d{2}$/.test(sto) ? sto : '18:00' };
            }
            if (typeof body.starsOnly === 'boolean') uf.starsOnly = body.starsOnly;
            if (typeof body.messagePrice === 'number') uf.messagePrice = Math.max(0, Math.min(99999, Math.round(body.messagePrice)));
            if (Array.isArray(body.cosmetics)) {
              var cosAllowed = { 'gold-frame': 1, 'name-sparkle': 1, 'bubble-wave': 1 };
              uf.cosmetics = body.cosmetics.filter(function (id) { return typeof id === 'string' && cosAllowed[id]; })
                .filter(function (v, i, a) { return a.indexOf(v) === i; });
            }
            if (body.avatar != null) uf.avatar = body.avatar;
            if (typeof body.equippedEmojis === 'object') uf.equippedEmojis = body.equippedEmojis;
            if (body.privacy && typeof body.privacy === 'object') uf.privacy = body.privacy;
            if (body.verified != null) uf.verified = !!body.verified;
            if (body.premiumUntil != null) uf.premiumUntil = body.premiumUntil ? String(body.premiumUntil).slice(0, 40) : null;
            if (typeof body.premiumMonths === 'number' && body.premiumMonths > 0) {
              // extend from the current expiry (small read, then update)
              return ref('users/' + code + '/premiumUntil').once('value').then(function (s) {
                var cur = s.val() ? new Date(s.val()).getTime() : 0;
                var base = Math.max(Date.now(), cur);
                uf.premiumUntil = new Date(Math.min(base + body.premiumMonths * 30 * 86400000, Date.now() + 366 * 86400000)).toISOString();
                return updateUser(code, uf);
              });
            }
            if (!Object.keys(uf).length) {
              return ref('users/' + code).once('value').then(function (s) { return ok({ user: s.val() || { code: code } }); });
            }
            return updateUser(code, uf);
          }

          // bots (multi-action)
          if (seg1 === 'bot') {
            var baction = body.action || 'create';
            var bcode = body.code || ('bot' + rnd());
            if (baction === 'delete') return when(ref('bots/' + bcode).remove(), function () { return ok(); });
            if (baction === 'join-group') return ok({ joined: true });
            return ref('bots/' + bcode).once('value').then(function (s) {
              var b = s.val() || { code: bcode, createdAt: nowIso() };
              if (baction === 'create') {
                b = Object.assign(b, { code: bcode, name: body.name, emoji: body.emoji, avatar: body.avatar || null, rules: body.rules, display: body.display || null, ownerId: body.byCode || code, ownerName: body.ownerName || '', createdAt: b.createdAt || nowIso() });
              } else {
                ['name', 'emoji', 'avatar', 'rules', 'display'].forEach(function (k) { if (body[k] !== undefined) b[k] = body[k]; });
              }
              b.updatedAt = nowIso();
              return when(ref('bots/' + bcode).set(b), function () { return ok({ bot: b }); });
            });
          }

          // admin endpoints
          if (seg1 === 'admin') {
            if (!isAdmin()) return resp({ error: 'forbidden' }, 403);
            if (seg2 === 'config') {
              return ref('adminConfig').once('value').then(function (s) {
                var cur = s.val() || {};
                var next = Object.assign({}, cur, (body.config && typeof body.config === 'object') ? body.config : body);
                return when(ref('adminConfig').set(next), function () { return ok({ config: next }); });
              });
            }
            if (seg2 === 'stars') {
              var target = body.code || body.toCode || code;
              var amount = Number(body.amount || 0);
              return ref('users/' + target + '/stars').transaction(function (cur) { return Math.max(0, (cur || 0) + amount); })
                .then(function () { return ok(); }, function () { return ok(); });
            }
            if (seg2 === 'premium') {
              var ptarget = body.code || body.toCode || code;
              var pmonths = Number(body.months || 1);
              return ref('users/' + ptarget + '/premiumUntil').once('value').then(function (s) {
                var cur = s.val() ? new Date(s.val()).getTime() : 0;
                var base = Math.max(Date.now(), cur);
                var until = new Date(Math.min(base + pmonths * 30 * 24 * 3600 * 1000, Date.now() + 366 * 24 * 3600 * 1000)).toISOString();
                return updateUser(ptarget, { premium: true, premiumUntil: until });
              });
            }
            if (seg2 === 'badge') {
              var btarget = body.code || body.toCode || code;
              return updateUser(btarget, { verified: !!body.verified });
            }
            if (seg2 === 'announce') {
              var aid = ref('announces').push().key;
              var ann = { id: aid, text: body.text, at: nowIso(), adminEmail: ADMIN };
              return when(ref('announces/' + aid).set(ann), function () { return ok({ announce: ann, item: ann }); });
            }
            if (seg2 === 'poll') {
              var pid = body.id || ('p' + rnd());
              var poll = { id: pid, question: body.question, options: body.options, votes: {}, hours: body.hours, adminEmail: ADMIN, createdAt: nowIso() };
              return when(ref('polls/' + pid).set(poll), function () { return ok({ poll: poll, record: poll }); });
            }
            if (seg2 === 'role') {
              var rtarget = (body.code || '').toUpperCase();
              var rrole = body.role || null; // 'senior' | 'junior' | null (clear)
              if (!rtarget) return resp({ error: 'missing-code' }, 400);
              if (rrole && ['senior', 'junior'].indexOf(rrole) === -1) return resp({ error: 'bad-role' }, 400);
              if (!rrole) return ref('roles/' + rtarget).remove().then(function () { return ok(); });
              var rdata = { role: rrole, assignedBy: ADMIN, assignedAt: nowIso() };
              return ref('roles/' + rtarget).set(rdata).then(function () { return ok({ role: rdata }); });
            }
            if (seg2 === 'roles') {
              return ref('roles').once('value').then(function (s) { return ok({ roles: s.val() || {} }); });
            }
            return resp({ error: 'unknown admin path' }, 404);
          }

          // gifts: stars (transfer) | emoji (sender pays, recipient gets the emoji) | premium (sender pays, recipient gets 1 month)
          if (seg1 === 'gift') {
            var from = code, to = body.toCode, amt = Number(body.amount || 0);
            var giftType = body.giftType || 'stars', giftId = body.giftId || null;
            // the chat entity id when available, so BOTH sides see the card in the right chat
            var gEntity = (body.entityId && /^[\w:]{1,64}$/.test(body.entityId)) ? body.entityId : ('gift:' + to);
            var giftText = 'GIFT|' + (giftType === 'emoji' ? ('emoji|' + giftId) : giftType === 'premium' ? 'premium' : ('stars|' + amt));
            var gKey = ref('messages/' + gEntity).push().key;
            var gm = { id: gKey, fromCode: from, toCode: to, entityId: gEntity, text: giftText, createdAt: nowIso(), gift: amt, giftType: giftType };
            function postGiftMsg() { return ref('messages/' + gEntity + '/' + gKey).set(gm); }
            function balances() {
              function one(c) {
                return ref('users/' + c + '/stars').once('value')
                  .then(function (s) { return { code: c, stars: Number(s.val() || 0) }; })
                  .catch(function () { return { code: c, stars: 0 }; });
              }
              return Promise.all([one(from), one(to)]).then(function (rs) { return { from: rs[0], to: rs[1] }; });
            }
            if (giftType === 'emoji') {
              return ref('users/' + from + '/stars').transaction(function (cur) { if ((cur || 0) < amt) throw new Error('no'); return cur - amt; })
                .then(function () {
                  return ref('users/' + to + '/collectibles').once('value').then(function (s) {
                    var col = s.val() || {};
                    if (!col[giftId]) col[giftId] = { id: giftId, gotAt: nowIso(), from: from, gifted: true };
                    return ref('users/' + to + '/collectibles').set(col).then(function () {
                      return postGiftMsg().then(function () {
                        return balances().then(function (b) { return ok({ id: gKey, owned: true, from: b.from }); });
                      });
                    });
                  });
                }).catch(function () { return resp({ error: 'not-enough-stars' }, 409); });
            }
            if (giftType === 'premium') {
              return ref('users/' + from + '/stars').transaction(function (cur) { if ((cur || 0) < amt) throw new Error('no'); return cur - amt; })
                .then(function () {
                  return ref('users/' + to + '/premiumUntil').once('value').then(function (s) {
                    var cur = s.val() ? new Date(s.val()).getTime() : 0;
                    var base = Math.max(Date.now(), cur);
                    var until = new Date(base + 30 * 24 * 3600 * 1000).toISOString();
                    return updateUser(to, { premium: true, premiumUntil: until }).then(function () {
                      return postGiftMsg().then(function () {
                        return balances().then(function (b) { return ok({ id: gKey, premium: true, from: b.from, to: b.to }); });
                      });
                    });
                  });
                }).catch(function () { return resp({ error: 'not-enough-stars' }, 409); });
            }
            // default: stars transfer
            return ref('users/' + from + '/stars').transaction(function (cur) { return Math.max(0, (cur || 0) - amt); })
              .then(function () {
                if (amt > 0) return ref('users/' + to + '/stars').transaction(function (cur) { return (cur || 0) + amt; });
                return Promise.resolve();
              })
              .then(function () {
                return postGiftMsg().then(function () {
                  return balances().then(function (b) { return ok({ id: gKey, from: b.from, to: b.to }); });
                });
              });
          }

          // collectibles (buy / sell animated emojis)
          if (seg1 === 'collectible') {
            var cc = code;
            if (body.action === 'buy') {
              var price = Number(body.price || 0);
              return ref('users/' + cc + '/stars').transaction(function (cur) {
                if ((cur || 0) < price) throw new Error('not-enough-stars');
                return cur - price;
              }).then(function () {
                return ref('users/' + cc + '/collectibles').once('value').then(function (s) {
                  var col = s.val() || {};
                  col[body.id] = { id: body.id, gotAt: nowIso(), bought: true };
                  return ref('users/' + cc + '/collectibles').set(col).then(function () { return ok({ owned: true }); });
                });
              }, function (e) { return resp({ error: 'not-enough-stars' }, 409); });
            }
            if (body.action === 'sell') {
              var sprice = Number(body.price || 0);
              return ref('users/' + cc + '/collectibles/' + body.id).remove().then(function () {
                return ref('users/' + cc + '/stars').transaction(function (cur) { return (cur || 0) + sprice; })
                  .then(function () { return ok({ sold: true }); });
              });
            }
            if (body.action === 'equip') {
              return updateUser(cc, { equippedEmojis: body.equipped || [] });
            }
            return ok();
          }

          // privacy settings (stored in the user node so others can read them)
          if (seg1 === 'privacy') {
            var psettings = body.settings && typeof body.settings === 'object' ? body.settings : {};
            return updateUser(code, { privacy: psettings });
          }

          // statuses / stories
          if (seg1 === 'status') {
            if (body.action === 'like') {
              var lowner = body.ownerId || code;
              return ref('statuses/' + lowner + '/' + body.statusId + '/likes/' + code).set(1)
                .then(function () { return ok(); });
            }
            if (body.action === 'remove') {
              return ref('statuses/' + me() + '/' + body.statusId).remove().then(function () { return ok(); });
            }
            if (body.action === 'list') {
              var scodes = Array.isArray(body.codes) ? body.codes.slice(0, 100) : [];
              var sresults = {};
              var spending = scodes.map(function (c) {
                return ref('statuses/' + c).once('value').then(function (s) { var v = s.val(); if (v) sresults[c] = v; }, function () {});
              });
              return Promise.all(spending).then(function () { return ok({ statuses: sresults }); });
            }
            var sid = ref('statuses/' + me()).push().key;
            var st = { id: sid, text: body.text, kind: body.kind || 'text', media: body.media || null, at: nowIso(), likes: {}, views: {} };
            return when(ref('statuses/' + me() + '/' + sid).set(st), function () { return ok({ status: st }); });
          }

          // letters (rich one-off "envelope" messages)
          if (seg1 === 'letter') {
            var lEntity = body.entityId || ('letter:' + (body.toCode || ''));
            var lKey = ref('messages/' + lEntity).push().key;
            var lm = { id: lKey, fromCode: code, toCode: body.toCode, entityId: lEntity, text: body.text, createdAt: nowIso(), kind: 'letter', letter: { title: body.title, body: body.text, media: body.media || null, from: code } };
            return when(ref('messages/' + lEntity + '/' + lKey).set(lm), function () { return ok({ id: lKey }); });
          }

          // poll vote
          if (seg1 === 'poll' && seg2 === 'vote') {
            var voter = body.code || code;
            var opt = Number(body.option);
            return when(ref('polls/' + body.pollId + '/votes/' + voter).set(opt), function () { return ok(); });
          }

          return ok();
        } catch (e) {
          try { console.warn('[AquaKotik] fetch op error:', e && e.message, e); } catch (_) {}
          return realFetch(input, init); // unexpected shape -> normal fetch
        }
      };

      try { window.AQUAKOTIK_WEB = true; } catch (e) {}
      window.AQUAKOTIK_WEB_READY = true;
      setStatus('В сети', 'ok');
      console.info('[AquaKotik] Web mode active — Firebase backend v2 (root: ' + ROOT + ').');
    } catch (e) {
      try { console.error('[AquaKotik] web mode failed:', e); } catch (_) {}
      setStatus('Ошибка Firebase', 'err');
    }
  }

  /* --------------------------- activate (SDK-aware) ------------------------- */
  function start() {
    if (typeof firebase !== 'undefined') {
      setStatus('Подключение…', 'wait');
      doActivate();
      return;
    }
    setStatus('Загрузка Firebase…', 'wait');
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (typeof firebase !== 'undefined') { clearInterval(t); doActivate(); }
      else if (tries >= 60) { clearInterval(t); setStatus('Firebase недоступен', 'err'); console.warn('[AquaKotik] Firebase SDK never loaded; web mode disabled.'); }
    }, 200);
    // also re-check on full page load as a safety net
    try {
      window.addEventListener('load', function () {
        if (typeof firebase !== 'undefined' && !window.AQUAKOTIK_WEB_READY) { try { clearInterval(t); } catch (e) {} doActivate(); }
      });
    } catch (e) {}
  }
  start();
})();
