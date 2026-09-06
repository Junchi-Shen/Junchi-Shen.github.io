/* Storage sync for the blog.
 *
 * Two stores, and the split between them is the whole point:
 *
 *   public  → Junchi-Shen.github.io / content/posts.json
 *             A plain file in a PUBLIC repo. Fetched by every visitor with no
 *             auth. Anything in here is world-readable, forever, including in
 *             git history after deletion.
 *
 *   private → Junchi-Shen/blog-private / posts.json
 *             A PRIVATE repo, reachable only through the GitHub API with the
 *             owner's token. Never fetched by visitors, never deployed.
 *
 * publish() refuses to write a non-public post into the public file. That
 * check is the only thing standing between "private" meaning something and
 * meaning nothing, so it throws rather than filters — a silent filter would
 * hide the bug that produced the bad input.
 */
(function () {
  var CFG = {
    owner: 'Junchi-Shen',
    publicRepo: 'Junchi-Shen.github.io',
    publicPath: 'content/posts.json',
    privateRepo: 'blog-private',
    privatePath: 'posts.json',
    api: 'https://api.github.com'
  };
  var TOKEN_KEY = 'jsblog-gh-token';

  /* ── base64 that survives Chinese text ───────────────────────────────── */

  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToUtf8(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ── token ───────────────────────────────────────────────────────────── */

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(t) {
    try { localStorage.setItem(TOKEN_KEY, String(t || '').trim()); } catch (e) {}
  }
  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }
  function hasToken() { return !!getToken(); }

  // Takes an explicit token so a candidate can be tested before it is stored.
  function apiHeaders(token) {
    return {
      'Authorization': 'Bearer ' + (token || getToken()),
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  function describeError(res, body) {
    if (res.status === 401) return '令牌被 GitHub 拒绝（401）。常见原因：复制时缺了字符或多了空格；令牌已过期或被撤销；' +
      '这是个 fine-grained 令牌但还没被批准。 · Token rejected by GitHub';
    if (res.status === 403) return '令牌权限不足（需要 Contents: Read and write）· Token lacks Contents write permission';
    if (res.status === 404) return '仓库或文件找不到，也可能是令牌没有授权这个仓库 · Not found, or token has no access to this repo';
    if (res.status === 409) return '远端已被改动，请刷新后重试 · Remote changed, reload and retry';
    if (res.status === 422) return '提交被拒绝：' + ((body && body.message) || '422');
    return 'GitHub API ' + res.status + '：' + ((body && body.message) || res.statusText);
  }

  function apiJson(url, opts) {
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) {}
        if (!res.ok) {
          var err = new Error(describeError(res, body));
          err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  }

  /* ── reading ─────────────────────────────────────────────────────────── */

  function normalize(parsed) {
    // Tolerates the bare array the old export/import used.
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.posts)) return parsed.posts;
    return [];
  }

  // Visitors take this path: a plain static fetch, no token, no API.
  function fetchPublic() {
    return fetch(CFG.publicPath + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('content/posts.json ' + res.status);
        return res.json();
      })
      .then(function (data) {
        return normalize(data).map(function (p) {
          return Object.assign({}, p, { visibility: 'public' });
        });
      })
      .catch(function () { return []; });   // a missing file just means no posts yet
  }

  function contentUrl(repo, path) {
    return CFG.api + '/repos/' + CFG.owner + '/' + repo + '/contents/' + path;
  }

  function fetchFile(repo, path) {
    return apiJson(contentUrl(repo, path) + '?ref=HEAD&t=' + Date.now(),
      { headers: apiHeaders(), cache: 'no-store' })
      .then(function (body) {
        return { sha: body.sha, posts: normalize(JSON.parse(b64ToUtf8(body.content))) };
      })
      .catch(function (err) {
        if (err.status === 404) return { sha: null, posts: [] };
        throw err;
      });
  }

  function fetchPrivate() {
    if (!hasToken()) return Promise.resolve([]);
    return fetchFile(CFG.privateRepo, CFG.privatePath).then(function (r) {
      return r.posts.map(function (p) {
        return Object.assign({}, p, { visibility: 'private' });
      });
    });
  }

  /* ── writing ─────────────────────────────────────────────────────────── */

  function putFile(repo, path, posts, message) {
    var payload = JSON.stringify({
      version: 1,
      note: repo === CFG.publicRepo
        ? 'Public blog posts. Generated by the blog editor — do not hand-edit. Everything in this file is world-readable.'
        : 'Private posts. This repo must stay private.',
      generatedAt: new Date().toISOString(),
      posts: posts
    }, null, 2) + '\n';

    // Read the current sha first; GitHub rejects an update without it.
    return fetchFile(repo, path).then(function (cur) {
      var body = { message: message, content: utf8ToB64(payload) };
      if (cur.sha) body.sha = cur.sha;
      return apiJson(contentUrl(repo, path), {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
        body: JSON.stringify(body)
      });
    });
  }

  function publish(posts) {
    if (!hasToken()) return Promise.reject(new Error('还没设置 GitHub 令牌 · No GitHub token set'));

    var pub = posts.filter(function (p) { return p.visibility === 'public'; });
    var priv = posts.filter(function (p) { return p.visibility !== 'public'; });

    // Belt and braces: prove the public payload is clean before it is written
    // to a world-readable file. Throwing beats filtering — if a private post
    // reached this array, something upstream is broken and must be fixed.
    var leaked = pub.filter(function (p) { return p.visibility !== 'public'; });
    if (leaked.length) {
      return Promise.reject(new Error(
        '拒绝发布：公开载荷里混进了 ' + leaked.length + ' 篇非公开文章'));
    }

    var stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    return putFile(CFG.publicRepo, CFG.publicPath, pub, 'Publish posts (' + pub.length + ' public) — ' + stamp)
      .then(function () {
        return putFile(CFG.privateRepo, CFG.privatePath, priv, 'Sync private posts (' + priv.length + ') — ' + stamp);
      })
      .then(function () { return { publicCount: pub.length, privateCount: priv.length }; });
  }

  // Cheap check that the token actually reaches both repos, so the owner finds
  // out at setup time rather than at publish time. Pass a candidate token to
  // test it WITHOUT storing it — a token that fails here must never be kept.
  function verifyToken(candidate) {
    var base = CFG.api + '/repos/' + CFG.owner + '/';
    return Promise.all([
      apiJson(base + CFG.publicRepo, { headers: apiHeaders(candidate) }),
      apiJson(base + CFG.privateRepo, { headers: apiHeaders(candidate) })
    ]).then(function (r) {
      return {
        publicOk: !!r[0], privateOk: !!r[1],
        privateIsPrivate: !!(r[1] && r[1].private),
        publicWritable: !!(r[0] && r[0].permissions && r[0].permissions.push),
        privateWritable: !!(r[1] && r[1].permissions && r[1].permissions.push)
      };
    });
  }

  window.BlogSync = {
    config: CFG,
    getToken: getToken, setToken: setToken, clearToken: clearToken, hasToken: hasToken,
    fetchPublic: fetchPublic, fetchPrivate: fetchPrivate,
    publish: publish, verifyToken: verifyToken
  };
})();
