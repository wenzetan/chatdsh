# ChatDSH 桌面壳

Windows 桌面端的 Electron 壳。它把 `chatdsh-desktop` 运行时拉起来，把内置浏览器指向控制平面分配的地址；界面本身由运行时提供的 Web 前端与自建客户端插件组成，本壳负责进程编排、原生窗口、托盘、保活与强制不休眠。

## 组成

| 文件 | 职责 |
|---|---|
| `main.mjs` | Electron 主进程：单实例、启动五阶段、窗口与托盘、保活与电源策略、真机自检 |
| `launch.mjs` | 运行时编排：取锁、建启动根、拉起 `dsh --profile chatdsh-desktop`、等带令牌地址、脱敏留存输出 |
| `preload.cjs` | 页面最小桥：平台、保活状态、窗口动作；不向页面暴露 Node |
| `splash.html` | 启动页：按身份、运行时、界面三个阶段逐步报进度，失败时就地写明原因 |
| `telemetry.mjs` | 遥测：把启动阶段、运行时编排与电源阻止编成 OTLP 交运行时中继；地址就绪前先排队 |

## 依赖与构建

壳本身没有打包步骤（主进程是原生 ESM），只依赖 Electron：

```
cd runtime/desktop/electron
npm install --registry=https://registry.npmmirror.com
```

Electron 的可执行文件由 `electron` 包的安装脚本下载；内网可用镜像：

```
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

运行时产物（各包的 `lib/`）由仓库根构建，壳不重复打包 UI：

```
cd runtime
node scripts/link-dsh-deps.mjs
./node_modules/.bin/tsc -b tsconfig.build.json
node scripts/build-client.mjs
```

profile 的依赖安装：

```
cd runtime/profiles/chatdsh-desktop
pnpm install
```

## 运行

主进程按环境变量定位数据根与启动器，未给时用 `userData` 下的固定位置：

| 变量 | 含义 |
|---|---|
| `CHATDSH_LAUNCH_ROOT` | 中立启动根（子进程 cwd） |
| `CHATDSH_DSH_HOME` | DSH 数据根，含 `profiles/` |
| `CHATDSH_PROFILE` | 要启动的 profile，默认 `chatdsh-desktop` |
| `CHATDSH_PORT` | 运行时监听端口，缺省由运行时自己选 |
| `CHATDSH_DSH_BIN` | `dsh` 启动器或 `@deepseek-ai/dsh` 的 `lib/bin.js` |

```
cd runtime/desktop/electron
npx electron .
```

壳会依次：取单实例锁 → 建启动根与数据根 → 拉起运行时 → 等它就绪 → 把窗口指向它。关闭窗口在托盘常驻模式下只隐藏，进程与运行时继续存活；从托盘选择「退出」才结束进程并回收运行时。

## 验收

Web 与主题层在 Linux 上可跑：

```
cd runtime
node scripts/verify-theme-ui.mjs        # 主题令牌与两套配色
node scripts/verify-client-ui.mjs       # 首次进入与自建预设
node scripts/verify-desktop-shell.mjs    # 壳的编排与窗口（需要 xvfb 与 electron）
```

Windows 真机验收（在 Windows 主机上运行，见 `runtime/scripts/verify-desktop-shell-win.mjs`）：

```
cd runtime
set CHATDSH_DSH_HOME=%USERPROFILE%\chatdsh-home
node scripts\verify-desktop-shell-win.mjs
```

它启动壳、拉起运行时、在渲染进程里读取计算样式，核对画布、面板、品牌、状态令牌与正文字号取到设计取值，并确认首次进入流程推进到自建预设。
