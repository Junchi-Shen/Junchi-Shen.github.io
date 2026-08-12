/* Blog — list / editor / preview, backed by localStorage.
   A faithful port of the Claude Design prototype's logic to plain JS.

   Note on "owner mode": the passphrase is a convenience switch for the
   authoring UI only. Everything lives in this browser's localStorage, so it
   is not access control — nothing here is secret and nothing is on a server. */
(function () {
  var POSTS_KEY = 'jsblog-posts';
  var OWNER_KEY = 'jsblog-owner';
  var OWNER_PASS = 'qbit-2026';
  var AUTOSAVE_MS = 1200;

  var S = {
    view: 'list',
    posts: [],
    draft: { id: null, title: '', tags: '', summary: '', content: '' },
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

  /* ── markdown ────────────────────────────────────────────────────────── */

  function mdInline(text) {
    // Escape first, then apply inline marks — the markers survive escaping.
    return esc(text)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function mdRender(md) {
    var lines = String(md || '').split('\n');
    var out = [], para = [], list = null, quote = null;

    function flushP() {
      if (para.length) { out.push('<p>' + mdInline(para.join(' ')) + '</p>'); para = []; }
    }
    function flushL() {
      if (list) {
        out.push('<ul>' + list.map(function (it) { return '<li>' + mdInline(it) + '</li>'; }).join('') + '</ul>');
        list = null;
      }
    }
    function flushQ() {
      if (quote) { out.push('<blockquote>' + mdInline(quote.join(' ')) + '</blockquote>'); quote = null; }
    }
    function flushAll() { flushP(); flushL(); flushQ(); }

    lines.forEach(function (raw) {
      var t = raw.trim();
      if (!t) { flushAll(); return; }
      if (/^---+$/.test(t)) { flushAll(); out.push('<hr>'); return; }
      if (t.indexOf('### ') === 0) { flushAll(); out.push('<h3>' + mdInline(t.slice(4)) + '</h3>'); return; }
      if (t.indexOf('## ') === 0) { flushAll(); out.push('<h2>' + mdInline(t.slice(3)) + '</h2>'); return; }
      if (t.indexOf('- ') === 0 || t.indexOf('* ') === 0) { flushP(); flushQ(); (list = list || []).push(t.slice(2)); return; }
      if (t.indexOf('> ') === 0) { flushP(); flushL(); (quote = quote || []).push(t.slice(2)); return; }
      para.push(t);
    });
    flushAll();
    return out.length ? out.join('') : '<p class="empty">(empty 空)</p>';
  }

  /* ── draft persistence ───────────────────────────────────────────────── */

  function commitDraft(status) {
    var d = S.draft;
    if (!d.title.trim() && !d.content.trim()) return null;
    var posts = S.posts.slice();
    var i = posts.findIndex(function (p) { return p.id === d.id; });
    var base = i >= 0 ? posts[i] : { id: d.id || Date.now(), date: new Date().toISOString(), status: 'draft' };
    var post = {
      id: base.id, date: base.date, status: base.status,
      title: d.title.trim() || 'Untitled 无题',
      tags: d.tags.trim(),
      summary: (d.summary || '').trim(),
      content: d.content
    };
    if (status) { post.status = status; post.date = new Date().toISOString(); }
    if (i >= 0) posts[i] = post; else posts.unshift(post);
    S.posts = posts;
    S.draft.id = post.id;
    persist(posts);
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

  function visiblePosts() {
    var q = S.q.toLowerCase();
    return S.posts.filter(function (p) {
      if (!S.owner && p.status !== 'published') return false;
      if (S.status === 'pub' && p.status !== 'published') return false;
      if (S.status === 'draft' && p.status === 'published') return false;
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
    var text = String(p.content || '').replace(/[#>*`-]/g, '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 150) + (String(p.content || '').trim().length > 150 ? '…' : '');
  }

  function renderCounts() {
    $('#d-chars').textContent = chars(S.draft.content);
    $('#d-read').textContent = readTime(S.draft.content);
  }

  function renderList() {
    var published = S.posts.filter(function (p) { return p.status === 'published'; });
    $('#pub-count').textContent = published.length;
    $('#draft-count').textContent = S.posts.length - published.length;

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
              (p.status !== 'published'
                ? '<span class="tag tag-outline"><span data-en>Draft</span><span data-sep> </span><span data-zh lang="zh">草稿</span></span>'
                : '') +
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
    var isDraft = (pv.status || 'draft') !== 'published';

    show($('#pv-draft-bar'), isDraft && S.owner);
    show($('#pv-pub-bar'), !isDraft && !!S.pv && S.owner);
    show($('#pv-draft-flag'), isDraft);

    $('#pv-date').textContent = fmtDate(pv.date);
    $('#pv-read').textContent = readTime(pv.content);
    $('#pv-tags').textContent = parseTags(pv).join(' · ');
    $('#pv-title').textContent = pv.title || '';
    var hasSummary = !!(pv.summary && pv.summary.trim());
    show($('#pv-summary'), hasSummary);
    $('#pv-summary').textContent = pv.summary || '';
    $('#pv-body').innerHTML = mdRender(pv.content);

    var published = S.posts.filter(function (p) { return p.status === 'published'; });
    var i = published.findIndex(function (p) { return p.id === pv.id; });
    var prev = i > 0 ? published[i - 1] : null;
    var next = (i >= 0 && i < published.length - 1) ? published[i + 1] : null;
    show($('#pv-newer'), !!prev);
    show($('#pv-older'), !!next);
    if (prev) $('#pv-prev-title').textContent = prev.title || '';
    if (next) $('#pv-next-title').textContent = next.title || '';
    S._prev = prev; S._next = next;
  }

  function fillEditor() {
    $('#d-title').value = S.draft.title;
    $('#d-content').value = S.draft.content;
    $('#d-summary').value = S.draft.summary;
    $('#d-tags').value = S.draft.tags;
    show($('#d-saved'), S.saved);
    renderCounts();
  }

  function render() {
    renderOwner();
    if (S.view === 'list') renderList();
    if (S.view === 'preview') renderPreview();
  }

  /* ── actions ─────────────────────────────────────────────────────────── */

  function newPost() {
    S.draft = { id: null, title: '', tags: '', summary: '', content: '' };
    S.saved = false;
    setView('editor');
    fillEditor();
    $('#d-title').focus();
  }

  function editPost(p) {
    S.draft = {
      id: p.id, title: p.title || '', tags: p.tags || '',
      summary: p.summary || '', content: p.content || ''
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

  function setStatusOf(id, status) {
    S.posts = S.posts.map(function (x) {
      return x.id === id ? Object.assign({}, x, {
        status: status,
        date: status === 'published' ? new Date().toISOString() : x.date
      }) : x;
    });
    persist(S.posts);
    S.pv = null;
    setView('list');
    render();
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
    var el = e.target.closest('[data-act], [data-status], [data-tag]');
    if (!el) return;

    if (el.dataset.status) { S.status = el.dataset.status; renderList(); return; }
    if (el.dataset.tag) { S.tag = (S.tag === el.dataset.tag) ? null : el.dataset.tag; renderList(); return; }

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
        if (post && window.confirm('Delete this post? 确定删除这篇文章？')) {
          S.posts = S.posts.filter(function (x) { return x.id !== post.id; });
          persist(S.posts);
          renderList();
        }
        break;
      case 'save': if (commitDraft()) markSaved(); break;
      case 'preview': {
        var p = commitDraft();
        if (p) openPost(p);
        break;
      }
      case 'edit-pv': if (S.pv) editPost(S.pv); break;
      case 'publish': if (S.pv) setStatusOf(S.pv.id, 'published'); break;
      case 'unpublish': if (S.pv) setStatusOf(S.pv.id, 'draft'); break;
      case 'prev': if (S._prev) openPost(S._prev); break;
      case 'next': if (S._next) openPost(S._next); break;
      case 'export': exportJSON(); break;
      case 'import': $('#import-file').click(); break;
      case 'lock-in': {
        var pass = window.prompt('输入作者口令 · Enter owner passphrase');
        if (pass == null) break;
        if (pass === OWNER_PASS) {
          try { localStorage.setItem(OWNER_KEY, '1'); } catch (err) {}
          S.owner = true;
          render();
        } else {
          window.alert('口令不正确 · Wrong passphrase');
        }
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
  $('#d-summary').addEventListener('input', function (e) { onDraftInput('summary', e.target.value); });
  $('#d-tags').addEventListener('input', function (e) { onDraftInput('tags', e.target.value); });
  $('#import-file').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (f) importJSON(f);
    e.target.value = '';
  });
  window.addEventListener('beforeunload', function () {
    if (S.view === 'editor') commitDraft();
  });

  /* ── boot ────────────────────────────────────────────────────────────── */

  S.posts = load();
  try { S.owner = localStorage.getItem(OWNER_KEY) === '1'; } catch (e) {}
  render();
})();
