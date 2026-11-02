'use strict';

scene('S17','设备、配对与撤销','设备与设置','节点设备与访问客户端分别登记。配对码短期有效、一次使用；撤销后立即关闭对应连接并保留历史归属。', () => settings('设备管理','当前客户端：浏览器。执行设备：开发工作站。',`<div class="grid">${card('执行设备',`${row('开发工作站','Windows · 在线 · 当前会话执行设备',badge('在线','ok')+action('编辑名称'))}${row('构建设备','Linux · 最后在线 昨天 21:30',badge('离线','warn')+action('撤销设备','danger','撤销节点令牌并关闭连接；保留会话副本与归属。重新加入需要新的配对。'))}${row('浏览器客户端','当前访问会话 · 有效期剩余 6 天',badge('当前客户端'))}`)}${card('添加执行设备',`<ol><li>在新设备安装兼容的运行组件。</li><li>在当前页面生成配对码。</li><li>在新设备输入配对码，确认名称与平台。</li></ol><div class="empty"><h3 class="mono">•••• ••••</h3><p>配对码仅在生成后显示，5 分钟内有效，使用后失效。</p>${action('生成配对码','primary','生成一次性短期配对码；展示剩余时间与主动撤销入口。')}</div>${field('设备显示名称','开发工作站')}`,action('撤销当前配对码','danger'))}${card('访问客户端',`${row('当前浏览器','最近访问 05:10 · 有效期剩余 6 天',badge('当前会话','ok'))}${row('已安装 PWA','最近访问 昨天 · 已订阅通知',action('退出此客户端','danger'))}${banner('退出其他客户端不撤销执行节点。节点撤销与访问会话退出拥有独立确认。','warn')}`,action('退出其他客户端','danger'))}${card('设备故障与恢复',`${row('节点令牌失效','重新配对后建立新的认证连接。',badge('需要配对','warn'))}${row('所有设备离线','外壳仍能显示保存的会话副本。',link('阅读会话副本','S24'))}${row('客户端无法本机继续','当前浏览器没有可用本机运行时。',badge('选择目标设备'))}`)}</div>`,'S17'));

scene('S18','访问认证与双因素','设备与设置','单用户部署使用访问凭据与访问会话，不建立多账号体系。注册、恢复和凭据更换都需要明确的安全验证。', () => `<div class="auth-layout"><section class="auth-story"><a class="wordmark" href="#S01"><span class="brand-mark">C</span> ChatDSH</a><h2>连接自己的设备与会话</h2><p>工作目录与会话记录保存在执行设备。控制平面负责跨设备访问与只读副本。</p>${row('访问保护','使用密码、通行密钥与可选双因素。')}${row('凭据安全','认证信息通过受保护连接传输。')}</section><section class="auth-form"><h2>验证访问权限</h2>${tabs(['密码','通行密钥','恢复码'])}${field('访问密码','','输入部署时设置的访问密码。','password')}${action('继续验证','primary','密码验证成功后进入双因素挑战；错误显示统一文案与重试等待时间。')}${action('使用通行密钥','','请求当前站点的 WebAuthn 凭据；取消后保留认证页面。')}<div class="card" style="margin-top:24px"><h3>双因素验证</h3>${field('动态验证码','','输入 6 位验证码，允许粘贴。','text')}${action('完成验证','primary')}<p>${action('使用一次性恢复码')}</p>${banner('验证码无效。请核对时间并重新输入；超过尝试限制后显示剩余等待时间。','error')}</div></section></div><div class="page"><div class="grid">${card('首次设置与恢复',`${field('设置访问密码','','至少 12 个字符，允许粘贴与密码管理器。','password')}${field('确认访问密码','','两次输入必须一致。','password')}${check('启用 TOTP 双因素验证',true)}<p>配对 URI 和恢复码仅在完成身份确认后显示。恢复码只显示一次，需要确认已经离线保存。</p>`,action('注册通行密钥')+action('确认配置','primary'))}${card('认证状态',`${row('访问会话过期','草稿保留，完成认证后重新读取设备与会话。',badge('需要验证','warn'))}${row('恢复码已使用','输入其他未使用的恢复码。',badge('验证失败','danger'))}${row('变更凭据','要求再次验证，完成后可退出其他访问会话。',action('更换访问凭据'))}${row('紧急恢复','通过部署主机的本地恢复命令重置访问凭据，不提供匿名重置入口。')}`)}</div></div>`);

