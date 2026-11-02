# 界面设计参考页面

完整产品设计使用[完整客户端设计稿](<complete.html>)，包含 S01–S32、暗色/亮色/高对比度、响应式画板和通用状态。页面仅使用本地资源，可以直接打开；画板明确标注设计示例与未连接业务服务。字段、行为与验收使用[完整交互规格](<../client-complete-spec.md>)，实施使用[工作包](<../implementation-work-packages.md>)。

[基础样张目录](<catalog.html>)与原有页面用于查看基础视觉组件；产品交互使用完整设计稿和完整规格。完整稿资源为[页面入口](<complete.html>)、[样式](<complete.css>)、[场景一至十六](<complete.js>)、[场景十七至三十二](<complete-more.js>)和[补充画板](<complete-details.js>)，共享[基础令牌](<tokens.css>)。

| 文件 | 用途 |
|---|---|
| `index.html` | 审阅入口：四端主页面预览、全局与单张卡片的配色切换 |
| `catalog.html` | 页面目录：全部二十一个参考页面，配色开关带到每个链接 |
| `style-baseline.html` | 风格基准：令牌取值、字号层级、尺度、控件样张、状态版式 |
| `web-main.html` | Web 端主页面 |
| `desktop-main.html` | 桌面端主页面 |
| `mobile-main.html` | 移动端主页面（会话页与审批接管两屏） |
| `cli-main.html` | 命令行主页面 |
| `pages/` | 补充页面：进入与身份、设置、控制平面、停靠栏、原生部件、命令行、状态版式，清单见 [`pages/README.md`](pages/README.md) |
| `tokens.css` | 设计令牌，暗色与亮色两套取值集中在此文件 |
| `app.css` | 应用层组件样式，四端页面共用 |
| `pages.css` | 参考页版式：页面骨架、设置外壳、表单、表格、对话框、文件树、终端、原生窗口、移动端、命令行画布 |
| `baseline.css` | 风格基准页专用样式 |
| `palette.js` | 基准页的调色板渲染与配色切换 |
| `scheme.js` | 参考页面的配色选择，读取地址参数 |

打开方式：

```
python3 -m http.server 8791 --directory runtime/docs/ui-design
```

浏览器访问 `http://127.0.0.1:8791/index.html`，页面目录在 `http://127.0.0.1:8791/catalog.html`。单个页面带配色参数打开，例如 `web-main.html?scheme=light`；不带参数为暗色。
