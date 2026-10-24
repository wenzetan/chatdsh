# 界面设计参考页面

本目录是可渲染的界面参考页面，配合 [`../ui-baseline-design.md`](../ui-baseline-design.md) 使用。页面只引用目录内的相对路径资源，可以直接用任意静态服务器打开。

| 文件 | 用途 |
|---|---|
| `index.html` | 审阅入口：四端主页面预览、全局与单张卡片的配色切换 |
| `style-baseline.html` | 风格基准：令牌取值、字号层级、尺度、控件样张、状态版式 |
| `web-main.html` | Web 端主页面 |
| `desktop-main.html` | 桌面端主页面 |
| `mobile-main.html` | 移动端主页面（会话页与审批接管两屏） |
| `cli-main.html` | 命令行主页面 |
| `tokens.css` | 设计令牌，暗色与亮色两套取值集中在此文件 |
| `app.css` | 应用层组件样式，四端页面共用 |
| `baseline.css` | 风格基准页专用样式 |
| `palette.js` | 基准页的调色板渲染与配色切换 |
| `scheme.js` | 参考页面的配色选择，读取地址参数 |

打开方式：

```
python3 -m http.server 8791 --directory runtime/docs/ui-design
```

浏览器访问 `http://127.0.0.1:8791/index.html`。单个页面带配色参数打开，例如 `web-main.html?scheme=light`；不带参数为暗色。