scene('S19','外观、本地化与快捷键','设备与设置','外观偏好与设备专属参数分别保存。字体放大与高对比度保持完整功能和焦点可见性。', () => settings('通用设置','白名单内偏好可以跨设备同步，设备路径与电源设置保留在当前设备。',`<div class="grid">${card('外观与语言',`${select('配色',['跟随系统','暗色','亮色','高对比度'])}${select('界面语言',['简体中文','English'])}${select('内容字体大小',['标准 14px','较大 16px','更大 18px'])}${select('内容密度',['标准','紧凑'])}${check('减少动态效果',false,'系统启用减少动态效果时强制遵循。')}${check('显示首次使用提示',true)}`,save())}${card('快捷键',`${field('搜索快捷键','','按名称或按键过滤')}${row('命令面板','全局命令搜索',action('Ctrl+K'))}${row('发送消息','输入法组合期间不触发',action('Enter'))}${row('换行','消息输入区域',action('Shift+Enter'))}${row('搜索会话','当前窗口',action('Ctrl+F'))}${banner('快捷键冲突：Ctrl+K 已被命令面板使用。选择其他按键或恢复原配置。','error')}`,action('恢复默认快捷键'))}${card('启动与显示',`${select('打开应用时',['恢复最近的会话','显示全部会话','显示欢迎页面'])}${check('恢复右侧面板',true)}${check('新消息自动跟随',true,'阅读历史时暂停自动滚动，并显示新增消息入口。')}${select('对话视图',['对话内容','完整轨迹'])}`,save())}${card('可访问性设置',`${row('键盘操作','Tab 按页面顺序移动，弹层关闭后返回原焦点。')}${row('读屏提示','流式内容按段落播报，审批使用明确标题和动作范围。')}${row('高对比度','文本与控件保持可辨识边框；状态同时显示文字。')}${row('缩放','200% 字体缩放与窄屏布局保留操作入口。')}`)}</div>`,'S19'));

scene('S20','模型、提供方与额度','设备与设置','凭据始终通过环境变量引用。模型选择只影响新会话，已有回合的模型与 provider 固定。', () => settings('模型与额度','控制平面记录用量账本与错误原因。读数不可用时显示未知与最近读取时间。',`<div class="grid">${card('默认模型',`${select('提供方',['已配置 OpenAI 兼容提供方','DeepSeek'])}${select('模型',['DeepSeek · 当前默认','其他已注册模型'])}${select('推理强度',['跟随模型默认','低','中','高'])}${field('凭据环境变量','CHATDSH_PROVIDER_API_KEY','只显示配置状态。')}${badge('凭据已经配置','ok')}`,action('测试连接')+save())}${card('提供方注册',`${row('默认提供方','路由：primary · 模型数量由注册表返回',badge('可用','ok'))}${field('服务地址变量','CHATDSH_PROVIDER_URL')}${field('模型变量','CHATDSH_PROVIDER_MODEL')}${banner('增加与删除提供方需要修改受控配置，并按运行时配置生命周期应用；页面展示重启需求。')}`)}${card('用量与额度',`<div class="metric">32,400 <small>/ 100,000 tokens</small></div><div class="bar"><i style="width:32.4%"></i></div>${select('聚合范围',['今日','最近 7 天','当前计费周期'])}${table(['维度','输入','输出'],[['开发工作站','21,000','8,400'],['构建设备','2,000','1,000']])}<small>额度计数以控制平面账本为准。未返回数据的维度显示未知。</small>`)}${card('聊天后端',`${select('聊天承载',['Hermes，发送时不可用则由 DSH 执行','DSH'])}${field('Hermes 地址变量','CHATDSH_HERMES_URL')}${field('Hermes 凭据变量','CHATDSH_HERMES_API_KEY')}${banner('发送时读取可达状态。DSH 执行的回合显示本地执行标记；恢复 Hermes 后每轮携带完整历史。','warn')}${row('额度不足','当前请求被拒绝，草稿保留，不重复扣账。',badge('quota-exceeded','danger'))}${row('提供方不可达','显示失败类型与重试入口，不伪造模型结果。',badge('upstream-unavailable','warn'))}`)}</div>`,'S20'));

scene('S21','插件安装与能力清单','设备与设置','能力按设备现取。安装与启用需要检查版本、依赖、工具权限和重启要求。', () => settings('插件','当前执行设备：开发工作站。切换设备后重新读取实际插件清单。',`<div class="grid">${card('插件清单',`${tabs(['已安装','组合包','发现'])}${field('搜索插件','','按包名、说明与能力过滤')}${row('记忆组件','宿主插件 · 与 Hindsight 交互',badge('已启用','ok')+action('停用'))}${row('客户端制品','客户端插件 · 制品浏览与预览',badge('已启用','ok')+action('查看声明'))}${row('桌面控制','平台能力 · 仅兼容桌面提供方',badge('当前形态不可用'))}`)}${card('安装确认',`${field('包标识','@chatdsh/extension-name')}${field('精确版本','0.1.0')}${row('来源','部署者配置的受信任登记处')}${row('请求能力','工具注册、网络访问、会话事件读取',badge('需要确认','warn'))}${check('已检查能力与来源')}${banner('安装前校验完整性、兼容范围与依赖。失败时保留原配置并显示失败依赖。','warn')}`,action('检查兼容性')+action('确认安装','primary'))}${card('插件详情',`${table(['声明','内容'],[['角色','client + host'],['客户端产物','独立浏览器模块'],['兼容范围','由 package manifest 提供'],['遥测声明','chatdsh.telemetry'],['重启需求','按实际配置变更返回']])}`)}${card('错误与安全模式',`${row('依赖冲突','当前 DSH 版本未被插件验证。',badge('安装被拒绝','danger'))}${row('登记处不可达','保留已安装列表，重新读取失败信息。',action('重新读取'))}${row('启用失败','原插件状态保持不变，显示错误代码。',action('查看诊断'))}${link('桌面安全模式','S29')}`)}</div>`,'S21'));

