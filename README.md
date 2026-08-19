# Junchi Shen — 个人主页

Built from the Claude Design handoff `个人背景网站设计` (`Blog.dc.html` +
`Junchi Shen Personal Site v2.dc.html`). Plain static HTML/CSS/JS — no build
step, no dependencies. Open `index.html` in a browser and it works.

**改这个站怎么改**，看 [develop.html](develop.html) —— 哪里加、哪里减、哪里别动，
带可直接粘贴的模板。线上：https://junchi-shen.github.io/develop.html
（noindex，不进搜索结果，也没挂在导航里）

```
index.html          主页 · home (hero, papers, projects, Qbitbrief, education, contact)
blog.html           博客 · blog (list / editor / preview)
develop.html        开发文档 · how to edit this site
assets/ds.css       Classical design system — tokens + component classes (from the handoff, unchanged)
assets/site.css     页面样式 · page styles + responsive rules
assets/site.js      中英切换 · the bilingual switch
assets/blog.js      博客逻辑 · blog logic (editor, markdown, live preview)
assets/sync.js      公开/私密两个仓库的读写 · the public/private repo split
assets/portrait.jpg 个人照片 —— 放进来即可显示，没有就显示占位框
content/posts.json  公开文章（编辑器生成，全世界可读）
tools/publish.mjs   不用浏览器令牌的发布脚本
```

## 中英切换

Nav 里的 `双语 / EN / 中` 三档，选择记在 localStorage。设计稿把 language 做成
作者端的属性，线上需要一个可点的控件，所以做成了这个开关。默认双语。

## 博客怎么用

每篇文章有一个可见性，决定它写进**哪个仓库**：

| 可见性 | 存到 | 谁能看到 |
|---|---|---|
| **公开 Public** | 本仓库 `content/posts.json` | **所有人**，访客静态 fetch，不需登录 |
| **私密 Private** | `Junchi-Shen/blog-private`（私有仓库） | 只有你，访客的浏览器根本收不到 |

私密文章之所以必须待在另一个仓库：本仓库是公开的，里面**任何**文件一条 `curl`
就能读，删了也留在 git 历史里。「放公开仓库但界面不显示」等于没有私密。

发布（浏览器 → 仓库需要一座桥，两条路任选）：

1. **浏览器直连**——列表页「连接 GitHub」粘一个 fine-grained token
   （只授权那两个仓库、只给 Contents 读写），之后点「发布到 GitHub」一键写两边。
   令牌只存在本机浏览器的 localStorage。
2. **不想在浏览器放令牌**——点「导出 JSON」，然后 `node tools/publish.mjs`。
   私密那半需要先把 `blog-private` 克隆成本项目的同级目录。

两条路共用同一道硬检查：`visibility` 不严格等于 `'public'` 的文章一律不许进
`content/posts.json`，检测到就报错中止而不是悄悄过滤；没有 `visibility` 字段的
按私密处理。

本机 localStorage 仍是工作副本，和仓库按 `updatedAt` 合并、新的赢。

- 页脚 **作者登录**，口令见本机 `.env`（`BLOG_OWNER_PASSPHRASE`，已 gitignore）
- 登录后出现 **写文章**、公开/私密筛选、编辑/删除、发布、导出/导入
- 新文章默认**私密**；改成公开要过一次确认（这是不可逆的：一旦推上去就进了 git 历史）
- 正文支持 Markdown 子集：`##` `###` 标题、`**粗体**`、`*强调*`、`~~删除线~~`、
  `` `代码` ``、``` 代码块、`-` 列表、`1.` 有序列表、`>` 引用、`[链接](url)`、
  `---` 分隔线；空行分段
- 输入时每 1.2 秒自动存到本机；私密文章只有登录后可见，访客只看到公开的

## 编辑器

工具条用的是 GitHub 评论框同款组件
[`@github/markdown-toolbar-element`](https://github.com/github/markdown-toolbar-element)
（MIT，零依赖，vendored 在 `assets/vendor/`，本地补丁见文件头注释：去掉了
ESM export、斜体 `_x_` 改为 `*x*` 以匹配本站渲染器）。

快捷键（Mac ⌘ / Windows Ctrl）：

| 快捷键 | 作用 |
|---|---|
| ⌘B | **粗体** |
| ⌘I | *斜体* |
| ⌘E | `代码` |
| ⌘K | 插入链接 |
| ⌘⇧. | 引用 |
| ⌘⇧8 | 无序列表 |
| ⌘⇧7 | 有序列表 |

列表内按回车自动续下一项（有序列表自动递增编号），空项上回车退出列表；
中文输入法组词时的回车不受影响。撤销（⌘Z）对以上操作全部有效。

**实时预览**：编辑器默认左右分栏，右栏用与发布页同一个渲染器逐键渲染，
所见即所发；滚动按比例联动，右栏高度跟随写作区。工具条右端的
「实时预览」按钮可关（选择记住在 localStorage）；窄屏改为上下堆叠。

## 口令怎么存的

明文只在本机 `.env`（gitignore，不进仓库、不上线）。上线的是
`assets/auth.js` 里的 **PBKDF2-SHA256 摘要**（21 万轮 + 16 字节随机 salt），
浏览器用 WebCrypto 现算现比。

改口令：

```bash
node tools/set-passphrase.mjs "新的口令至少十二位"
git add -A && git commit -m "rotate owner passphrase" && git push
```

不带参数运行则读 `.env` 里的值重新生成。

**摘要是公开的，这挡不住任何人。** 静态站没有服务器可以验密码，浏览器拿来比对的
东西访客一样能看到；而且谁都可以在控制台直接
`localStorage.setItem('jsblog-owner','1')` 打开作者界面。哈希的作用只有一个：
明文不进仓库、不会被顺着 GitHub 搜到、也不会连累你在别处复用的同一串密码。

真正把私密文章挡住的**不是这个口令，是仓库的可见性**：私密文章存在私有仓库
`blog-private` 里，访客的浏览器压根收不到那些字节，没有 GitHub 令牌就读不到。
口令只是决定要不要在界面上显示作者功能。

**已发布的文章跨设备可用**（存在仓库里）；**还没点过「发布」的改动只在本机**，
换电脑或清缓存就没了。列表页顶部会提示「本地有改动尚未发布」。

要更强的鉴权（比如私密文章也能在任意设备免令牌读写）就得有后端，
Cloudflare Worker + KV 那一套 —— 目前没做。

## 部署

任何静态托管都可以直接放：

```bash
cd ~/Documents/"Personal Blog" && python3 -m http.server 8765
```

Cloudflare Pages / GitHub Pages 直接指到这个目录即可，无需构建命令。

本地预览用 `http://`，别双击文件走 `file://`。原因不是 `file://` 不能用
（实测 Chrome 下 localStorage、WebCrypto 都正常），而是 **origin 对不上**：
`file://` 和 `http://localhost:8765` 各有各的 localStorage，在一边写的文章
另一边看不到；而且所有 `file://` 页面共用同一个 origin。
