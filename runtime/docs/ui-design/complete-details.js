'use strict';

const supplementary = {
  S12: () => `<div class="page">${card('配置作用范围',`${row('服务地址与凭据变量','只读配置说明，由部署环境提供。')}${row('可编辑项目','enabled、maxTokens、extraBanks；maxTokens 100–16000，服务器可收紧。')}${row('生效时间','保存后影响新回合，不改变进行中的召回。')}`)}</div>`,
  S14: () => `<div class="page"><div class="grid">${card('单次与固定间隔',`${field('单次日期','2026-11-02','','date')}${field('单次时刻','09:00','','time')}${field('固定间隔（秒）','3600','至少 60 秒，只在固定间隔类型提交。','number')}${field('IANA 时区','Asia/Shanghai')}`)}${card('每周与 cron',`${select('每周星期',['星期一','星期二','星期三','星期四','星期五','星期六','星期日'])}${field('每周时刻','09:00','','time')}${field('cron 表达式','0 9 * * 1-5','五段 Vixie cron；由成熟解析器校验。')}${row('下次发生','由运行时按所选时区计算并返回。')}${banner('画板并列展示各时间类型。实际表单仅显示所选类型字段，提交恰好一种时间方式。')}`)}</div></div>`,
  S18: () => `<div class="page"><div class="grid">${card('绑定 TOTP 双因素',`<div class="figure"><div style="text-align:center"><h3>绑定二维码区域</h3><p class="muted">完成再次认证后显示真实绑定二维码。</p>${badge('设计占位 · 不可扫码')}</div></div>${action('显示绑定密钥','','仅在经过身份验证的专用页面显示真实密钥，提供复制与清除。')}${field('确认动态验证码','','输入当前 6 位验证码后才启用 TOTP。')}`,action('确认绑定','primary'))}${card('恢复码与验证方式',`${banner('恢复码只在生成时显示一次。此画板不包含真实恢复码。','warn')}<pre>恢复码列表显示区域\n每条恢复码具有已使用或未使用状态</pre>${check('已经下载或打印并离线保存恢复码')}${action('下载恢复码')}${action('打印恢复码')}${action('重新生成恢复码','danger','需要再次认证；旧恢复码全部失效，显示新的恢复码并要求确认保存。')}${row('验证方式','当前密码、通行密钥与 TOTP',action('管理验证方式'))}${action('移除最后一种验证方式','danger','禁止删除最后一种可用访问方式；先配置并验证替代方式。')}`)}</div></div>`,
  S22: () => `<div class="page"><div class="grid">${card('Agent 压缩与停止',`${field('单步超时（毫秒）','120000','','number')}${field('重试间隔（毫秒）','1000','','number')}${field('压缩阈值','0.80','范围 0–1，实际宿主限制优先。','number')}${field('压缩保留比例','0.35','范围 0–1。','number')}${select('停止策略',['等待当前可取消动作停止','立即请求中断并等待确认'])}`)}${card('终端与子代理完整参数',`${field('终端程序','pwsh')}${area('终端参数 JSON','["-NoLogo"]','字符串数组，逐个参数传递。')}${select('子代理 provider',['继承父会话','primary'])}${select('子代理推理强度',['模型默认','低','中','高'])}${field('子代理任务超时（毫秒）','600000','','number')}${check('允许读取文件',true)}${check('允许执行命令',true)}${check('允许受限浏览器工具')}${field('检索结果数量','5','','number')}`)}</div></div>`,
};
for (const item of scenes) {
  const extra = supplementary[item.id];
  if (!extra) continue;
  const original = item.render;
  item.render = () => original() + extra();
}

const readOnlyTools = /复制|缩小|放大|适合窗口|原始大小|旋转|全屏|上一页|下一页|查找文本|文档目录|缩略图|打印|清除搜索/;
const originalApplyState = applyState;
applyState = function applyDetailedState() {
  originalApplyState();
  if (['readonly','offline'].includes(stateControl.value)) {
    for (const button of content.querySelectorAll('button')) {
      if (readOnlyTools.test(button.textContent)) { button.disabled = false; button.removeAttribute('title'); }
    }
  }
};

const originalRenderScene = renderScene;
renderScene = function renderDetailedScene(id) {
  originalRenderScene(id);
  for (const list of content.querySelectorAll('.command-panel [role="listbox"]')) {
    list.setAttribute('aria-label','设计命令列表');
  }
};
document.addEventListener('keydown',event => {
  const panel = event.target.closest('.command-panel');
  if (!panel) return;
  const options = [...panel.querySelectorAll('[role="option"]')];
  if (!options.length) return;
  let index = options.indexOf(document.activeElement);
  if (event.key === 'ArrowDown') index = (index + 1) % options.length;
  else if (event.key === 'ArrowUp') index = (index - 1 + options.length) % options.length;
  else if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = options.length - 1;
  else if (event.key === 'Escape') { event.preventDefault(); document.getElementById('scene-search').focus(); return; }
  else return;
  event.preventDefault();
  for (const option of options) option.setAttribute('aria-selected',String(option === options[index]));
  options[index].focus();
});
renderScene();