scene('S22','运行参数与子代理','设备与设置','运行参数按当前设备保存。敏感路径不进入遥测；无效值在提交前按 schema 校验。', () => settings('运行设置','输入项与上游 schema 保持一致；这里展示完整区段与关键字段。',`<div class="grid">${card('Agent 循环',`${field('回合超时（毫秒）','600000','正整数，不超过服务器允许上限。','number')}${field('最大重试次数','2','0–10。仅幂等读取可自动重试。','number')}${select('上下文压缩',['按已配置阈值','手动触发'])}${check('显示回合详细状态',true)}`,save())}${card('子代理',`${field('并发上限','4','1–32，服务器上限优先。','number')}${select('默认模型',['继承父会话配置','已注册子代理模型'])}${select('默认工具范围',['继承宿主允许范围','只读工具范围'])}${banner('创建子代理时需要模型、provider 与推理强度的兼容组合。运行中变更不改变已创建子会话。')}`,save())}${card('命令环境与外部程序',`${field('默认工作目录','/workspace')}${field('命令默认超时（毫秒）','120000','只保存在当前执行设备。','number')}${field('命令最大超时（毫秒）','600000','必须大于或等于默认超时。','number')}${select('外部编辑器',['系统默认','VS Code','自定义程序'])}${field('外部程序路径','','仅桌面设备显示可配置入口。')}`,save())}${card('网络检索与会话日志',`${select('网页检索提供方',['宿主配置的提供方'])}${field('检索密钥变量','CHATDSH_SEARCH_API_KEY')}${field('检索超时（毫秒）','15000','正整数。','number')}${field('会话日志保留天数','90','删除前提供影响范围与备份入口。','number')}${select('会话存储',['JSONL · 当前','Postgres · 需要迁移验收'])}`,save()+link('数据导出','S31'))}</div>`,'S22'));

scene('S23','设置冲突与未保存内容','设备与设置','表单携带 revision，过期写入被拒绝。服务器值与用户输入同时可读，选择后重新确认提交。', () => page('设置保存冲突','另一客户端修改了同一设置区段。当前输入继续保留。',`${banner('保存未完成：服务器 revision 已变化。请重新读取并选择需要保留的值。','warn')}<div class="grid">${card('当前编辑内容',`${select('默认模型',['DeepSeek · 用户当前选择'])}${select('语言',['简体中文'])}${row('读取版本','revision 21')}`,action('保留当前输入'))}${card('服务器当前内容',`${row('默认模型','另一已注册模型')}${row('语言','English')}${row('接收时间','05:16 · 以控制平面时间为准')}${row('服务器版本','revision 22')}${select('默认模型采用值',['保留当前编辑：DeepSeek','采用服务器值：另一已注册模型'])}${select('语言采用值',['保留当前编辑：简体中文','采用服务器值：English'])}`,action('使用服务器值')+action('重新读取'))}</div><div class="form-footer">${action('逐项选择后重新提交','primary','重新读取最新 revision，用户确认差异后提交。不得直接覆盖未知的新值。')}${action('取消保存')}</div>${card('未保存离开确认',`<p>当前有未保存修改。离开前选择继续编辑或放弃当前编辑内容。</p><div class="actions">${action('继续编辑','primary')}${action('放弃修改并离开','danger')}</div>`)}`));

scene('S24','副本、导入与数据生命周期','设备与设置','副本水位用于内部连续性检查，界面只展示可读范围与来源。清理副本不改变设备权威日志。', () => settings('数据管理','副本用于离线阅读、跨设备导入和设备故障恢复。',`<div class="grid">${card('会话与空间',`${row('设备权威日志','开发工作站 · 84 MB',badge('设备本地'))}${row('控制平面副本','当前占用 32 MB · 保留 90 天',badge('只读副本'))}${row('会话附件','8 个附件 · 未保存附件需要源设备在线。',badge('按需读取'))}<div class="bar"><i style="width:26%"></i></div><small>控制平面副本空间占配额 26%。未返回用量时显示未知。</small>`)}${card('副本清理',`${select('清理范围',['超过 90 天的副本','指定会话副本'])}${row('预计释放','12 MB · 需要服务器预计算')}${banner('只删除控制平面副本。执行设备本地会话不受影响；设备离线时可能无法阅读被清理内容。','warn')}${check('已经了解离线阅读与导入的影响')}`,action('计算影响范围')+action('清理副本','danger'))}${card('导入与血缘',`${select('源会话',['检查发布流程 · 构建设备'])}${select('历史范围',['最近完整回合','全部可用文本历史'])}${select('导入方式',['full-prefix · 保留文本前缀','compressed · 压缩为摘要'])}${select('目标 provider / 模型',['primary / DeepSeek'])}${check('压缩模式已经检查摘要与细节损失')}${row('内容读取时间','05:00 · 160 个事件 · 54,000 字符')}${select('目标执行设备',['开发工作站 · 在线'])}${field('目标目录','/workspace/chatdsh')}${row('可用历史','12 个完整回合 · 54,000 字符')}${row('缺失内容','2 个附件需要源设备在线。',badge('需要确认','warn'))}${banner('创建新会话并保存 parentSession。不会在新设备重新执行旧工具调用。')}`,action('预览导入内容')+action('确认创建关联会话','primary'))}${card('删除与恢复',`${row('已删除会话','删除于昨天 · 剩余保留 29 天',action('恢复会话'))}${row('永久删除','列出权威日志、副本、附件与分享的实际影响。',action('查看删除范围','danger'))}${row('备份状态','最近成功时间与校验结果由真实备份系统提供。',link('备份诊断','S25'))}${banner('恢复操作必须验证会话归属与完整回合边界；备份只读检查通过后才允许写入。')}`)}</div>`,'S24'));

