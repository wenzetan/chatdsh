# 设计交付验证

## 1. 验证对象

验证对象为[完整设计稿](<ui-design/complete.html>)及其[样式](<ui-design/complete.css>)、[场景一至十六](<ui-design/complete.js>)、[场景十七至三十二](<ui-design/complete-more.js>)、[补充画板](<ui-design/complete-details.js>)。[客户端规格](<client-complete-spec.md>)与[实施工作包](<implementation-work-packages.md>)规定后续产品实现验收。

本次不修改业务实现，不将设计示例作为业务测试结果。真实模型、设备、数据库、推送服务和桌面权限的验证由对应工作包执行。

## 2. 环境与复现

使用本机 Node v22.14.0、Google Chrome 151.0.7922.137 无头浏览器和项目已有 CDP 模块。浏览器直接读取本地设计页面，无需启动服务器，不访问外部网站。验证通过 DOM、计算样式和像素颜色计算完成，没有截图或视觉识别。

在仓库根目录运行：

```sh
node --check runtime/docs/ui-design/complete.js
node --check runtime/docs/ui-design/complete-more.js
node --check runtime/docs/ui-design/complete-details.js
node runtime/scripts/verify-complete-design.mjs
python3 runtime/scripts/check-design-docs.py
env -u GIT_CONFIG_COUNT git diff --check
```

[浏览器验证脚本](<../scripts/verify-complete-design.mjs>)把详细结果保存到已忽略的测试目录中，使用独立 Chrome 用户目录，退出时关闭页面和浏览器进程。[文档验证脚本](<../scripts/check-design-docs.py>)使用标准 Markdown 解析库检查设计文档及相对链接。

## 3. 已通过的设计稿断言

| 验证 | 实际结果 |
|---|---|
| 场景 | S01–S32 均注册、可导航且有非空设计内容 |
| 配色与尺寸 | 32 场景 × 3 配色 × 6 真实视口，共 576 次渲染；视口宽度 320、390、768、1024、1440、1920 CSS 像素 |
| 页面溢出 | 全部测量没有页面级横向溢出；宽表格和代码使用独立滚动区域 |
| 浏览器执行 | 受观察的页面执行错误为零 |
| 字段名称 | 全部表单字段具有 label 或 aria-label |
| 触控尺寸 | 移动视口中的可见按钮、链接按钮、输入与选择控件至少 44×44 CSS 像素；复选框与单选框由完整标签承接操作 |
| 场景链接 | 场景链接全部指向已注册编号，32 个真实锚点点击均进入对应场景；搜索后只保留匹配场景 |
| 状态 | 32 场景 × 12 种状态，共 384 次渲染；内容保留且无页面溢出 |
| 离线与只读 | 离线禁止业务提交，文本草稿继续编辑；只读图片预览保留缩放操作 |
| 操作说明 | 点击画板动作能够打开原生 dialog，关闭与确认反馈有效 |
| 对比度 | 三套配色下，8 类前景令牌与 3 类背景共 72 组计算通过；正文至少 4.5:1、重要标题至少 7:1、强边框至少 3:1 |

对比度断言覆盖完整稿的目标令牌。基础样张保留其原有令牌值，后续 WP02 负责把完整稿目标统一写入实际主题包。强制系统配色、真实读屏、IME、安全区和系统权限等验证使用[通用验收条件](<client-complete-spec.md>)，需要相应真实平台。

文档验证结果：五份核心交付文档经标准 Markdown 解析，302 个相对链接目标全部存在；规格覆盖 32 个场景，实施覆盖 41 个客户端工作包与 8 个系统工作包。脚本语法与 `git diff --check` 通过。

## 4. 设计与实现验收边界

- 设计稿的按钮显示交互说明，页签选择保留审阅反馈，相关业务画板并列展示。设计稿不调用设备、模型、文件或认证服务。
- 图片为内嵌设计示意；二维码区域明确显示设计占位，不包含可用认证数据。
- 产品完整实现需要 AC-S01–S32、AC-G01–G12 与 AC-SYS01–SYS08 的真实证据。自动渲染验证不能替代实际发送、审批、迁移、备份恢复或系统通知。
- 当前既有实现程度继续由[验收状态](<acceptance.md>)和[功能清单](<ui-feature-inventory.md>)记录，未因本次设计交付提升状态。
