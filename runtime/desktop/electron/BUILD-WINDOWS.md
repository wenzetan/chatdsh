# 在 Windows 上构建与运行

这份说明记录 `homedesktop`（Windows 11 x64、Node 24、pnpm 10）上的完整构建与运行步骤，每条都在该机器上实跑过。

## 前置

```bat
cd %USERPROFILE%\chatdsh-src
```

仓库结构与 Linux 相同：`runtime` 与 `dsh-adapter` 同级，另有 `hermes-adapter`、`hindsight-adapter`、`forge-bridge`。宿主平面的包会引用后两个适配器，缺它们 `tsc -b` 会在 `packages/host/memory` 与 `packages/host/chat-hermes` 处报找不到模块。

## 依赖投影

类型检查要能解析 DSH 安装里的包。两个目录各有自己的投影脚本，都要跑：

```bat
cd dsh-adapter
node scripts\link-dsh-deps.mjs

cd ..\runtime
node scripts\link-dsh-deps.mjs
```

脚本在 Windows 上建目录联接（junction），不需要管理员权限；它也能识别 npm 全局安装的 `dsh.cmd` 转发脚本，从 PATH 反查安装根。

## 装依赖

```bat
cd %USERPROFILE%\chatdsh-src\runtime
pnpm install --registry=https://registry.npmmirror.com
```

## 编译

```bat
node node_modules\typescript\bin\tsc -b tsconfig.build.json
node scripts\build-client.mjs
```

第一条把各包的 TypeScript 编译到 `lib/`；第二条用 esbuild 把每个客户端插件打成单文件 `lib/client.js`，输出 14 个包。共享组件包 `@chatdsh/core-ui-kit` 在构建时按源码路径内联进各插件产物，因此运行时不依赖额外的模块解析。

## profile 依赖

```bat
cd %USERPROFILE%\chatdsh-src\runtime\profiles\chatdsh-desktop
pnpm install --registry=https://registry.npmmirror.com
```

## 运行

数据根用 junction 指到仓库里的 profile：

```bat
set CHATDSH_DSH_HOME=%USERPROFILE%\chatdsh-home
set CHATDSH_PORT=3151
cd %USERPROFILE%\chatdsh-src\runtime\desktop\electron
node_modules\electron\dist\electron.exe . --no-sandbox
```

## 打包 exe

在 `runtime` 目录先产出 `win-unpacked`，再生成推荐的单文件安装器：

```bat
node scripts\build-desktop-windows.mjs
node scripts\build-windows-installer.mjs
```

产物：

```text
runtime\.run\desktop-windows\ChatDSH-Setup-0.1.0-x64.exe   # 安装器，推荐
runtime\.run\desktop-windows\ChatDSH-0.1.0-x64.exe         # 便携版
```

安装器解压到 `%LOCALAPPDATA%\Programs\ChatDSH` 并创建桌面/开始菜单快捷方式；之后启动
不再重新解压。便携版每次启动都会重新解压，包体大时首次启动会慢。目标机都不需要
Node、pnpm 或 dsh。首次启动时桌面壳会在数据根里为 profile 建目录联接，并直接运行随包的
`resources/app/dsh/lib/bin.js`。

默认构建未签名（`win.signAndEditExecutable=false`），SmartScreen 可能提示。需要代码签名
或自定义图标时，在 Windows 构建机上打开 `electron-builder.yml` 的该开关并配置证书。

## 验收

```bat
cd %USERPROFILE%\chatdsh-src\runtime
set CHATDSH_DSH_HOME=%USERPROFILE%\chatdsh-home
node scripts\verify-desktop-shell-win.mjs
```

它启动壳、拉起运行时，在渲染进程里读取计算样式，核对画布、面板、品牌与状态令牌、正文字号、上游别名映射、设计字体族，以及自建面板的 `chdsh-*` 组件是否渲染，最后推进首次进入流程到自建预设。