scene('S25','诊断、遥测与错误边界','设备与设置','诊断展示状态、时间与登记过的错误代码。遥测关闭入口始终可用，导出前显示内容范围。', () => settings('诊断','采集内容受隐私白名单约束。诊断信息缺失时显示明确的不可用状态。',`<div class="grid">${card('健康状态',`${row('控制平面','可用 · 最近检查 05:18',badge('正常','ok'))}${row('执行设备连接','开发工作站在线 · 构建设备离线',badge('部分离线','warn'))}${row('Hermes','最近发送时不可达',badge('DSH 执行','warn'))}${row('Hindsight','最近召回成功 · 42 ms',badge('正常','ok'))}${row('前端版本','显示实际构建编号与兼容范围')}`,action('重新检查'))}${card('遥测',`${check('允许遥测',true,'任意上游来源关闭即关闭；开关不影响进行中的业务。')}${row('有效状态','开启 · 由配置源计算')}${row('关闭原因','关闭时显示全部生效来源')}${row('导出状态','最近成功时间、队列长度、丢弃计数')}${banner('遥测禁止包含消息、文件、工具参数、凭据、主机名与内部地址。关闭后不构造 SDK、不生成 traceparent。')}`,action('立即关闭遥测','danger','应用所有关闭来源；停止生成、传播与导出遥测，不中断会话。'))}${card('连接与诊断包',`${row('连接历史','05:17 断开 · 05:18 已连接',badge('恢复完成','ok'))}${select('诊断范围',['当前客户端与选中设备','仅当前客户端'])}${check('包含脱敏日志',true)}${check('包含版本与插件清单',true)}${check('包含状态与错误代码',true)}<p class="muted">不包含会话正文、文件、凭据与完整网络地址。导出前展示清单。</p>`,action('预览导出清单')+action('导出诊断包','primary'))}${card('局部错误边界',`<div class="empty"><h3>当前面板读取失败</h3><p>会话与其他面板可以继续使用。错误代码：resource-unavailable。</p>${action('重新读取')}${action('复制错误代码')}</div><small>只有当前受影响区域显示错误。全局认证失效进入重新验证流程。</small>`)}</div>`,'S25'));

scene('S26','PWA 安装与离线','各端与交付','同源外壳、Service Worker 与 Web Push。Android 浏览器和已安装 PWA 共享订阅与访问状态，iOS 不纳入支持范围。', () => page('移动端 PWA','通过受保护的 HTTPS 访问。离线仅保留草稿，不自动重放业务写入。',`<div class="grid">${card('安装应用',`<div class="brand-mark">C</div><h3>将 ChatDSH 添加到主屏</h3><p>使用同一地址与设备会话，获得独立窗口和通知入口。</p>${row('浏览器支持','Android Chrome · 可安装',badge('支持','ok'))}${row('安装状态','当前在浏览器中打开')}`,action('安装 ChatDSH','primary','由浏览器安装事件触发；未提供安装事件时展示浏览器菜单操作说明。'))}${card('权限与订阅',`${row('通知','尚未请求 · 仅用户点击时弹出权限请求。',action('启用通知'))}${row('相机','用于拍照和扫码；不支持扫码时提供配对码输入。',action('允许使用相机'))}${row('麦克风','用于录音转写；拒绝后提供文本输入。',action('开始录音'))}${row('Web Push','订阅失效时重新登记，不重复创建客户端。',action('重新订阅'))}`)}${card('离线草稿',`${banner('控制平面无法连接。当前页面只显示已允许保留的外壳与草稿。','warn')}${area('当前草稿','请检查发布流程。','草稿按设备与会话区分，退出访问会话时清理敏感本地数据。')}${action('尝试发送','','发送失败：当前离线。草稿保留，没有创建待发任务。')}${action('检查连接')}<p class="muted">恢复连接后重新读取会话与审批状态，发送需要用户再次确认。</p>`)}${card('更新与缓存',`${row('新版本可用','当前草稿已保存，更新不终止设备回合。',action('重新加载客户端'))}${row('缓存范围','仅应用外壳与版本资源；认证响应、分享内容和会话正文不进入公共缓存。')}${row('离线审批','保留卡片，禁止提交，恢复后重新确认状态。',badge('不可提交','warn'))}${row('后台送达','系统与推送服务可能延迟，界面持续说明能力边界。')}`)}</div>`));

