/* ============================================================================
   AquaKotik — Web (GitHub Pages) backend adapter
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

   ROBUSTNESS (added)
   - If the Firebase SDK has not finished loading when this script runs, we
     wait for it (poll up to ~12s) instead of silently disabling web mode.
   - A small dismissible status pill in the corner shows the live connection
     state so the user (and we) can tell at a glance whether web mode is up.
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
          adminConfig: t.adminConfig || null
        };
      }

      function applySnapshot(t) {
        var snap = treeToSnapshot(t);
        try { if (typeof akLive.merge === 'function') akLive.merge(snap); } catch (e) {}
        try {
          if (snap.bots && Object.keys(snap.bots).length) state.bots = snap.bots;
          if (snap.adminConfig) {
            state.adminConfig = Object.assign({ premiumDiscount: 0, grants: {}, seasons: [], announcements: [] }, snap.adminConfig);
          }
          saveState();
          if (sessionAuthenticated) renderMain({ preserveScroll: true });
        } catch (e) {}
      }

      /* ---- live feed: replace SSE EventSource with a real-time onValue listener ---- */
      akLive.connect = function () {
        if (!state.account || this.source) return;
        var self = this;
        try {
          self._listener = function (s) {
            var t = s.val() || {};
            self.server = true;
            setStatus('В сети', 'ok');
            applySnapshot(t);
            try { self.presence(true); } catch (e) {}
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
      function when(promise, onDone) { return promise.then(onDone, function (e) { try { console.warn('[AquaKotik] op failed:', e && e.message, e); } catch (_) {} return onDone(e); }); }

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
            return ref('claims/' + email).once('value').then(function (s) {
              if (s.exists() && s.val() !== body.code) return resp({ error: 'taken' }, 409);
              return when(ref('claims/' + email).set(body.code), function () { return ok(); });
            });
          }

          // presence heartbeat
          if (seg1 === 'presence') {
            return userNode(code, { name: body.name, avatar: body.avatar, online: !!body.online, typingTo: body.typingTo || null, updatedAt: nowIso() })
              .then(function (u) { if (body.online) u.lastSeen = nowIso(); return saveUser(code, u); });
          }

          // message (1-on-1 / group / channel)
          if (seg1 === 'message') {
            var entityId = body.entityId;
            var key = ref('messages/' + entityId).push().key;
            var msg = { id: key, fromCode: body.fromCode || code, toCode: body.toCode, entityId: entityId, text: body.text, createdAt: body.createdAt || nowIso() };
            if (body.poll) msg.poll = body.poll;
            if (body.gift) msg.gift = body.gift;
            if (body.kind) msg.kind = body.kind;
            return when(ref('messages/' + entityId + '/' + key).set(msg), function () { return ok({ id: key }); });
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
              var record = Object.assign({}, g, { members: asArray(g.members) });
              return when(ref('groups/' + gid).set(g), function () { return ok({ record: record }); });
            });
          }

          // user profile update (name, gender, profile{font,accent}, schedule, starsOnly, cosmetics, ...)
          if (seg1 === 'user') {
            return userNode(code, body).then(function (u) { return saveUser(code, u); });
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
              return ref('users/' + target + '/stars').transaction(function (cur) { return (cur || 0) + amount; })
                .then(function () { return ok(); }, function () { return ok(); });
            }
            if (seg2 === 'premium') {
              var ptarget = body.code || body.toCode || code;
              var pmonths = Number(body.months || 1);
              var until = new Date(Date.now() + pmonths * 30 * 24 * 3600 * 1000).toISOString();
              return userNode(ptarget, { premium: true, premiumUntil: until })
                .then(function (u) { return saveUser(ptarget, u); });
            }
            if (seg2 === 'badge') {
              var btarget = body.code || body.toCode || code;
              return userNode(btarget, { verified: !!body.verified })
                .then(function (u) { return saveUser(btarget, u); });
            }
            if (seg2 === 'announce') {
              var aid = ref('announces').push().key;
              var ann = { id: aid, text: body.text, at: nowIso(), adminEmail: ADMIN };
              return when(ref('announces/' + aid).set(ann), function () { return ok({ announce: ann }); });
            }
            if (seg2 === 'poll') {
              var pid = body.id || ('p' + rnd());
              var poll = { id: pid, question: body.question, options: body.options, votes: {}, hours: body.hours, adminEmail: ADMIN, createdAt: nowIso() };
              return when(ref('polls/' + pid).set(poll), function () { return ok({ poll: poll }); });
            }
            return resp({ error: 'unknown admin path' }, 404);
          }

          // star gift (transfer stars + a gift message)
          if (seg1 === 'gift') {
            var from = code, to = body.toCode, amt = Number(body.amount || 0);
            var giftType = body.giftType || 'stars', giftId = body.giftId || null;
            return ref('users/' + from + '/stars').transaction(function (cur) { return Math.max(0, (cur || 0) - amt); })
              .then(function () {
                if (amt > 0) return ref('users/' + to + '/stars').transaction(function (cur) { return (cur || 0) + amt; });
                return Promise.resolve();
              })
              .then(function () {
                var gEntity = body.entityId || ('gift:' + to);
                var gKey = ref('messages/' + gEntity).push().key;
                var gm = { id: gKey, fromCode: from, toCode: to, entityId: gEntity, text: body.text || ('gift:' + amt), createdAt: nowIso(), gift: amt, giftType: giftType, giftId: giftId };
                if (giftType === 'emoji' && giftId) {
                  return ref('users/' + to + '/collectibles').once('value').then(function (s) {
                    var col = s.val() || {};
                    if (!col[giftId]) col[giftId] = { id: giftId, gotAt: nowIso(), from: from };
                    return ref('users/' + to + '/collectibles').set(col).then(function () { return ok(); });
                  });
                }
                return ref('messages/' + gEntity + '/' + gKey).set(gm).then(function () { return ok(); });
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
              }).then(function (ok2) {
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
              return userNode(cc, { equippedEmojis: body.equipped || [] })
                .then(function (u) { return saveUser(cc, u); });
            }
            return ok();
          }

          // statuses / stories
          if (seg1 === 'status') {
            if (body.action === 'like') {
              return ref('statuses/' + body.statusId + '/likes/' + code).set(1)
                .then(function () { return ok(); });
            }
            if (body.action === 'remove') {
              return ref('statuses/' + me() + '/' + body.statusId).remove().then(function () { return ok(); });
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
      console.info('[AquaKotik] Web mode active — Firebase backend (root: ' + ROOT + ').');
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
