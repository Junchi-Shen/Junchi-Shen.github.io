# Junchi Shen — 个人主页

Built from the Claude Design handoff `个人背景网站设计` (`Blog.dc.html` +
`Junchi Shen Personal Site v2.dc.html`). Plain static HTML/CSS/JS — no build
step, no dependencies. Open `index.html` in a browser and it works.

```
index.html          主页 · home (hero, papers, projects, Qbitbrief, education, contact)
blog.html           博客 · blog (list / editor / preview)
assets/ds.css       Classical design system — tokens + component classes (from the handoff, unchanged)
assets/site.css     页面样式 · page styles + responsive rules
assets/site.js      中英切换 · the bilingual switch
assets/blog.js      博客逻辑 · blog logic (localStorage-backed)
assets/portrait.jpg 个人照片 —— 放进来即可显示，没有就显示占位框
```

## 中英切换

Nav 里的 `双语 / EN / 中` 三档，选择记在 localStorage。设计稿把 language 做成
作者端的属性，线上需要一个可点的控件，所以做成了这个开关。默认双语。

## 博客怎么用

文章存在**这台电脑的这个浏览器**的 localStorage 里（`jsblog-posts`），没有服务器。

- 页脚 **作者登录**，口令 `qbit-2026`（改口令：`assets/blog.js` 里的 `OWNER_PASS`）
- 登录后出现 **写文章**、草稿筛选、编辑/删除、导出/导入
- 正文支持 Markdown 子集：`##` `###` 标题、`**粗体**`、`*强调*`、`` `代码` ``、
  `-` 列表、`>` 引用、`---` 分隔线；空行分段
- 输入时每 1.2 秒自动存草稿；草稿只有登录后可见，访客只看到已发布的文章

**口令不是访问控制**：它只是切换作者界面的开关，全部内容都在浏览器本地，
换台电脑或清缓存就没了。定期用 **导出 JSON** 备份。

如果以后想让文章对所有访客可见、跨设备同步，就需要一个真的后端
（或把文章改成仓库里的 Markdown 文件在构建时生成）——现在这套是单机版。

## 部署

任何静态托管都可以直接放：

```bash
cd ~/Documents/"Personal Blog" && python3 -m http.server 8765
```

Cloudflare Pages / GitHub Pages 直接指到这个目录即可，无需构建命令。
注意本地预览要用 `http://`，`file://` 下浏览器会禁用 localStorage，博客存不了东西。