scene('S27','移动会话与导航','各端与交付','390px 画板与 44px 触控目标。侧栏使用全屏抽屉，右侧内容使用独立全屏页面并提供返回入口。', () => `<div class="page"><div class="grid"><section><h3 style="margin-bottom:16px">会话页面</h3><div class="phone"><div class="phone-status"><span>05:20</span><span>网络 · 电量</span></div><header class="phone-head">${link('返回','S17')}<div><strong>完善客户端设计</strong><br><small>开发工作站 · 工作档</small></div>${link('更多','S30')}</header><div class="phone-body"><div class="actions">${badge('设备在线','ok')}${badge('询问权限')}${badge('上下文 38%')}</div><article class="message user">请补全移动端客户端设计。</article>${assistant('<p>移动端页面提供会话导航、审批接管、文件预览与通知管理。</p><div class="tool-card"><strong class="success">读取完成</strong><p>客户端规范 · 18 ms</p></div>')}<div class="result-card"><span class="file-icon">PDF</span><div>客户端设计.pdf<br><small>1.2 MB</small></div>${link('预览','S09')}</div></div>${composer()}<nav class="mobile-tabs" aria-label="移动导航"><a href="#S27" class="selected">会话</a><a href="#S10">项目</a><a href="#S16">通知</a><a href="#S19">设置</a></nav></div></section><section><h3 style="margin-bottom:16px">审批抽屉</h3><div class="phone"><header class="phone-head"><strong>等待审批</strong>${link('返回会话','S27')}</header><div class="phone-body"><p class="muted">输入区已接管，原草稿保留。</p><div class="approval"><h3>允许执行命令？</h3><small>开发工作站 · 剩余 02:45</small><pre>pnpm run build</pre><p>命令将在当前会话工作目录运行。</p><div class="actions">${action('允许一次','primary')}${action('拒绝','danger')}${action('本会话允许')}${action('查看策略')}</div></div>${banner('另一客户端已处理时，抽屉立即更新为终态。')}${link('全屏文件预览','S09')}<div class="form-footer">${link('设备与目录','S02')}${link('通知中心','S16')}</div></div></div></section></div></div>`);

scene('S28','桌面控制与权限','各端与交付','授权范围、当前应用与中断入口持续可见。权限由主进程与原生提供方验证，界面无法自行授予权限。', () => page('桌面控制','Windows x64 为目标桌面平台。macOS 权限流程按对应桌面构建提供。',`<div class="control-strip"><strong>桌面控制正在运行</strong><span>目标应用：编辑器</span><span>范围：当前窗口</span><small>已运行 00:42 · 授权剩余 04:18</small>${action('立即中断','danger','立即撤销控制授权，向原生提供方发送中断，等待停止确认。')}</div><div class="grid" style="margin-top:20px">${card('开启确认',`${row('目标应用','编辑器 · 以系统识别结果为准')}${select('授权范围',['当前目标窗口','已列出的应用范围'])}${select('授权有效期',['5 分钟','15 分钟','当前回合'])}${check('允许屏幕读取',false,'屏幕内容用于当前控制任务，不进入遥测。')}${check('已了解鼠标与键盘可能被操作')}${banner('执行前再次核验应用身份与授权范围。管理员应用、系统安全界面和被拒工具需要明确报错。','warn')}`,action('授权并开始','primary'))}${card('权限向导',`${row('辅助功能','系统尚未授权。',badge('缺少权限','warn')+action('打开系统设置'))}${row('屏幕录制','已经授权。',badge('可用','ok'))}${row('原生提供方','未检测到兼容提供方。',badge('不可用','danger'))}${row('平台支持','不支持时显示明确原因，控制按钮禁用。')}`,action('重新检查权限'))}${card('操作审计',`${table(['动作','目标','结果'],[['读取窗口','编辑器','完成'],['点击按钮','编辑器','完成'],['输入文本','管理员程序','background_uipi_blocked']])}<small>有副作用的操作不会自动重试。审计包含应用身份、动作类别与结果。</small>`)}${card('控制异常',`${row('目标窗口变化','暂停操作并要求重新确认。',badge('已暂停','warn'))}${row('坐标映射失效','停止注入并重新读取窗口几何信息。',badge('已中断','danger'))}${row('授权已过期','停止全部控制动作。',action('重新授权'))}`)}</div>`));

