# 客户端界面的验证记录

界面基础设计的实现分三层：主题插件负责令牌与样式注入，共享组件包负责面板元件，十二个客户端面板负责内容。下面每条检查都在仓库根执行，结论来自实际运行。

## 主题与配色

```bash
node scripts/verify-theme-ui.mjs
```

在真实 Chrome 里打开首屏，断言主题样式节点已挂载、令牌解析为设计取值、上游 `--dsw-alias-bg-base` 已映射到本设计画布、两套配色能随 `data-ds-dark-theme` 来回切换。

## 对比度

```bash
node scripts/check-ui-contrast.mjs
```

按设计稿 2.3 节核对十五组配色配对。两套配色共三十项，全部达到三档下限（标题 7:1、正文与按钮 4.5:1、辅助与状态 3:1），并与设计稿记录的实测值相差不超过 0.6。取值漂移会被拦下。

## 组件样式只引用令牌

```bash
node scripts/check-ui-kit-tokens.mjs
```

核对约束 5。组件样式引用的三十二个自定义属性全部有定义，来源是主题令牌、别名映射，或组件样式自身由令牌算出的派生声明（实测主题与组件共定义一百三十九个）；样式里不出现十六进制与 rgb 族颜色字面值；组件样式确实随主题一起注入文档。

## 动效

```bash
node scripts/check-ui-motion.mjs
```

核对设计稿第六节。三个动效令牌取值为 120 毫秒、200 毫秒与 `cubic-bezier(0.24, 0.72, 0.32, 1)`；组件过渡引用这两个时长与曲线，没有写死时长；减少动效分支把动画与过渡都压到 0.001 毫秒。

## 骨架与真实行等高

```bash
node scripts/measure-panel-rows.mjs
```

核对状态覆盖里「骨架行与真实行等高」。在真实运行时页面注入与组件产出一致的 DOM，量取两行内容的行、单行内容的行、以及骨架行的单行高度和行距：

| 组 | 单行高度 | 行距 |
|---|---|---|
| 两行内容的行 | 62 | 64 |
| 单行内容的行 | 62 | 64 |
| 骨架 | 62 | 64 |

四组齐平，数据到达时面板不产生位移。行高由面板上的 `--chdsh-row-h` 统一给出，取值为 `calc(13 × 1.6 + 12 × 1.6 + 22px)`，即标题行、间隙、副行、内边距与边框之和；两行内容的行、单行内容的行与骨架都按它对齐。

## 单元测试

```bash
node --test e2e/unit/panel-design.test.mjs
node --test e2e/unit/ui-kit.test.mjs
node --test e2e/unit/desktop-launch.test.mjs
```

第一条把十二个面板逐个打包后服务端渲染，断言初始帧出现 `chdsh-panel` 与 `chdsh-skeleton`，且产物 HTML 不含十六进制或 rgba 颜色。第二条逐个渲染共享组件的元件：面板外壳、骨架行数、空状态与下一步动作、列表行的圆点/徽标/副行/动作、徽标五档语气、按钮三档语气与禁用、进度条比例夹取、错误条与状态行取色，并断言颜色只以 `var()` 出现。第三条覆盖桌面壳的启动地址解析：噪声行中取地址、半行输出、多次出现取第一处、地址缺失、不含令牌的地址前缀不被误判。

## 遥测链路

```bash
node scripts/verify-telemetry-flow.mjs
```

在已登录页面里依次打状态、自检、中继三个端点。本机实测：状态端点 200，开关打开，出口 `http://127.0.0.1:5080`；自检 200 并返回探针标识；中继 503 `credential-missing`。也就是说客户端事件能到宿主、宿主能解析并路由，卡在导出凭据未配置。单独观察页面加载即可看到一次中继尝试，说明主题插件在安装时确实发出了上报。中继只转发不解析，客户端载荷里的属性不会被它丢弃。

## 桌面壳

Linux 侧编排与窗口：

```bash
node scripts/verify-desktop-shell.mjs
```

Windows 真机（编译、打包、运行一并执行）：

```bat
cd runtime
node node_modules\typescript\bin\tsc -b tsconfig.build.json
node scripts\build-client.mjs
set CHATDSH_DSH_HOME=%USERPROFILE%\chatdsh-home
node scripts\verify-desktop-shell-win.mjs
```

真机自检读取渲染进程的计算样式，核对画布、面板、品牌与三色状态令牌、正文 13px、上游别名映射、设计字体族，以及自建面板的 `chdsh-*` 组件是否渲染。构建步骤另见 `runtime/desktop/electron/BUILD-WINDOWS.md`。

## 首次进入的限制

没有模型凭据时界面停在预设选择页，主界面三栏与设置页不渲染。设置区段的面板由服务端渲染测试覆盖，侧栏面板由 Windows 真机自检覆盖。

## 结构尺寸的归属

设计稿 4.3 节的左侧栏 268、停靠栏 428、会话头部 54、底部状态条 30 描述参考页的排布。产品界面沿用上游自身的布局骨架，主题只接管令牌与视觉，本次没有覆写上游的宽度与高度，因此这些数值不作为产品界面的断言项。

## 从干净克隆复现

版本库之外不依赖任何未提交的产物。按下面的顺序执行，可得到与本文记录一致的构建与测试结果：

```sh
git clone <仓库> && cd runtime
pnpm install --frozen-lockfile
node scripts/link-dsh-deps.mjs
(cd ../dsh-adapter && pnpm install && node scripts/link-dsh-deps.mjs && pnpm build)
(cd ../hindsight-adapter && pnpm install && pnpm build)
(cd ../hermes-adapter && pnpm install && pnpm build)
pnpm build
node --test e2e/unit/*.test.mjs
```

实测：构建零错误；单元测试二百三十三条、通过二百三十一条、无失败，与工作树一致。界面与桌面壳的验收脚本另外需要本机装有 Chrome、electron 与 xvfb。
