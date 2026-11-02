# @chatdsh/client-pwa

可安装壳、静态资源缓存、受控更新、浏览器权限、受保护凭据、离线草稿与移动布局。静态资源路由、构建接入与
发布版本注入属于 WP39；本包只产出内容、判定逻辑与浏览器侧界面。

## 静态资源

宿主用 `pwaStaticContent({ version })` 生成三份响应体，按固定路径提供：

| 路径 | 内容 | 响应内容类型 |
|---|---|---|
| `/manifest.webmanifest` | 应用清单 | `application/manifest+json` |
| `/sw.js` | Service Worker 脚本 | `text/javascript; charset=utf-8` |
| `/offline.html` | 离线回退页 | `text/html; charset=utf-8` |

图标位于 `assets/icons/`，清单按 `/assets/icons/*.png` 引用并在地址后附版本查询串。图标是按设计令牌品牌色
生成的占位图，由 `node packages/client/pwa/scripts/generate-icons.mjs` 重新生成，内容稳定。Service Worker
脚本必须由根路径提供，作用域才会覆盖整个客户端；脚本响应使用 `cache-control: no-store`，注册时使用
`updateViaCache: 'none'`。

页面需要三件事：`#chatdsh-pwa` 容器、主题插件已注入的令牌样式，以及下面这行视口声明。

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
```

## 浏览器侧

`src/client/index.ts` 导出 `startPwa`、`mountPwaUi` 与 `createPwa`，插件入口 `apply` 在页面存在
`#chatdsh-pwa` 容器时挂载界面。运行时把清单、Service Worker、权限、凭据、草稿、配对与移动布局装成一份
对象，界面只通过它取状态。

```ts
const ui = await startPwa(document.getElementById('chatdsh-pwa'), {
  version: '2026-11-02.1',
  navigation: { workspace: '/work/alpha', deviceId: 'device-1', unread: 2, updatedAt: Date.now() },
  draft: { deviceId: 'device-1', sessionId: 'session-1' },
  sendEndpoint: '/chatdsh/client/messages',
});
```

## Service Worker 缓存

缓存名是 `chatdsh-pwa-static-<版本>`，激活时删除同前缀的旧版本缓存。只缓存两类内容：预缓存清单里的应用壳、
离线页、清单与图标，以及 `/assets/` 下扩展名在允许列表内的静态资源。以下请求一律直连网络，命中时不读也不写
缓存：

- `/chatdsh/` 前缀：控制平面私有接口、客户端读取入口、通知与设备接口、遥测中继；
- `/d/` 前缀：经设备转发的运行时内容；
- `/api/` 前缀：运行时 Remote 调用，含工具结果与记忆查询；
- `/s/` 前缀：分享快照，地址自带访问令牌；
- `/healthz`：运行时探活端点；
- 带 `token`、`code`、`pairing` 等敏感查询参数的地址；
- 带 `Authorization` 头的请求、非读取请求、跨源请求与未列入清单的地址。

响应侧再过滤一次：状态不是 200、非同源常规响应、带 `set-cookie`、`cache-control` 含 `no-store` 或 `private`、
`vary: *` 的响应都不写入缓存。导航请求走网络优先，断网时依次回退到缓存里的应用壳与离线页。

新版本安装后停在等待状态，界面提示保存草稿并由用户确认；确认时发 `SKIP_WAITING`，接管完成后刷新页面。用户在
提示里选择下次启动时不发消息，新版本在浏览器下次启动接管。

## 权限与配对

通知、相机、麦克风与剪贴板逐项查询状态，请求由用户点击触发。拒绝后给出浏览器站点设置的修改路径，缺少接口或
设备时说明具体原因。剪贴板读取需要一次点击动作。

当前构建没有引入条码解码库，扫码能力取自浏览器自带的 `BarcodeDetector`。缺少解码器时界面明确说明扫码不可用，
并提供手动输入配对码的入口；配对码 16 位，去掉容易看错的 `0`、`O`、`1`、`I`，展示时每 4 位一组。配对成功后
设备令牌交给受保护的凭据存储。

## 凭据与草稿

设备令牌只以明文存在于内存。需要跨刷新保留时用 WebCrypto 的 AES-GCM 加密后写入 IndexedDB，密钥是生成时即标记
为不可导出的 `CryptoKey`，同样存放在 IndexedDB；本模块不写本地存储，也不把令牌写进其它键。缺少 WebCrypto 或
IndexedDB 时退回只存内存，界面显示实际存储方式与退回原因。

草稿按客户端、窗口、设备与会话四段隔离。窗口标识放在会话存储，刷新后稳定；同源存在其它窗口时生成新标识，草稿
互不覆盖；浏览器关闭后会话存储清空，此时沿用本地存储记录的上次窗口标识，草稿在重新打开浏览器后恢复。保存前按
白名单收敛字段，令牌、凭据、工具原文、记忆查询内容与未确认附件字节都不写入。

## 移动布局

样式只引用主题令牌，字号用相对单位，长文本与长地址随处换行。窄屏导航收起为抽屉，系统返回先关闭最上层弹层；
顶部与底部使用 `env(safe-area-inset-*)` 留出安全区；输入法弹起时把视觉视口与布局视口的差值写进
`--pwa-keyboard-inset`，输入区整体上移并把焦点元素滚进可见区域；可点击控件不小于 44 像素。

真实 Android 安装、后台 Web Push 与安全区在真机上的取值需要真机验证，本包的自动化验收覆盖桌面 Chrome 的
Service Worker、缓存、离线、更新、权限、窄屏与文字缩放。

## 遥测

浏览器侧上报走同源中继 `POST /chatdsh/telemetry/browser`，只使用 `docs/telemetry.md` 6.5 节登记的名称：

- 事件 `chatdsh.client.ui.action`：安装检查、安装提示、注册、更新提示、更新启用、权限查询与请求、配对、草稿
  保存与恢复、布局弹层与输入法避让、连接探测；
- 事件 `chatdsh.client.error` 与指标 `chatdsh_client_errors_total`：失败原因与失败计数；
- span `chatdsh.client.boot` 与 `chatdsh.client.module.load`：界面挂载与模块装填。

属性只取登记过的键：`action`、`outcome`、`module.count`、`module.id`、`error.type`、`error.code` 与
`error_type`。令牌、配对码、草稿正文与地址查询串不进入遥测。

## 脚本

```bash
node packages/client/pwa/scripts/generate-icons.mjs
```

生成三枚占位图标：192、512 与 maskable 512。