scene('S29','桌面更新、托盘与恢复','各端与交付','主进程仅承担窗口与原生能力。更新校验、恢复和运行时状态都具有独立页面与失败说明。', () => page('桌面应用','原生菜单：文件、编辑、视图、帮助。窗口位置与缩放按设备恢复。',`<div class="grid">${card('应用更新',`${row('当前版本','以签名安装包与实际构建版本为准')}${select('更新通道',['稳定通道','预发布通道'])}${row('更新状态','已下载 64% · 等待完整性与签名校验')}${select('安装时机',['等待运行中的任务完成','立即重启前确认任务影响'])}<div class="bar"><i style="width:64%"></i></div>${banner('签名或完整性校验失败时停止安装，保留当前安装版本与错误原因。','error')}`,action('检查更新')+action('取消下载')+action('确认后重启安装','primary'))}${card('托盘与电源',`${check('关闭窗口后保留托盘',true)}${check('执行任务时阻止系统休眠',true)}${check('执行桌面控制时保持显示器开启')}${row('托盘菜单','打开窗口、当前任务状态、暂停保活、退出应用')}${row('有效保活状态','SYSTEM 请求生效 · DISPLAY 未启用',badge('按实际状态显示'))}`,save())}${card('启动失败恢复',`${banner('运行时启动失败。错误代码：runtime-startup-failed。','error')}${row('失败阶段','插件装配')}${row('退出信息','退出码、存活时间与脱敏 stderr 摘要')}${row('配置检查点','显示最近有效配置时间与来源')}`,action('重新启动')+action('使用安全模式')+action('导出诊断包'))}${card('安全模式与第二窗口',`<p>安全模式禁用可选扩展，保留访问认证、设备路由、遥测关闭入口与诊断。</p>${check('下一次启动使用安全模式')}${row('启动已恢复','需要用户确认退出安全模式。',action('恢复正常启动'))}${row('窗口管理','第二窗口共用运行时；退出窗口不停止其他窗口任务。',link('窗口设计','S30'))}`)}</div>`));

scene('S30','第二窗口与分屏','各端与交付','每个窗口至多挂载一个当前设备 iframe。窗口之间共用运行时，写入与审批使用业务幂等和实际确认结果。', () => page('窗口与分屏','桌面端支持新窗口；Web 使用浏览器新窗口。内容与文件预览在当前设备内部拆分。',`<div class="actions" style="margin-bottom:20px">${action('在新窗口打开当前会话')}${action('拆分预览面板')}${action('关闭当前拆分')}${action('恢复默认布局')}</div><div class="split-windows"><section class="window"><header class="window-title">窗口 A · 完善客户端设计</header><div class="page">${badge('开发工作站','ok')}<h3>当前对话</h3><p>当前窗口保持独立草稿与滚动位置。</p><div class="tool-card">工具结果与审批决定同步读取实际状态。</div>${composer()}</div></section><section class="window"><header class="window-title">窗口 B · 检查发布流程</header><div class="page">${badge('构建设备','ok')}<h3>独立会话</h3><p>窗口 B 只加载其当前选中的设备内容。</p><pre>文件预览\n\n# 发布说明\n版本与校验步骤</pre>${link('查看文件','S08')}</div></section></div><div class="grid" style="margin-top:20px">${card('尺寸与焦点',`<p>分屏面板最小内容宽度 360px，空间不足时切换为页签。拖动分隔条支持键盘方向键并提供可读标签。</p>${row('焦点标记','当前面板顶部 2px 品牌色标记。')}${row('布局恢复','按窗口标识与设备保存，不修改会话归属。')}`)}${card('并发与关闭',`${row('同时发送','不同请求使用独立幂等键，由运行时串行确认。')}${row('同时审批','仅一个决定成功，其余读取已处理结果。')}${row('关闭窗口','未发送草稿提示保存；后台执行由运行时继续。')}`)}</div>`));

scene('S31','打印与导出','各端与交付','输出使用固定内容范围并保留来源说明。导出前审阅敏感信息，打印隐藏应用导航与操作按钮。', () => page('导出会话','支持 Markdown、结构化事件与打印 PDF。二进制附件按单独清单处理。',`<div class="grid">${card('导出参数',`${select('导出格式',['Markdown','JSONL · 逐行事件（需要私有导出权限）','HTML · 阅读文档','PDF · 可选择中文文本'])}${select('内容范围',['全部可见消息','选定完整回合'])}${check('包含用户与助手消息',true)}${check('包含工具结果',false,'选择后提示可能含路径与敏感内容。')}${check('包含附件清单',true)}${check('存在缺失附件时，已经确认导出正文与缺失清单；未确认时取消导出')}${check('包含执行来源与时间',true)}${select('时间显示',['Asia/Shanghai','UTC'])}${banner('导出文件可能包含私人内容。生成前提供预览，诊断包与公开分享使用各自独立的隐私规则。','warn')}`,action('预览导出')+action('下载导出文件','primary')+action('打开打印对话框','','使用浏览器打印，隐藏导航、按钮与输入区，长代码允许换行且保留分页。'))}${card('打印预览',`<article class="print-page" id="print-preview"><small>ChatDSH · 个人导出</small><h2>完善客户端设计</h2><p class="muted">导出时间：11月1日 05:20 · Asia/Shanghai</p><hr><h3>用户</h3><p>请完成客户端设计与验收标准。</p><h3>ChatDSH</h3><p>每项设计包含页面、字段、状态与验证步骤。</p><h4>附件清单</h4><p>客户端设计.pdf · 1.2 MB · 需要单独下载</p><small>内容范围固定于本次导出。后续消息不会自动加入。</small></article>`)}${card('结果与失败',`${row('导出完成','显示文件格式、大小与内容范围。',action('重新下载'))}${row('部分附件缺失','正文可导出，缺失附件列入清单。',badge('需要源设备','warn'))}${row('生成失败','保留导出参数，给出错误代码与重试入口。',action('重新生成'))}`)}${card('打印版式',`<p>A4 纵向、页边距 16mm；使用 11pt 正文与 1.6 行距。代码等宽并允许换行，消息标题与首段避免分页分离。</p><p>浅色打印配色使用深色正文与可辨识边框，状态保留文字。公开分享只打印已公开内容。</p>`)}</div>`));

