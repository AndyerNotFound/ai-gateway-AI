'use strict';
/* v2 面板真实渲染测试: jsdom + 真实 Material Web bundle 驱动整个页面初始化 */
const fs=require('fs'), path=require('path');
// jsdom 内部会抛若干未实现相关的 rejection, 不应终止测试
process.on('unhandledRejection', r=>{ const m=String(r&&r.message||r); if(!/Not implemented|not implemented|DOMException/i.test(m)) console.error('  ⚠ 未预期 rejection:', m.slice(0,90)); });
const {JSDOM}=require('/workspace/tmp/npmtest/node_modules/jsdom');
const HTML=path.join(__dirname,'../m3/v2/index.html');
const MW='/workspace/tmp/npmtest/mw-v2.js';
let pass=0,fail=0;
function ok(c,m){ if(c) pass++; else { fail++; console.error('  ✗ '+m); } }
function eq(a,b,m){ ok(a===b, m+` (got=${JSON.stringify(b===undefined?a:a)}, want=${JSON.stringify(b)})`); }

const html=fs.readFileSync(HTML,'utf8');
const mw=fs.readFileSync(MW,'utf8');
// 抽出模块脚本, 把 CDN/路径 import 换成已注入的 bundle, 顶层 await 包进 async IIFE
let src=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
src=src.replace(/const MW_OK = await import\([^)]*\)[\s\S]*?\n\}\);/, "const MW_OK = true;");
ok(!/\bimport\s*\(/.test(src), '模块脚本已剥离动态 import(改由宿主注入 bundle)');

const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,url:'http://127.0.0.1:16384/admin/m3/v2'});
const w=dom.window, d=w.document;
// ---- jsdom 缺失但真实浏览器都有的 API ----
class Obs{constructor(){}observe(){}unobserve(){}disconnect(){}takeRecords(){return[]}}
w.matchMedia=q=>({matches:false,media:q,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
w.IntersectionObserver=Obs; w.ResizeObserver=Obs;
w.requestAnimationFrame=cb=>setTimeout(()=>cb(1),0);
const _ai=w.HTMLElement.prototype.attachInternals;
w.HTMLElement.prototype.attachInternals=function(){const i=_ai.call(this);
  i.setFormValue||=()=>{}; i.setValidity||=()=>{}; i.form||=null; i.willValidate=true;
  i.validity=i.validity||{valid:true}; return i;};
w.HTMLElement.prototype.animate=function(){return{finished:Promise.resolve(),cancel(){},onfinish:null}};
if(w.ElementInternals){ Object.defineProperty(w.ElementInternals.prototype,'role',{get(){return this.__r||''},set(v){this.__r=v},configurable:true});
  for(const m of ['setFormValue','setValidity']) if(!(m in w.ElementInternals.prototype)) w.ElementInternals.prototype[m]=function(){};
  Object.defineProperty(w.ElementInternals.prototype,'form',{get(){return this.__f||null},set(v){this.__f=v},configurable:true});
  for(const p of ['ariaLabel','ariaDescription','ariaValueText','ariaRequired','ariaChecked','ariaExpanded','ariaSelected','ariaDisabled','ariaErrorMessage','ariaHasPopup','ariaControls','ariaOrientation','ariaMultiline','ariaAutoComplete','ariaInvalid','ariaBusy','ariaLive','ariaAtomic','ariaValueNow','ariaValueMin','ariaValueMax'])
    if(!(p in w.ElementInternals.prototype)) Object.defineProperty(w.ElementInternals.prototype,p,{get(){return this['__'+p]||''},set(v){this['__'+p]=v},configurable:true}); }
// jsdom 无 PointerEvent(真实浏览器均有), ripple 的 handleEvent 会引用它
if(!w.PointerEvent) w.PointerEvent = class PointerEvent extends w.MouseEvent { constructor(t,o={}){ super(t,o); this.pointerId=o?.pointerId??1; this.pointerType=o?.pointerType??'mouse'; this.isPrimary=o?.isPrimary??true; this.buttons=o?.buttons??0; } };
if(w.HTMLDialogElement){ const DP=w.HTMLDialogElement.prototype;
  DP.showModal=function(){this.open=true}; DP.show=function(){this.open=true}; DP.close=function(){this.open=false}; }
w.confirm=()=>true;
const errs=[];
w.addEventListener('error',e=>errs.push('window: '+(e.message||e.error)));
w.addEventListener('unhandledrejection',e=>errs.push('rejection: '+e.reason));
const _ce=w.console.error; const cons=[];
w.console.error=(...a)=>{ cons.push(a.join(' ')); };

(async()=>{
  try{ w.eval(mw+'\n//# sourceURL=mw-v2.js'); }catch(e){ console.error('bundle 注入失败', e.message); process.exit(1); }
  ok(!!w.customElements.get('md-filled-button'), 'Material Web 组件已注册');
  try{ w.eval('(async()=>{'+src+'\n})()\n//# sourceURL=panel.js'); }catch(e){ errs.push('script: '+e.message); }
  await new Promise(r=>setTimeout(r,1500));

  /* ---- 1. 初始化 ---- */
  ok(errs.length===0, '页面初始化无异常'+(errs.length?': '+errs.slice(0,3).join(' | '):''));
  ok(!d.getElementById('compatBar').classList.contains('show'), '兼容性横幅未触发(能力齐备)');

  /* ---- 2. 导航 ---- */
  const rail=d.querySelectorAll('#railList md-list-item');
  eq(rail.length,9,'桌面侧栏 9 个导航项');
  const firstHeadline=rail[0]?.querySelector('[slot=headline]')?.textContent;
  eq(firstHeadline,'总览','侧栏首项文本正确(md-list-item 走 slot 而非属性)');
  ok(rail[0]?.hasAttribute('active'),'当前页高亮生效');
  const tabs=d.querySelectorAll('#navbar md-navigation-tab');
  eq(tabs.length,5,'移动底部导航 5 个 tab');
  ok(d.querySelector('#navbar md-navigation-tab md-icon'),'tab 内含 md-icon');

  /* ---- 3. 总览页渲染 ---- */
  eq(d.getElementById('ov-instances').textContent,'3','统计卡: 实例数=3(Mock)');
  eq(d.getElementById('ov-running').textContent,'2','统计卡: 运行中=2');
  const ovList=d.querySelectorAll('#ov-inst-list md-list-item');
  eq(ovList.length,3,'总览实例列表 3 项');
  ok(/default/.test(ovList[0]?.querySelector('[slot=headline]')?.textContent||''),'实例名出现在 headline slot');
  ok(/端口 16384/.test(ovList[0]?.querySelector('[slot=supporting-text]')?.textContent||''),'副文本出现在 supporting-text slot');
  const ovRows=d.querySelectorAll('#ov-ch-table tbody tr');
  ok(ovRows.length>0,'渠道概览表已渲染 '+ovRows.length+' 行');
  const urlCell=d.querySelector('#ov-ch-table tbody tr td:nth-child(3)');
  ok(urlCell && !/^https?:\/\//.test(urlCell.textContent),'Base URL 已略写(无协议头)');
  ok(urlCell && urlCell.getAttribute('title')?.startsWith('http'),'完整 URL 保留在 title');

  /* ---- 4. 实例下拉 ---- */
  const topSel=d.getElementById('topInst');
  eq(topSel.querySelectorAll('md-select-option').length,3,'顶栏实例下拉 3 个选项');
  eq(topSel.value,'default','实例下拉 value 正确赋值(先挂选项后赋值的时序有效)');

  /* ---- 5. 切页 ---- */
  const before=d.getElementById('page-overview').hidden;
  d.querySelectorAll('#railList md-list-item')[1].dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,600));
  ok(!d.getElementById('page-providers').hidden,'点击侧栏切换到提供商页');
  ok(d.getElementById('page-overview').hidden,'总览页已隐藏');
  eq(d.getElementById('pageTitle').textContent,'AI 提供商','标题随页面更新');
  const pvRows=d.querySelectorAll('#pv-table tbody tr');
  ok(pvRows.length>=2,'提供商表渲染 '+pvRows.length+' 行');
  const acts=pvRows[0]?.querySelector('.row-acts');
  ok(acts && acts.querySelector('md-outlined-button'),'操作列使用 md-outlined-button');

  /* ---- 6. 对话框 ---- */
  d.getElementById('pv-add').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,400));
  const dlg=d.getElementById('dlgOverlay');
  ok(!dlg.hidden,'md-dialog 打开');
  ok(d.getElementById('dlgBody').querySelectorAll('md-outlined-text-field').length>=4,'对话框含多个输入框');
  const typeSel=d.getElementById('dlgBody').querySelector('[data-f="type"]');
  await new Promise(r=>setTimeout(r,300));
  eq(typeSel?.tagName?.toLowerCase(),'md-outlined-select','对话框内找到类型下拉');
  eq(typeSel?.value,'openai','对话框内 select 默认值正确');

  /* ---- 7. 聊天页 ---- */
  d.querySelectorAll('#railList md-list-item')[8].dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,700));
  const modelSel=d.getElementById('ch-model');
  ok(modelSel.querySelectorAll('md-select-option').length>0,'聊天页模型下拉已填充');
  ok(/deepseek-chat/.test([...modelSel.querySelectorAll('md-select-option')].map(o=>o.value).join(',')),'模型来自渠道配置');
  const inp=d.getElementById('ch-input'); inp.value='测试一下';
  d.getElementById('ch-send').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,700));
  const bubbles=d.querySelectorAll('#ch-messages .chat-bubble');
  ok(bubbles.length>=2,'聊天渲染出 '+(bubbles.length/2|0)+' 轮气泡');
  ok(/测试一下/.test(bubbles[0]?.textContent||''),'用户气泡内容正确');
  ok(d.querySelector('#ch-messages .chat-msg.user .chat-ava'),'用户消息有头像节点');
  ok(d.querySelector('#ch-messages .chat-copy'),'气泡含复制按钮');

  /* ---- 8. 无泄漏/无异常 ---- */
  ok(cons.filter(x=>!/Error: Not implemented|jsdom/i.test(x)).length===0,'console 无真实报错'+(cons.length?' (忽略 '+cons.length+' 条 jsdom 未实现提示)':''));
  console.log(`\nv2 面板渲染测试: ${pass} 通过 / ${fail} 失败`);
  if(cons.length) console.log('  jsdom 未实现提示: '+[...new Set(cons.map(c=>c.slice(0,60)))].slice(0,3).join(' | '));
  process.exit(fail?1:0);
})();
