# ChatDSH 桌面壳

Windows 桌面端的 Electron 壳。它拉起控制平面，由控制平面拉起 `chatdsh-desktop` 运行时，再把内置浏览器指向控制平面；界面本身由运行时提供的 Web 前端与自建客户端插件组成，本壳负责进程编排、原生窗口、托盘、保活与强制不休眠。

## 组成

| 文件 | 职责 |
|---|---|
| `main.mjs` | Electron 主进程：单实例、启动五阶段、窗口与托盘、保活与电源策略、真机自检 |
| `gateway-launch.mjs` | 控制平面编排：取启动根、拉起 `gateway/lib/main.js`、等健康检查与运行时启动路径 |
| `launch.mjs` | 端口探测与启动地址解析：控制平面与运行时两侧共用的纯函数 |
| `preload.cjs` | 页面最小桥：平台、保活状态、窗口动作；不向页面暴露 Node |
| `splash.html` | 启动页：按身份、运行时、界面三个阶段逐步报进度，失败时就地写明原因 |
| `telemetry.mjs` | 遥测：把启动阶段、运行时编排与电源阻止编成 OTLP 交控制平面中继；地址就绪前先排队 |

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

运行时与控制平面的产物（各包的 `lib/`）由仓库根构建，壳不重复打包 UI：

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

主进程按环境变量定位数据根与启动入口，未给时用 `userData` 下的固定位置：

| 变量 | 含义 |
|---|---|
| `CHATDSH_LAUNCH_ROOT` | 中立启动根（子进程 cwd） |
| `CHATDSH_DSH_HOME` | DSH 数据根，含 `profiles/` |
| `CHATDSH_PROFILE` | 要启动的 profile，默认 `chatdsh-desktop` |
| `CHATDSH_PORT` | 控制平面端口，缺省 `3170`，占用时顺延 |
| `CHATDSH_GATEWAY_BIN` | 控制平面入口，缺省从随包 profile 或仓库 `gateway/lib/main.js` 取 |
| `CHATDSH_RUNTIME_PORT` | 运行时起始端口，缺省 `3080`，占用时顺延 |
| `CHATDSH_DSH_BIN` | `dsh` 启动器或 `@deepseek-ai/dsh` 的 `lib/bin.js` |

```
cd runtime/desktop/electron
npx electron .
```

壳会依次：取单实例锁 → 建启动根与数据根 → 拉起控制平面 → 控制平面拉起运行时 → 用启动口令换取带令牌路径 → 把窗口指向控制平面。关闭窗口在托盘常驻模式下只隐藏，进程、控制平面与运行时继续存活；从托盘选择「退出」才结束进程并回收控制平面与运行时。

## 启动日志与端口

桌面壳把启动过程写到本次日志文件：

```text
%APPDATA%\chatdsh-desktop-shell\logs\desktop-<时间戳>.log
```

控制平面端口从 `CHATDSH_PORT`（缺省 `3170`）开始顺延；运行时端口由控制平面从
`CHATDSH_RUNTIME_PORT`（缺省 `3080`）开始顺延。两者互不占用，上一个实例崩溃留下的
孤儿进程或别的服务占住端口时，不会再直接报 `EADDRINUSE`。

## 打包 Windows 客户端

推荐产物是单文件安装器：

```bash
cd runtime
node scripts/build-desktop-windows.mjs          # 生成 win-unpacked 与便携版
node scripts/build-windows-installer.mjs        # 生成 ChatDSH-Setup-*.exe
```

也可以一次跑完：

```bash
node scripts/build-desktop-windows.mjs --reuse-stage
node scripts/build-windows-installer.mjs
```

产物：

```
runtime/.run/desktop-windows/ChatDSH-0.1.0-x64.exe               # 便携版，每次启动都会解压
runtime/.run/desktop-windows/ChatDSH-Setup-0.1.0-x64.exe         # 安装器，推荐
```

安装器把应用解压到 `%LOCALAPPDATA%\Programs\ChatDSH`，创建桌面与开始菜单快捷方式，
之后启动不再重复解压。目标机不需要安装 Node、pnpm 或 dsh。跨平台构建默认关闭
`signAndEditExecutable`，因此 exe 未签名，Windows SmartScreen 可能提示；需要签名或
自定义图标时，在 Windows 构建机上打开 `desktop/electron/electron-builder.yml` 的该开关
并配置证书。

安装器源码在 `desktop/installer/main.go`，构建脚本是 `scripts/build-windows-installer.mjs`；
它把 `win-unpacked` 打成 zip 载荷追加到 Go 编译出的安装器 exe 末尾。

Linux 上交叉构建时，需要一份按 Windows 平台安装的 DSH 依赖，避免把 Linux 原生模块带进包：

```bash
mkdir -p /tmp/dsh-win-install && cd /tmp/dsh-win-install
npm install --os=win32 --cpu=x64 --ignore-scripts @deepseek-ai/dsh@0.2.1-rc.2
cd /workspace/chatdsh/runtime
node scripts/build-desktop-windows.mjs --dsh-install /tmp/dsh-win-install --target portable --compression-level 1
node scripts/build-windows-installer.mjs
```

## 验收

Web 与主题层在 Linux 上可跑：

```
cd runtime
node scripts/verify-theme-ui.mjs         # 主题令牌与两套配色
node scripts/verify-client-ui.mjs        # 首次进入与自建预设
node scripts/verify-desktop-shell.mjs    # 控制平面、运行时与窗口（需要 xvfb 与 electron）
node --test e2e/unit/gateway-client-integration.test.mjs
```

Windows 真机验收（在 Windows 主机上运行，见 `runtime/scripts/verify-desktop-shell-win.mjs`）：

```
cd runtime
set CHATDSH_DSH_HOME=%USERPROFILE%\chatdsh-home
node scripts\verify-desktop-shell-win.mjs
```

它启动壳、拉起控制平面与运行时，在渲染进程里读取计算样式，核对画布、面板、品牌、状态令牌与正文字号取到设计取值，并确认首次进入流程推进到自建预设。