scene('S32','CLI 与非交互输出','各端与交付','命令行连接本机运行时，只展示本机会话写入能力。制品、记忆与分享通过命令访问，远程副本保持只读。', () => page('命令行客户端','终端使用 dsh-tui 提供的准入协议和贡献点，能力兼容由版本门禁验证。',`<div class="cli"><div class="actions">${badge('会话','brand')}${badge('审批 1','warn')}${badge('项目')}${badge('设置')}</div><p class="muted">开发工作站 / workspace/chatdsh · 工作档 · 上下文 38%</p><h3>完善客户端设计</h3><p class="command">用户 › 检查客户端的完整验收条件。</p><p>ChatDSH › 已读取设计规格，将检查页面、状态与接口证据。</p><p class="success">完成 · read · 客户端规格 · 18 ms</p><section class="approval"><h4>等待审批 · pnpm run build</h4><p>执行目录：/workspace/chatdsh</p><p>1 允许一次　2 拒绝　3 查看权限范围</p><p class="muted">离线时不能提交决定。只显示上游可用动作。</p></section><p class="command">› 输入消息或 /help</p><footer class="statusbar">本机已连接 · 模型已固定 · 待审批 1 · 运行任务 0</footer></div><div class="grid" style="margin-top:20px">${card('命令与设置',`<pre>/project list\n/artifact list\n/memory status\n/share create\n/settings\n/help</pre><p>80 列保留文本与操作，120 列可显示侧栏。无颜色模式通过符号与完整状态文字表达结果。</p>`)}${card('非交互与 ACP',`<pre>dsh --profile headless "检查设计验收条件"\n\n{"type":"turn.end","status":"completed"}</pre><p>结构化输出通过标准输出，诊断进入标准错误。退出代码区分执行失败、参数错误、连接失败与被取消。</p><p>ACP 沿宿主既有协议连接，流式事件、取消和审批需要真实会话验证。</p>`)}${card('兼容与限制',`${row('版本不兼容','启动前拒绝加载，显示 DSH 与 dsh-tui 已验证范围。',badge('需要处理','danger'))}${row('远程会话','只读副本可以命令查看，执行需要图形客户端选择远程设备。')}${row('中断','第一次 Ctrl+C 请求停止当前回合，后续退出遵循终端宿主规则。')}`)}${card('读屏与日志',`<p>状态变化使用完整文字，终端颜色可以关闭。工具输出截断明确显示实际字节数与完整结果路径。</p><p>日志与遥测遵守同一隐私白名单，退出时不输出凭据与启动令牌。</p>`)}</div>`));

const linksRoot = document.getElementById('scene-links');
let previousGroup = '';
for (const item of scenes) {
  if (item.group !== previousGroup) {
    const heading = document.createElement('div');
    heading.className = 'nav-group';
    heading.textContent = item.group;
    linksRoot.append(heading);
    previousGroup = item.group;
  }
  const anchor = document.createElement('a');
  anchor.className = 'scene-link';
  anchor.href = `#${item.id}`;
  anchor.dataset.scene = item.id;
  const number = document.createElement('span');
  number.textContent = item.id;
  anchor.append(number, document.createTextNode(item.title));
  linksRoot.append(anchor);
}

