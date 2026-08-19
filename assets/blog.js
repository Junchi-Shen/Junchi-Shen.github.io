/* Blog — list / editor / preview, backed by localStorage.
   A faithful port of the Claude Design prototype's logic to plain JS.

   Note on "owner mode": the passphrase checks against a PBKDF2-SHA256 digest in
   assets/auth.js, so the plaintext is not in the repo. It is still only a switch
   for the authoring UI — a static site has no server to authenticate against,
   and everything lives in this browser's localStorage. Nothing is protected by
   it because nothing sensitive is served. See README. */
(function () {
  var POSTS_KEY = 'jsblog-posts';
  var OWNER_KEY = 'jsblog-owner';
  var SPLIT_KEY = 'jsblog-split';
  var DIRTY_KEY = 'jsblog-dirty';
  var AUTOSAVE_MS = 1200;

  var S = {
    view: 'list',
    posts: [],
    draft: { id: null, title: '', tags: '', summary: '', content: '', visibility: 'private' },
    pv: null,
    saved: false,
    savedAt: '',
    q: '',
    status: 'all',
    tag: null,
    owner: false
  };

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
  var autosaveTimer = null;

  /* ── helpers ─────────────────────────────────────────────────────────── */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function load() {
    try { return JSON.parse(localStorage.getItem(POSTS_KEY) || '[]') || []; } catch (e) { return []; }
  }
  function persist(posts) {
    try { localStorage.setItem(POSTS_KEY, JSON.stringify(posts)); }
    catch (e) { window.alert('无法保存到本机浏览器（存储已满或被禁用） · Could not save to this browser'); }
  }
  function fmtDate(iso) { return String(iso || '').slice(0, 10).replace(/-/g, '.'); }
  function chars(s) { return String(s || '').replace(/\s/g, '').length; }
  function readTime(s) { return Math.max(1, Math.round(chars(s) / 450)); }
  function parseTags(p) {
    return String(p.tags || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function show(el, on) { if (el) el.classList.toggle('hidden', !on); }

  /* ── owner passphrase ────────────────────────────────────────────────── */

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function bytesToHex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  // Resolves true/false, or rejects with a reason the caller can explain.
  function verifyPassphrase(input) {
    var cfg = window.BLOG_AUTH;
    if (!cfg || !cfg.hash || !cfg.salt) return Promise.reject(new Error('no-config'));
    if (!(window.crypto && window.crypto.subtle)) return Promise.reject(new Error('no-crypto'));
    var bytes = new TextEncoder().encode(input);
    return window.crypto.subtle
      .importKey('raw', bytes, 'PBKDF2', false, ['deriveBits'])
      .then(function (key) {
        return window.crypto.subtle.deriveBits({
          name: 'PBKDF2',
          salt: hexToBytes(cfg.salt),
          iterations: cfg.iterations,
          hash: 'SHA-256'
        }, key, cfg.hash.length * 4);
      })
      .then(function (bits) { return bytesToHex(bits) === cfg.hash; });
  }

  /* ── markdown ────────────────────────────────────────────────────────── */

  function mdInline(text) {
    // Escape first, then apply inline marks — the markers survive escaping.
    return esc(text)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, href) {
        // Only link schemes that can't execute script; anything else stays literal.
        // The lone `/` must not match `//host`, which is a protocol-relative
        // link off-site that would otherwise be treated as an internal path.
        if (!/^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(href)) return m;
        var ext = /^https?:\/\//i.test(href);
        return '<a href="' + href + '"' + (ext ? ' target="_blank" rel="noopener"' : '') + '>' + label + '</a>';
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function mdRender(md) {
    var lines = String(md || '').split('\n');
    var out = [], para = [], list = null, listType = '', quote = null, fence = null;

    function flushP() {
      if (para.length) { out.push('<p>' + mdInline(para.join(' ')) + '</p>'); para = []; }
    }
    function flushL() {
      if (list) {
        out.push('<' + listType + '>' + list.map(function (it) { return '<li>' + mdInline(it) + '</li>'; }).join('') + '</' + listType + '>');
        list = null;
      }
    }
    function flushQ() {
      if (quote) { out.push('<blockquote>' + mdInline(quote.join(' ')) + '</blockquote>'); quote = null; }
    }
    function flushF() {
      if (fence) { out.push('<pre><code>' + esc(fence.join('\n')) + '</code></pre>'); fence = null; }
    }
    function flushAll() { flushP(); flushL(); flushQ(); }

    lines.forEach(function (raw) {
      if (fence) {
        // Inside a code fence nothing is markdown until the closing ```.
        if (/^```/.test(raw.trim())) flushF(); else fence.push(raw);
        return;
      }
      var t = raw.trim();
      if (/^```/.test(t)) { flushAll(); fence = []; return; }
      if (!t) { flushAll(); return; }
      if (/^---+$/.test(t)) { flushAll(); out.push('<hr>'); return; }
      if (t.indexOf('### ') === 0) { flushAll(); out.push('<h3>' + mdInline(t.slice(4)) + '</h3>'); return; }
      if (t.indexOf('## ') === 0) { flushAll(); out.push('<h2>' + mdInline(t.slice(3)) + '</h2>'); return; }
      var ol = t.match(/^\d+\.\s+(.*)$/);
      if (t.indexOf('- ') === 0 || t.indexOf('* ') === 0 || ol) {
        var type = ol ? 'ol' : 'ul';
        flushP(); flushQ();
        if (list && listType !== type) flushL();
        if (!list) { list = []; listType = type; }
        list.push(ol ? ol[1] : t.slice(2));
        return;
      }
      if (t.indexOf('> ') === 0) { flushP(); flushL(); (quote = quote || []).push(t.slice(2)); return; }
      para.push(t);
    });
    flushF(); // an unclosed fence at EOF still renders as code
    flushAll();
    return out.length ? out.join('') : '<p class="empty">(empty 空)</p>';
  }

  /* ── draft persistence ───────────────────────────────────────────────── */

  function commitDraft(visibility) {
    var d = S.draft;
    if (!d.title.trim() && !d.content.trim()) return null;
    var posts = S.posts.slice();
    var i = posts.findIndex(function (p) { return p.id === d.id; });
    var base = i >= 0 ? posts[i]
      : { id: d.id || Date.now(), date: new Date().toISOString(), visibility: 'private' };
    var post = {
      id: base.id, date: base.date,
      // New posts start private. Going public has to be a deliberate act.
      visibility: visibility || d.visibility || base.visibility || 'private',
      title: d.title.trim() || 'Untitled 无题',
      tags: d.tags.trim(),
      summary: (d.summary || '').trim(),
      content: d.content,
      updatedAt: new Date().toISOString()
    };
    if (visibility === 'public' && base.visibility !== 'public') post.date = new Date().toISOString();
    if (i >= 0) posts[i] = post; else posts.unshift(post);
    S.posts = posts;
    S.draft.id = post.id;
    S.draft.visibility = post.visibility;
    persist(posts);
    markDirty();
    return post;
  }

  function markSaved() {
    S.saved = true;
    S.savedAt = new Date().toTimeString().slice(0, 5);
    $('#d-saved-at').textContent = S.savedAt;
    show($('#d-saved'), true);
  }

  function onDraftInput(field, value) {
    S.draft[field] = value;
    S.saved = false;
    show($('#d-saved'), false);
    renderCounts();
    if (field === 'content') renderLivePreview();
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(function () {
      if (S.view !== 'editor') return;
      if (commitDraft()) markSaved();
    }, AUTOSAVE_MS);
  }

  /* ── rendering ───────────────────────────────────────────────────────── */

  function setView(view) {
    S.view = view;
    show($('#view-list'), view === 'list');
    show($('#view-editor'), view === 'editor');
    show($('#view-preview'), view === 'preview');
    window.scrollTo(0, 0);
  }

  function renderOwner() {
    $$('.owner-only').forEach(function (el) { el.classList.toggle('hidden', !S.owner); });
    $$('.guest-only').forEach(function (el) { el.classList.toggle('hidden', S.owner); });
  }

  function isPublic(p) { return p.visibility === 'public'; }

  function visiblePosts() {
    var q = S.q.toLowerCase();
    return S.posts.filter(function (p) {
      // A visitor is only ever shown public posts. Their browser never even
      // receives the private ones — they live in a separate private repo.
      if (!S.owner && !isPublic(p)) return false;
      if (S.status === 'pub' && !isPublic(p)) return false;
      if (S.status === 'private' && isPublic(p)) return false;
      if (S.tag && parseTags(p).indexOf(S.tag) < 0) return false;
      if (q) {
        var hay = (String(p.title || '') + ' ' + String(p.content || '') + ' ' + String(p.tags || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function excerpt(p) {
    if (p.summary && p.summary.trim()) return p.summary.trim();
    var text = String(p.content || '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // keep link labels, drop URLs
      .replace(/[#>*`~-]/g, '')
      .replace(/\s+/g, ' ').trim();
    return text.slice(0, 150) + (String(p.content || '').trim().length > 150 ? '…' : '');
  }

  function renderCounts() {
    $('#d-chars').textContent = chars(S.draft.content);
    $('#d-read').textContent = readTime(S.draft.content);
  }

  function renderList() {
    var published = S.posts.filter(isPublic);
    $('#pub-count').textContent = published.length;
    $('#draft-count').textContent = S.posts.length - published.length;
    renderSyncState();

    $$('[data-status]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.status === S.status));
    });

    // tag chips
    var names = [];
    S.posts.forEach(function (p) {
      parseTags(p).forEach(function (t) { if (names.indexOf(t) < 0) names.push(t); });
    });
    $('#tag-list').innerHTML = names.map(function (n) {
      return '<button type="button" class="tag tag-outline" data-tag="' + esc(n) + '" aria-pressed="' +
        (S.tag === n) + '">' + esc(n) + '</button>';
    }).join('');

    var vis = visiblePosts();
    show($('#empty'), S.posts.length === 0);
    show($('#nomatch'), S.posts.length > 0 && vis.length === 0);

    $('#posts').innerHTML = vis.map(function (p) {
      var tags = parseTags(p).join(' · ');
      return '' +
        '<div class="post-row" data-id="' + esc(p.id) + '">' +
          '<div>' +
            '<div class="post-date">' + esc(fmtDate(p.date)) + '</div>' +
            '<div class="post-read">' + readTime(p.content) +
              ' <span data-en>min</span><span data-sep> · </span><span data-zh lang="zh">分钟</span></div>' +
          '</div>' +
          '<div>' +
            '<a class="post-link" data-act="open">' + esc(p.title) + '</a>' +
            '<p class="post-excerpt">' + esc(excerpt(p)) + '</p>' +
            '<div class="post-tags">' +
              (isPublic(p)
                ? ''
                : '<span class="tag tag-private"><span data-en>Private</span><span data-sep> </span><span data-zh lang="zh">私密</span></span>') +
              '<span class="names">' + esc(tags) + '</span>' +
            '</div>' +
          '</div>' +
          (S.owner
            ? '<div class="post-actions">' +
                '<button type="button" class="btn btn-ghost" data-act="edit"><span data-en>Edit</span><span data-sep> </span><span data-zh lang="zh">编辑</span></button>' +
                '<button type="button" class="btn btn-ghost btn-del" data-act="delete"><span data-en>Delete</span><span data-sep> </span><span data-zh lang="zh">删除</span></button>' +
              '</div>'
            : '<div></div>') +
        '</div>';
    }).join('');
  }

  function renderPreview() {
    var pv = S.pv || {};
    var priv = !isPublic(pv);

    show($('#pv-draft-bar'), priv && S.owner);
    show($('#pv-pub-bar'), !priv && !!S.pv && S.owner);
    show($('#pv-draft-flag'), priv);

    $('#pv-date').textContent = fmtDate(pv.date);
    $('#pv-read').textContent = readTime(pv.content);
    $('#pv-tags').textContent = parseTags(pv).join(' · ');
    $('#pv-title').textContent = pv.title || '';
    var hasSummary = !!(pv.summary && pv.summary.trim());
    show($('#pv-summary'), hasSummary);
    $('#pv-summary').textContent = pv.summary || '';
    $('#pv-body').innerHTML = mdRender(pv.content);

    var published = S.posts.filter(isPublic);
    var i = published.findIndex(function (p) { return p.id === pv.id; });
    var prev = i > 0 ? published[i - 1] : null;
    var next = (i >= 0 && i < published.length - 1) ? published[i + 1] : null;
    show($('#pv-newer'), !!prev);
    show($('#pv-older'), !!next);
    if (prev) $('#pv-prev-title').textContent = prev.title || '';
    if (next) $('#pv-next-title').textContent = next.title || '';
    S._prev = prev; S._next = next;
  }

  /* ── live preview ────────────────────────────────────────────────────── */

  function splitOn() {
    try { return localStorage.getItem(SPLIT_KEY) !== '0'; } catch (e) { return true; }
  }

  var _pvRaf = null;
  function paintPreview() { $('#d-preview').innerHTML = mdRender(S.draft.content); }
  function renderLivePreview() {
    if (!splitOn()) return;
    if (_pvRaf) cancelAnimationFrame(_pvRaf);
    // rAF coalesces keystrokes but never fires in a hidden tab, which would
    // leave a stale preview on return — paint directly there instead.
    if (document.hidden) { paintPreview(); return; }
    _pvRaf = requestAnimationFrame(paintPreview);
  }

  // Side-by-side, the preview column tracks the textarea's height (which the
  // user can drag); stacked on narrow screens, CSS caps it instead.
  function syncPreviewSize() {
    var ta = $('#d-content'), pv = $('#d-preview');
    if (!ta || !pv || !ta.offsetHeight) return;
    if (window.matchMedia('(max-width: 900px)').matches) { pv.style.height = ''; return; }
    pv.style.height = ta.offsetHeight + 'px';
  }

  function applySplit() {
    var on = splitOn();
    $('#editor-split').classList.toggle('split-on', on);
    var btn = $('[data-act="toggle-split"]');
    if (btn) btn.setAttribute('aria-pressed', String(on));
    if (on) { renderLivePreview(); syncPreviewSize(); }
  }

  function renderVisibility() {
    var v = S.draft.visibility || 'private';
    $$('[data-vis]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.vis === v));
    });
    var hint = $('#vis-hint');
    if (!hint) return;
    hint.textContent = v === 'public'
      ? '点「发布到 GitHub」后，任何人都能在博客页读到它。'
      : '只有你能看到；存在私有仓库 blog-private，不会出现在网站上。';
    hint.className = 'vis-hint' + (v === 'public' ? ' is-public' : '');
  }

  function fillEditor() {
    $('#d-title').value = S.draft.title;
    $('#d-content').value = S.draft.content;
    $('#d-summary').value = S.draft.summary;
    $('#d-tags').value = S.draft.tags;
    show($('#d-saved'), S.saved);
    renderCounts();
    renderVisibility();
    applySplit();
  }

  function render() {
    renderOwner();
    if (S.view === 'list') renderList();
    if (S.view === 'preview') renderPreview();
  }

  /* ── actions ─────────────────────────────────────────────────────────── */

  function newPost() {
    S.draft = { id: null, title: '', tags: '', summary: '', content: '', visibility: 'private' };
    S.saved = false;
    setView('editor');
    fillEditor();
    $('#d-title').focus();
  }

  function editPost(p) {
    S.draft = {
      id: p.id, title: p.title || '', tags: p.tags || '',
      summary: p.summary || '', content: p.content || '',
      visibility: p.visibility === 'public' ? 'public' : 'private'
    };
    S.saved = false;
    setView('editor');
    fillEditor();
  }

  function backToList() {
    clearTimeout(autosaveTimer);
    if (S.view === 'editor') commitDraft();
    S.pv = null;
    setView('list');
    render();
  }

  function openPost(p) { S.pv = p; setView('preview'); render(); }

  function setVisibilityOf(id, visibility) {
    S.posts = S.posts.map(function (x) {
      return x.id === id ? Object.assign({}, x, {
        visibility: visibility,
        updatedAt: new Date().toISOString(),
        date: (visibility === 'public' && x.visibility !== 'public') ? new Date().toISOString() : x.date
      }) : x;
    });
    persist(S.posts);
    markDirty();
    S.pv = null;
    setView('list');
    render();
  }

  /* ── sync with the two repos ─────────────────────────────────────────── */

  // Local edits are ahead of the repos until a push succeeds. This flag is
  // what drives the "N 篇未发布" nudge — without it the author has no way to
  // tell whether what is live matches what they see.
  function markDirty() {
    try { localStorage.setItem(DIRTY_KEY, '1'); } catch (e) {}
    renderSyncState();
  }
  function clearDirty() {
    try { localStorage.removeItem(DIRTY_KEY); } catch (e) {}
    renderSyncState();
  }
  function isDirty() {
    try { return localStorage.getItem(DIRTY_KEY) === '1'; } catch (e) { return false; }
  }

  function renderSyncState() {
    var bar = $('#sync-bar');
    if (!bar || !S.owner) return;
    var hasTok = window.BlogSync && BlogSync.hasToken();
    show($('#sync-need-token'), !hasTok);
    show($('#sync-actions'), hasTok);
    show($('#sync-dirty'), hasTok && isDirty());
    show($('#sync-clean'), hasTok && !isDirty());
  }

  function setSyncMsg(text, kind) {
    var el = $('#sync-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'sync-msg' + (kind ? ' is-' + kind : '');
  }

  // Repos are the source of truth; the local copy carries unpushed edits.
  // Same id in both → the newer updatedAt wins, so an edit made on another
  // machine and pushed is not clobbered by a stale local copy.
  function mergePosts(remote, local) {
    var byId = new Map();
    remote.forEach(function (p) { byId.set(String(p.id), p); });
    local.forEach(function (p) {
      var key = String(p.id);
      var r = byId.get(key);
      if (!r) { byId.set(key, p); return; }
      var lt = String(p.updatedAt || p.date || '');
      var rt = String(r.updatedAt || r.date || '');
      byId.set(key, lt > rt ? p : r);
    });
    return Array.from(byId.values()).sort(function (a, b) {
      return String(b.date || '').localeCompare(String(a.date || ''));
    });
  }

  function loadFromRepos() {
    var jobs = [BlogSync.fetchPublic()];
    jobs.push(S.owner && BlogSync.hasToken()
      ? BlogSync.fetchPrivate().catch(function (err) {
          setSyncMsg('私密仓库读取失败：' + err.message, 'err');
          return [];
        })
      : Promise.resolve([]));

    return Promise.all(jobs).then(function (r) {
      var remote = r[0].concat(r[1]);
      S.posts = mergePosts(remote, load());
      persist(S.posts);
      render();
    });
  }

  function publishAll() {
    if (!BlogSync.hasToken()) { openTokenSetup(); return; }
    setSyncMsg('正在发布… · Publishing…', 'busy');
    BlogSync.publish(S.posts).then(function (r) {
      clearDirty();
      setSyncMsg('已发布：公开 ' + r.publicCount + ' 篇 · 私密 ' + r.privateCount +
        ' 篇。线上约 1 分钟后更新。', 'ok');
    }).catch(function (err) {
      setSyncMsg('发布失败：' + err.message, 'err');
    });
  }

  function openTokenSetup() {
    show($('#token-dialog'), true);
    $('#token-input').value = '';
    $('#token-status').textContent = '';
    $('#token-input').focus();
  }

  function saveToken() {
    var t = $('#token-input').value.trim();
    if (!t) return;
    BlogSync.setToken(t);
    $('#token-status').textContent = '正在验证… · Verifying…';
    BlogSync.verifyToken().then(function (v) {
      if (!v.privateIsPrivate) {
        BlogSync.clearToken();
        $('#token-status').textContent =
          '中止：blog-private 仓库不是私有的。请先把它设为 Private 再试。';
        return;
      }
      if (!v.publicWritable || !v.privateWritable) {
        BlogSync.clearToken();
        $('#token-status').textContent =
          '令牌能读但不能写。请把权限设成 Contents: Read and write，并确认两个仓库都授权了。';
        return;
      }
      $('#token-status').textContent = '验证通过，两个仓库都可写。';
      show($('#token-dialog'), false);
      renderSyncState();
      loadFromRepos();
    }).catch(function (err) {
      BlogSync.clearToken();
      $('#token-status').textContent = '验证失败：' + err.message;
    });
  }

  function exportJSON() {
    var blob = new Blob([JSON.stringify(S.posts, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'blog-posts.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function importJSON(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var arr = JSON.parse(reader.result);
        if (!Array.isArray(arr)) throw new Error('not an array');
        var byId = new Map(S.posts.map(function (p) { return [p.id, p]; }));
        arr.forEach(function (p) { if (p && p.id) byId.set(p.id, p); });
        S.posts = Array.from(byId.values()).sort(function (a, b) {
          return String(b.date || '').localeCompare(String(a.date || ''));
        });
        persist(S.posts);
        render();
      } catch (err) {
        window.alert('无法导入：不是有效的文章 JSON · Invalid JSON');
      }
    };
    reader.readAsText(file);
  }

  /* ── wiring ──────────────────────────────────────────────────────────── */

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act], [data-status], [data-tag], [data-vis]');
    if (!el) return;

    if (el.dataset.status) { S.status = el.dataset.status; renderList(); return; }
    if (el.dataset.tag) { S.tag = (S.tag === el.dataset.tag) ? null : el.dataset.tag; renderList(); return; }
    if (el.dataset.vis) {
      if (el.dataset.vis === 'public' && S.draft.visibility !== 'public' &&
          !window.confirm('设为公开后，这篇文章会写进公开仓库 ' + BlogSync.config.publicRepo +
            '，任何人都能看到，且会永久留在 git 历史里。确定？')) return;
      S.draft.visibility = el.dataset.vis;
      commitDraft(el.dataset.vis);
      renderVisibility();
      return;
    }

    var row = el.closest('.post-row');
    var post = row && S.posts.find(function (p) { return String(p.id) === row.dataset.id; });
    var act = el.dataset.act;

    if (act === 'open' || act === 'edit' || act === 'delete') e.preventDefault();

    switch (act) {
      case 'new': e.preventDefault(); newPost(); break;
      case 'back': backToList(); break;
      case 'open': if (post) openPost(post); break;
      case 'edit': if (post) editPost(post); break;
      case 'delete':
        if (post && window.confirm(
            isPublic(post)
              ? '这是一篇公开文章，删除后要点「发布」才会从线上消失。确定删除？\nDelete this public post?'
              : 'Delete this post? 确定删除这篇文章？')) {
          S.posts = S.posts.filter(function (x) { return x.id !== post.id; });
          persist(S.posts);
          markDirty();
          renderList();
        }
        break;
      case 'toggle-split':
        try { localStorage.setItem(SPLIT_KEY, splitOn() ? '0' : '1'); } catch (err) {}
        applySplit();
        break;
      case 'save': if (commitDraft()) markSaved(); break;
      case 'preview': {
        var p = commitDraft();
        if (p) openPost(p);
        break;
      }
      case 'edit-pv': if (S.pv) editPost(S.pv); break;
      case 'make-public':
        if (S.pv && window.confirm(
            '设为公开后，这篇文章会写进公开仓库 ' + BlogSync.config.publicRepo +
            '，任何人都能看到，且会永久留在 git 历史里。确定？')) {
          setVisibilityOf(S.pv.id, 'public');
        }
        break;
      case 'make-private': if (S.pv) setVisibilityOf(S.pv.id, 'private'); break;
      case 'prev': if (S._prev) openPost(S._prev); break;
      case 'next': if (S._next) openPost(S._next); break;
      case 'export': exportJSON(); break;
      case 'import': $('#import-file').click(); break;
      case 'publish-all': publishAll(); break;
      case 'setup-token': openTokenSetup(); break;
      case 'save-token': saveToken(); break;
      case 'cancel-token': show($('#token-dialog'), false); break;
      case 'forget-token':
        if (window.confirm('清除本机保存的 GitHub 令牌？之后要重新粘贴才能发布。')) {
          BlogSync.clearToken();
          renderSyncState();
          setSyncMsg('令牌已从本机清除。', 'ok');
        }
        break;
      case 'reload-repos':
        setSyncMsg('正在从仓库拉取… · Reloading…', 'busy');
        loadFromRepos().then(function () { setSyncMsg('已同步。', 'ok'); });
        break;
      case 'lock-in': {
        var pass = window.prompt('输入作者口令 · Enter owner passphrase');
        if (pass == null) break;
        verifyPassphrase(pass).then(function (ok) {
          if (!ok) { window.alert('口令不正确 · Wrong passphrase'); return; }
          try { localStorage.setItem(OWNER_KEY, '1'); } catch (err) {}
          S.owner = true;
          render();
          loadFromRepos();
        }).catch(function (err) {
          if (err.message === 'no-crypto') {
            window.alert('浏览器加密接口不可用：请用 https:// 或 http://localhost 打开，file:// 下无法校验口令。'
              + '\n\nWebCrypto needs a secure context — open the site over https or localhost, not file://.');
          } else {
            window.alert('缺少 assets/auth.js，先运行 node tools/set-passphrase.mjs 生成。'
              + '\n\nassets/auth.js is missing — run node tools/set-passphrase.mjs first.');
          }
        });
        break;
      }
      case 'lock-out':
        try { localStorage.removeItem(OWNER_KEY); } catch (err) {}
        S.owner = false;
        S.pv = null;
        setView('list');
        render();
        break;
    }
  });

  $('#search').addEventListener('input', function (e) { S.q = e.target.value; renderList(); });
  $('#d-title').addEventListener('input', function (e) { onDraftInput('title', e.target.value); });
  $('#d-content').addEventListener('input', function (e) { onDraftInput('content', e.target.value); });
  // (The markdown toolbar fires 'input' on the textarea in both of its apply
  // paths — execCommand and the .value fallback — so the listener above also
  // catches toolbar edits and keeps autosave/word-count in sync.)

  // Keyboard shortcuts, matching github.com's comment box. The vendored
  // toolbar ships none in v2, but each md-* element applies its style from
  // .click(), so a keydown map is all the wiring needed.
  var HOTKEY_IS_MAC = /Mac|iP/.test(navigator.platform);
  $('#d-content').addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229) return;
    var mod = HOTKEY_IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey;
    if (!mod || e.altKey) return;
    var sel;
    if (e.shiftKey) {
      // e.code, not e.key: Shift turns the digit keys into layout-dependent symbols.
      if (e.code === 'Period') sel = 'md-quote';
      else if (e.code === 'Digit7') sel = 'md-ordered-list';
      else if (e.code === 'Digit8') sel = 'md-unordered-list';
    } else {
      var k = e.key.toLowerCase();
      if (k === 'b') sel = 'md-bold';
      else if (k === 'i') sel = 'md-italic';
      else if (k === 'e') sel = 'md-code';
      else if (k === 'k') sel = 'md-link';
    }
    if (!sel) return;
    e.preventDefault();
    var btn = document.querySelector(sel);
    if (btn) btn.click();
  });

  // Keep the preview scrolled proportionally to the write pane.
  $('#d-content').addEventListener('scroll', function () {
    var pv = $('#d-preview');
    if (!splitOn() || !pv) return;
    var max = this.scrollHeight - this.clientHeight;
    if (max <= 0) return;
    pv.scrollTop = (this.scrollTop / max) * (pv.scrollHeight - pv.clientHeight);
  });
  if (window.ResizeObserver) {
    new ResizeObserver(syncPreviewSize).observe($('#d-content'));
  }
  window.matchMedia('(max-width: 900px)').addEventListener('change', syncPreviewSize);

  // Enter inside a list item continues the list; Enter on an empty item ends it.
  // Skipped during IME composition so Chinese input is never intercepted.
  $('#d-content').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    var el = e.target;
    var pos = el.selectionStart;
    if (pos !== el.selectionEnd) return;
    var lineStart = el.value.lastIndexOf('\n', pos - 1) + 1;
    var m = el.value.slice(lineStart, pos).match(/^(\s*)(?:([-*])|(\d+)\.)\s(.*)$/);
    if (!m) return;
    e.preventDefault();
    if (!m[4]) {
      // Empty item: end the list by deleting the dangling marker.
      el.setSelectionRange(lineStart, pos);
      document.execCommand('delete');
      return;
    }
    var marker = m[2] ? m[2] + ' ' : (parseInt(m[3], 10) + 1) + '. ';
    // execCommand keeps the native undo stack and fires 'input' for autosave.
    if (!document.execCommand('insertText', false, '\n' + m[1] + marker)) {
      var ins = '\n' + m[1] + marker;
      el.value = el.value.slice(0, pos) + ins + el.value.slice(pos);
      el.setSelectionRange(pos + ins.length, pos + ins.length);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  $('#d-summary').addEventListener('input', function (e) { onDraftInput('summary', e.target.value); });
  $('#d-tags').addEventListener('input', function (e) { onDraftInput('tags', e.target.value); });
  $('#import-file').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (f) importJSON(f);
    e.target.value = '';
  });
  window.addEventListener('beforeunload', function (e) {
    if (S.view === 'editor') commitDraft();
    // Unpushed work is invisible to everyone else, and clearing the browser
    // loses it — worth one confirm before navigating away.
    if (S.owner && isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });
  $('#token-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); saveToken(); }
  });

  /* ── boot ────────────────────────────────────────────────────────────── */

  // Posts written before the public/private split carried status:
  // published|draft. Map them across; published becomes public, everything
  // else becomes private, which is the safe direction to guess.
  function migrate(posts) {
    var changed = false;
    var out = posts.map(function (p) {
      if (p.visibility === 'public' || p.visibility === 'private') return p;
      changed = true;
      return Object.assign({}, p, {
        visibility: p.status === 'published' ? 'public' : 'private'
      });
    });
    if (changed) persist(out);
    return out;
  }

  S.posts = migrate(load());
  try { S.owner = localStorage.getItem(OWNER_KEY) === '1'; } catch (e) {}
  render();
  loadFromRepos();
})();
