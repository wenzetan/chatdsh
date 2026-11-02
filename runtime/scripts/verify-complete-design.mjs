import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../packages/tool/browser/lib/cdp.js';

const root = new URL('../', import.meta.url);
const evidence = new URL('.run/complete-design/', root);
await mkdir(evidence, { recursive: true });
const browser = await launchBrowser({
  executable: '/usr/bin/google-chrome',
  port: 19442,
  userDataDir: fileURLToPath(new URL('chrome/', evidence)),
});
let page;
let socket;
const results = [];
try {
  page = await browser.open();
  await page.navigate(new URL('docs/ui-design/complete.html', root).href);
  const targets = await (await fetch('http://127.0.0.1:19442/json/list')).json();
  const target = targets.find(item => item.url.includes('complete.html'));
  assert.ok(target, '设计页面 CDP 目标存在');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const waiting = new Map();
  const errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.id === undefined) return;
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await command('Runtime.enable');
  assert.equal(await page.evaluate('scenes.length'), 32, '场景总数');
  assert.equal(await page.evaluate('document.querySelectorAll(".scene-link").length'), 32, '导航总数');
  for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    for (const scheme of ['dark', 'light', 'contrast']) {
      await page.evaluate(`document.getElementById('scheme').value=${JSON.stringify(scheme)}; applyTheme()`);
      for (const item of await page.evaluate('scenes.map(item => ({id:item.id,title:item.title}))')) {
        const measured = await page.evaluate(`(() => {
          renderScene(${JSON.stringify(item.id)});
          const content = document.getElementById('scene-content');
          const emptyNames = [...content.querySelectorAll('input,select,textarea')].filter(element => !element.closest('label') && !element.getAttribute('aria-label'));
          const badLinks = [...document.querySelectorAll('a[href^="#S"]')].filter(element => !scenes.some(item => '#'+item.id === element.getAttribute('href')));
          const smallControls = [...content.querySelectorAll('button,input,select,.button')].filter(element => { const box=element.getBoundingClientRect(); return box.width>0 && box.height>0 && !['checkbox','radio'].includes(element.type) && (box.height<43.5 || box.width<43.5); }).map(element=>({text:element.textContent.trim().slice(0,30),width:element.getBoundingClientRect().width,height:element.getBoundingClientRect().height}));
          return {title:document.getElementById('scene-title').textContent,children:content.children.length,overflow:document.documentElement.scrollWidth>innerWidth+1,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,emptyNames:emptyNames.length,badLinks:badLinks.length,smallControls,background:getComputedStyle(document.body).backgroundColor};
        })()`);
        assert.equal(measured.title, item.title, `${item.id} 标题`);
        assert.ok(measured.children > 0, `${item.id} 有设计内容`);
        assert.equal(measured.emptyNames, 0, `${item.id} 字段具有名称`);
        assert.equal(measured.badLinks, 0, `${item.id} 场景链接有效`);
        results.push({ id: item.id, width, scheme, ...measured });
      }
    }
  }
  await page.evaluate("location.hash='S04';renderScene();document.getElementById('state').value='offline';applyState()");
  assert.equal(await page.evaluate('[...document.querySelectorAll("#scene-content button")].every(item=>item.disabled)'), true, '离线状态禁止写操作');
  await page.evaluate("document.getElementById('state').value='ready';applyState();document.querySelector('#scene-content [data-design]').click()");
  assert.equal(await page.evaluate('document.getElementById("design-dialog").open'), true, '动作说明弹窗可打开');
  await page.evaluate("document.getElementById('design-dialog').close();document.getElementById('scene-search').value='S32';document.getElementById('scene-search').dispatchEvent(new Event('input'))");
  assert.equal(await page.evaluate('[...document.querySelectorAll(".scene-link")].filter(item=>!item.hidden).length'), 1, '场景检索');
  for (const state of await page.evaluate('[...document.getElementById("state").options].map(item=>item.value)')) {
    await page.evaluate(`document.getElementById('state').value=${JSON.stringify(state)};applyState()`);
    assert.equal(await page.evaluate("document.getElementById('scene-content').dataset.state"), state);
  }
  for (const id of await page.evaluate('scenes.map(item=>item.id)')) {
    const actual = await page.evaluate(`(async()=>{document.querySelector('.scene-link[data-scene="${id}"]').click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return document.getElementById('scene-id').textContent;})()`);
    assert.ok(actual.startsWith(id),`${id} 实际锚点导航`);
  }
  const stateResults = await page.evaluate(`(() => {
    const report = [];
    for (const scene of scenes) for (const option of stateControl.options) {
      stateControl.value = option.value;
      renderScene(scene.id);
      report.push({id:scene.id,state:option.value,content:content.children.length,overflow:document.documentElement.scrollWidth>innerWidth+1});
    }
    stateControl.value='offline';renderScene('S07');
    if (![...content.querySelectorAll('textarea')].some(item=>!item.disabled)) throw new Error('离线草稿不可编辑');
    stateControl.value='readonly';renderScene('S09');
    if (![...content.querySelectorAll('button')].some(item=>item.textContent==='缩小' && !item.disabled)) throw new Error('只读缩放不可用');
    stateControl.value='ready';renderScene('S01');
    return report;
  })()`);
  assert.equal(stateResults.length,384,'32 场景的全部 12 种状态已渲染');
  assert.ok(stateResults.every(item=>item.content>0 && !item.overflow),'所有状态有内容且无页面溢出');
  const contrast = await page.evaluate(`(() => {
    const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;
    const context=canvas.getContext('2d',{willReadFrequently:true});
    const rgb=(color,base)=>{context.clearRect(0,0,1,1);context.fillStyle=base;context.fillRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].slice(0,3);};
    const luminance=channels=>channels.map(value=>{const v=value/255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
    const report=[];
    for(const scheme of ['dark','light','contrast']) {
      schemeControl.value=scheme;applyTheme();const styles=getComputedStyle(document.body);const token=name=>styles.getPropertyValue(name).trim();
      for(const background of ['--chatdsh-bg','--chatdsh-panel','--chatdsh-panel-2']) for(const foreground of ['--chatdsh-ink','--chatdsh-ink-2','--chatdsh-muted','--chatdsh-faint','--chatdsh-ok','--chatdsh-warn','--chatdsh-danger','--chatdsh-line-2']) {
        const base=token(background);const a=luminance(rgb(token(foreground),base)),b=luminance(rgb(base,base));
        report.push({scheme,foreground,background,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),minimum:foreground==='--chatdsh-line-2'?3:foreground==='--chatdsh-ink'?7:4.5});
      }
    }
    return report;
  })()`);
  assert.ok(contrast.every(item=>item.ratio>=item.minimum),JSON.stringify(contrast.filter(item=>item.ratio<item.minimum)));
  const overflow = results.filter(item => item.overflow);
  const small = results.filter(item => item.width <= 390 && item.smallControls.length > 0);
  await writeFile(new URL('report.json', evidence), JSON.stringify({ measurements: results.length, stateChecks:stateResults.length, contrastChecks:contrast.length, contrast, stateResults, errors, overflow, smallControls: small, results }, null, 2));
  console.log(JSON.stringify({ measurements: results.length, runtimeErrors: errors, overflow: overflow.map(item => ({id:item.id,width:item.width,scrollWidth:item.scrollWidth,scheme:item.scheme})), smallControls: small.map(item => ({id:item.id,width:item.width,controls:item.smallControls})) }, null, 2));
  assert.equal(errors.length, 0, '浏览器无执行错误');
  assert.equal(overflow.length, 0, '全部画板无页面横向溢出');
  assert.equal(small.length, 0, '移动画板触控目标至少 44px');
  console.log('通过：576 次尺寸/配色渲染、384 次状态渲染、72 组对比度、32 个真实锚点导航，以及字段、触控和动作弹窗检查。');
} finally {
  socket?.close();
  if (page) await page.close();
  await browser.close();
}