const schemeControl = document.getElementById('scheme');
const viewportControl = document.getElementById('viewport');
const stateControl = document.getElementById('state');
const content = document.getElementById('scene-content');
const dialog = document.getElementById('design-dialog');
const parameters = new URLSearchParams(location.search);
if (['dark','light','contrast'].includes(parameters.get('scheme'))) schemeControl.value = parameters.get('scheme');
if (['fluid','desktop','tablet','mobile'].includes(parameters.get('viewport'))) viewportControl.value = parameters.get('viewport');
let toastTimer;
function showToast(text) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
}
function applyTheme() {
  document.body.dataset.colorScheme = schemeControl.value;
}
function applyViewport() {
  document.getElementById('viewport-frame').dataset.viewport = viewportControl.value;
}
function applyState() {
  const value = stateControl.value;
  const states = {
    ready: '',
    loading: `<div aria-busy="true"><p style="padding:12px 16px">正在读取当前页面，保留原有容器与导航。</p><div class="skeleton"></div><div class="skeleton" style="width:46%"></div></div>`,
    empty: `<div class="empty"><h3>当前没有可显示的记录</h3><p>创建记录或调整筛选范围。画板下方保留页面结构供设计审阅。</p>${action('创建记录','primary')}</div>`,
    error: banner('读取失败 · resource-unavailable。其他可用区域保持显示。'+action('重新读取'),'error'),
    offline: banner('执行设备离线。写操作暂时不可用；草稿保留，恢复连接后需要手动发送。'+action('检查连接'),'warn'),
    readonly: banner('只读内容。当前范围不支持发送、编辑、审批和终端输入。'),
    pending: banner('当前有操作等待决定。请打开对应会话查看具体范围。'+link('打开审批','S04'),'warn'),
    forbidden: banner('权限不足。需要在执行设备或系统设置中授予所需权限。'+action('查看所需权限'),'error'),
    disabled: banner('此能力当前停用。保留页面说明，启用前检查当前设备的插件与权限。'+link('检查插件','S21'),'warn'),
    danger: banner('危险操作确认：列出选中对象、影响范围与恢复条件。确认之前不提交写入。'+action('查看影响范围','danger'),'error'),
    degraded: banner('后端服务不可达。显示最近一次有效读数与时间；未知读数保持未知。','warn'),
    long: `<div class="banner"><div class="card-head"><strong>任务执行中 · 已完成 4 / 6 项</strong>${action('请求停止','danger')}</div><div class="bar"><i style="width:64%"></i></div><small>停止请求只有在执行设备确认后才进入已停止状态。</small></div>`,
  };
  document.getElementById('state-region').innerHTML = states[value];
  content.dataset.state = value;
  const readOnly = ['offline','readonly','forbidden','disabled'].includes(value);
  for (const element of content.querySelectorAll('input,textarea,select')) {
    const localDraft = value === 'offline' && element.tagName === 'TEXTAREA';
    const localSearch = ['search','number'].includes(element.type) && value === 'readonly';
    element.disabled = readOnly && !localDraft && !localSearch;
  }
  for (const button of content.querySelectorAll('button')) {
    button.disabled = readOnly;
    if (readOnly) button.title = '当前状态不允许写入；导航链接仍可用于审阅设计。';
  }
}
function renderScene(requestedId) {
  const id = typeof requestedId === 'string' ? requestedId : (location.hash.slice(1) || 'S01');
  const item = scenes.find(entry => entry.id === id);
  if (!item) { location.hash = 'S01'; return; }
  document.title = `ChatDSH · ${item.id} ${item.title}`;
  document.getElementById('scene-id').textContent = `${item.id} / ${item.group}`;
  document.getElementById('scene-title').textContent = item.title;
  document.getElementById('scene-note').textContent = item.note;
  content.innerHTML = item.render();
  for (const anchor of linksRoot.querySelectorAll('a')) {
    if (anchor.dataset.scene === id) anchor.setAttribute('aria-current','page');
    else anchor.removeAttribute('aria-current');
  }
  applyState();
}
schemeControl.addEventListener('change',applyTheme);
viewportControl.addEventListener('change',applyViewport);
stateControl.addEventListener('change',applyState);
window.addEventListener('hashchange',renderScene);
document.getElementById('scene-search').addEventListener('input',event => {
  const value = event.target.value.trim().toLowerCase();
  for (const anchor of linksRoot.querySelectorAll('a')) anchor.hidden = !anchor.textContent.toLowerCase().includes(value);
});
document.addEventListener('click',event => {
  const button = event.target.closest('[data-design]');
  if (button) {
    document.getElementById('dialog-title').textContent = button.textContent.trim();
    document.getElementById('dialog-content').textContent = `设计交互说明：${button.dataset.design} 此画板没有调用业务服务。`;
    dialog.showModal();
  }
  const tab = event.target.closest('[data-tab]');
  if (tab) {
    for (const sibling of tab.parentElement.querySelectorAll('[data-tab]')) sibling.setAttribute('aria-pressed',String(sibling === tab));
    showToast(`已选择${tab.dataset.tab}。该场景的相关状态与内容在当前画板并列展示。`);
  }
});
dialog.addEventListener('close',() => {
  if (dialog.returnValue === 'confirm') showToast('设计动作已经确认。当前页面未修改业务数据。');
});
document.addEventListener('keydown',event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    location.hash = 'S06';
  }
  const tab = event.target.closest('[role="tab"]');
  if (tab && ['ArrowLeft','ArrowRight'].includes(event.key)) {
    event.preventDefault();
    const items = [...tab.parentElement.querySelectorAll('[role="tab"]')];
    const index = (items.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length;
    items[index].focus();
    items[index].click();
  }
});
applyTheme();
applyViewport();
renderScene();
