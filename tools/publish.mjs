#!/usr/bin/env node
/*
 * Publish without putting a GitHub token in the browser.
 *
 *   1. In the blog editor, click 导出 JSON  (exports every post)
 *   2. node tools/publish.mjs [path-to-export.json]
 *
 * With no path it takes the newest blog-posts*.json from ~/Downloads.
 *
 * Public posts are written to content/posts.json here and committed. Private
 * posts are pushed to the separate private repo if it is cloned as a sibling
 * directory; otherwise the script says so and leaves them alone rather than
 * silently dropping them.
 *
 * The one rule this file exists to enforce: a post whose visibility is not
 * exactly 'public' never reaches content/posts.json, because that file is
 * served to the world.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_FILE = join(ROOT, 'content', 'posts.json');
const PRIVATE_REPO = join(ROOT, '..', 'blog-private');

function die(msg) { console.error('\n✗ ' + msg + '\n'); process.exit(1); }

function newestExport() {
  const dl = join(homedir(), 'Downloads');
  if (!existsSync(dl)) return null;
  const hits = readdirSync(dl)
    .filter(f => /^blog-posts.*\.json$/i.test(f))
    .map(f => ({ f: join(dl, f), t: statSync(join(dl, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return hits.length ? hits[0].f : null;
}

const src = process.argv[2] || newestExport();
if (!src) die('找不到导出文件。先在编辑器里点「导出 JSON」，或把路径传给这个脚本：\n  node tools/publish.mjs ~/Downloads/blog-posts.json');
if (!existsSync(src)) die('文件不存在：' + src);

let parsed;
try { parsed = JSON.parse(readFileSync(src, 'utf8')); }
catch (e) { die('不是有效的 JSON：' + src + '\n  ' + e.message); }

const posts = Array.isArray(parsed) ? parsed : (parsed.posts || []);
if (!Array.isArray(posts)) die('JSON 里找不到文章数组。');

const pub = posts.filter(p => p && p.visibility === 'public');
const priv = posts.filter(p => p && p.visibility !== 'public');

// The guard. Assert rather than filter — if a private post got this far, the
// upstream export is broken and quietly dropping it would hide that.
const leaked = pub.filter(p => p.visibility !== 'public');
if (leaked.length) die(`拒绝写入：公开集合里混进了 ${leaked.length} 篇非公开文章。`);

console.log(`\n读取 ${src}`);
console.log(`  公开 ${pub.length} 篇  →  content/posts.json（全世界可见）`);
console.log(`  私密 ${priv.length} 篇  →  ${existsSync(PRIVATE_REPO) ? 'blog-private 仓库' : '未处理（见下）'}`);

if (pub.length) {
  console.log('\n将要公开：');
  for (const p of pub) console.log('  · ' + (p.title || '(无题)'));
}

writeFileSync(PUBLIC_FILE, JSON.stringify({
  version: 1,
  note: 'Public blog posts. Written by tools/publish.mjs — do not hand-edit. Everything in this file is world-readable, including in git history after deletion.',
  generatedAt: new Date().toISOString(),
  posts: pub
}, null, 2) + '\n');

const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8' });

git(['add', 'content/posts.json']);
if (git(['status', '--porcelain', 'content/posts.json']).trim()) {
  git(['commit', '-m', `Publish ${pub.length} public post(s)`]);
  git(['push']);
  console.log('\n✓ 公开文章已推送，约 1 分钟后线上生效。');
} else {
  console.log('\n· 公开文章无变化，跳过提交。');
}

if (!priv.length) {
  console.log('· 没有私密文章。\n');
} else if (!existsSync(PRIVATE_REPO)) {
  console.log(`\n! 私密文章没有同步：找不到 ${PRIVATE_REPO}`);
  console.log('  要同步的话先克隆：');
  console.log('    git clone https://github.com/Junchi-Shen/blog-private.git ' + PRIVATE_REPO);
  console.log('  它们仍然安全地留在你的浏览器里，没有丢。\n');
} else {
  writeFileSync(join(PRIVATE_REPO, 'posts.json'), JSON.stringify({
    version: 1,
    note: 'Private posts. This repo must stay private.',
    generatedAt: new Date().toISOString(),
    posts: priv
  }, null, 2) + '\n');
  git(['add', 'posts.json'], PRIVATE_REPO);
  if (git(['status', '--porcelain', 'posts.json'], PRIVATE_REPO).trim()) {
    git(['commit', '-m', `Sync ${priv.length} private post(s)`], PRIVATE_REPO);
    git(['push'], PRIVATE_REPO);
    console.log('✓ 私密文章已同步到 blog-private。\n');
  } else {
    console.log('· 私密文章无变化。\n');
  }
}
