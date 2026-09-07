'use strict';
/* v2 面板「三项视觉修复」专项测试
   ① 底栏/侧栏图标(去 CDN 字体 + navigation-tab 正确插槽 + emoji 字形)
   ② 对话框渲染(md-dialog 直子元素 + headline/content/actions 插槽 + 显式按钮绑定)
   ③ 按钮与说明文字比例(分量排版令牌 + 组件尺寸令牌)
   另附 CSS 结构完整性检查(旧文件曾出现 :root 提前闭合导致 light 主题整块被吞) */
const fs=require('fs'), path=require('path');
process.on('unhandledRejection', r=>{ const m=String(r&&r.message||r); if(!/Not implemented|not implemented|DOMException/i.test(m)) console.error('  ⚠ 未预期 rejection:', m.slice(0,90)); });
const {JSDOM}=require('/workspace/tmp/npmtest/node_modules/jsdom');
const HTML=process.env.V2_HTML||path.join(__dirname,'../m3/v2/index.html');
const MW='/workspace/tmp/npmtest/mw-v2.js';
let pass=0,fail=0;
function ok(c,m){ if(c) pass++; else { fail++; console.error('  ✗ '+m); } }
function eq(a,b,m){ ok(a===b, m+` (got=${JSON.stringify(a)}, want=${JSON.stringify(b)})`); }

const html=fs.readFileSync(HTML,'utf8');
const mw=fs.readFileSync(MW,'utf8');
let src=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
src=src.replace(/const MW_OK = await import\([^)]*\)[\s\S]*?\n\}\);/, "const MW_OK = true;");

const css=(html.match(/<style>([\s\S]*?)<\/style>/)||[,''])[1];
const css_nc=css.replace(/\/\*[\s\S]*?\*\//g,'');   // 去注释, 避免注释里的旧写法误报
const tick=ms=>new Promise(r=>setTimeout(r,ms));

/* ================= 静态: 零外链 / CSS 结构 ================= */
ok(!/fonts\.(googleapis|gstatic)\.com/.test(html), '① 无 Google Fonts / CDN 字体外链');
ok(!/<link[^>]+href=["']https?:/.test(html), '① 无任何外链 <link>');
ok(/--md-icon-font\s*:/.test(css), '① 已覆盖 --md-icon-font(否则 md-icon 按 Material Symbols 渲染)');
const MS_ICONS=new Set(['home','business','sync','key','power','bar_chart','monitoring','description','chat','refresh','add','person','smart_toy','inventory_2','public','arrow_downward','circle','bolt','diamond','lock']);
ok(css.includes("@font-face{")&&/font-family:'Material Symbols Outlined'/.test(css),'① @font-face 已声明 Material Symbols Outlined');
ok(/src:url\('\/admin\/m3\/vendor\/material-symbols-outlined\.woff2'\)/.test(css),'① 字体走本地 /admin/m3/vendor/ 路径(零 CDN)');
ok(css.includes("--md-icon-font:'Material Symbols Outlined'"),'① --md-icon-font 指向图标字体');

let depth=0, balanced=true;
for(const ch of css){ if(ch==='{')depth++; else if(ch==='}'){depth--; if(depth<0)balanced=false;} }
ok(balanced && depth===0, '④ CSS 花括号平衡 (depth='+depth+')');
// 顶层裸声明: depth==0 处出现 "--x:y;" 即为游离声明(旧文件 :root 曾提前闭合)
let topDecl=0; depth=0;
for(let i=0;i<css.length;){
  const ch=css[i];
  if(ch==='{'){depth++;i++;continue;}
  if(ch==='}'){depth--;i++;continue;}
  if(depth===0 && css.startsWith('--',i)){
    const semi=css.indexOf(';',i), brace=css.indexOf('{',i);
    if(semi>0 && (brace<0||semi<brace)){ topDecl++; i=semi+1; continue; }
    if(brace>0){ i=brace; continue; }
  }
  i++;
}
eq(topDecl,0,'④ CSS 顶层无游离声明(:root 未提前闭合)');
ok(!/md-dialog\[open\]\s*\{[^}]*display/.test(css.replace(/\/\*[\s\S]*?\*\//g,'')), '② 未覆盖 md-dialog 宿主 display(会破坏其自定位)');

/* ================= 静态: 排版令牌(组件读分量令牌) ================= */
const ROLES=['body-large','body-medium','body-small','headline-small','label-large','label-medium','label-small'];
const PARTS=['font','size','weight','line-height'];
const missing=[];
for(const r of ROLES) for(const p of PARTS) if(!css.includes(`--md-sys-typescale-${r}-${p}:`)) missing.push(`${r}-${p}`);
eq(missing.join(','),'','③ 7 个排版角色的分量令牌齐备'+(missing.length?' 缺:'+missing.join(','):''));
for(const t of ['plain','brand','weight-regular','weight-medium','weight-bold'])
  ok(css.includes(`--md-ref-typeface-${t}:`), `③ --md-ref-typeface-${t} 已定义`);
for(const t of ['--md-filled-button-container-height','--md-text-button-container-height','--md-outlined-button-container-height','--md-filled-tonal-button-container-height'])
  ok(css.includes(t+':36px'), `③ 按钮高度收口到 36px (${t})`);
ok(/--md-navigation-bar-icon-size:/.test(css) && /--md-navigation-bar-label-text-size:/.test(css), '③ 底栏图标/标签尺寸令牌已设');
// 令牌名必须在组件库里真实存在, 否则写了无效(--md-sys-* 是页面自用令牌, 不参与校验)
const mwKnown=mw;
const compTok=/--md-(?:list|list-item|filled-button|text-button|outlined-button|filled-tonal-button|elevated-button|outlined-icon-button|filled-icon-button|navigation-bar|navigation-tab|navigation-drawer|assist-chip|filter-chip|checkbox|switch|radio|dialog|icon|select|select-option|outlined-select|outlined-text-field|outlined-field|linear-progress|circular-progress|divider|ripple|focus-ring|elevation|badge|fab)-[a-z0-9-]+/g;
const bogus=[...new Set([...css_nc.matchAll(compTok)].map(m=>m[0]))].filter(t=>!mwKnown.includes(t));
eq(bogus.join(','),'','③ 所有组件自定义令牌在组件库中真实存在'+(bogus.length?' 无效:'+bogus.join(','):''));
// 背景令牌正确名是 --md-list-container-color(不带 -item-), 写错会让列表项带上 surface 底色
ok(!/--md-list-item-container-color/.test(css_nc),'② 列表背景令牌名正确(--md-list-container-color)');
ok(/--md-list-container-color:transparent/.test(css_nc),'② 列表项背景已透明化(不遮挡卡片底色)');

/* ================= 运行时 ================= */
const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,url:'http://127.0.0.1:16384/admin/m3/v2'});
const w=dom.window, d=w.document;
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
if(!w.PointerEvent) w.PointerEvent = class PointerEvent extends w.MouseEvent { constructor(t,o={}){ super(t,o); this.pointerId=o?.pointerId??1; this.pointerType=o?.pointerType??'mouse'; this.isPrimary=o?.isPrimary??true; this.buttons=o?.buttons??0; } };
if(w.HTMLDialogElement){ const DP=w.HTMLDialogElement.prototype;
  DP.showModal=function(){this.open=true}; DP.show=function(){this.open=true}; DP.close=function(){this.open=false}; }
w.confirm=()=>true;
const errs=[];
w.addEventListener('error',e=>errs.push('window: '+(e.message||e.error)));
w.addEventListener('unhandledrejection',e=>errs.push('rejection: '+e.reason));
w.console.error=(...a)=>{};

// 硬超时保护: 结构缺失时不应挂死进程, 直接判失败退出
const hard=setTimeout(()=>{ console.error('  ✗ 测试超时(可能存在缺失节点导致脚本中断)'); process.exit(1); },20000);
hard.unref&&hard.unref();
(async()=>{
  try{ w.eval(mw+'\n//# sourceURL=mw-v2.js'); }catch(e){ console.error('bundle 注入失败', e.message); process.exit(1); }
  try{ w.eval('(async()=>{'+src+'\n})()\n//# sourceURL=panel.js'); }catch(e){ errs.push('script: '+e.message); }
  await tick(1500);
  ok(errs.length===0,'页面初始化无异常'+(errs.length?': '+errs.slice(0,3).join(' | '):''));

  /* ---- ① 底栏图标真实投射进 shadow DOM ---- */
  const tabs=[...d.querySelectorAll('#navbar md-navigation-tab')];
  eq(tabs.length,5,'底栏 5 个 tab');
  let slotHit=0, emojiHit=0;
  for(const t of tabs){
    const ic=t.querySelector('[slot=inactive-icon]'), ac=t.querySelector('[slot=active-icon]');
    if(ic&&ac&&ic.textContent.trim()&&ac.textContent.trim()) slotHit++;
    const txt=(ic?.textContent||'').trim();
    if(MS_ICONS.has(txt)) emojiHit++;   // 合法 Material Symbols 词形
  }
  eq(slotHit,5,'① 每个 tab 同时提供 inactive-icon 与 active-icon 插槽');
  eq(emojiHit,5,'① 图标为 Material Symbols 标准词形');
  // 真实投射检查: 组件 shadowRoot 内的 <slot name=...> 必须分到节点
  const shadowReady=tabs[0]?.shadowRoot && 'assignedNodes' in (tabs[0].shadowRoot.querySelector('slot')||{});
  if(shadowReady){
    let assigned=0;
    for(const t of tabs){
      const sl=t.shadowRoot.querySelector('slot[name=inactive-icon]');
      if(sl && sl.assignedNodes().length>0) assigned++;
    }
    eq(assigned,5,'① 图标节点确实被 slot 接收(非静默丢弃)');
  } else ok(true,'(jsdom 不支持 assignedNodes, 跳过投射检查)');
  const strayIcon=tabs.filter(t=>t.querySelector('md-icon:not([slot=inactive-icon]):not([slot=active-icon])'));
  eq(strayIcon.length,0,'① tab 内无写错插槽名的残留节点');
  // 侧栏图标
  const rail=[...d.querySelectorAll('#railList md-list-item')];
  eq(rail.length,9,'侧栏 9 项');
  ok(MS_ICONS.has((rail[0].querySelector('[slot=start]')?.textContent||'').trim()),'① 侧栏图标同为 Material Symbols 词形');

  /* ---- ② 对话框: 插槽必须是直子元素且名字正确 ---- */
  const dlg=d.getElementById('dlgOverlay');
  const kids=[...dlg.children].map(c=>c.getAttribute('slot'));
  ok(d.getElementById('dlgTitle') && d.getElementById('dlgBody') && d.getElementById('dlgOk') && d.getElementById('dlgCancel'),'② 纯 HTML 对话框结构完整(head/body/ok/cancel)');
  d.getElementById('pv-add').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  await tick(400);
  ok(!dlg.hidden,'② 点击「添加渠道」对话框打开');
  eq(d.getElementById('dlgTitle').textContent,'添加渠道','② 标题写入 headline 节点');
  ok(d.getElementById('dlgBody').querySelectorAll('md-outlined-text-field').length>=4,'② 内容区渲染输入框');
  ok(!dlg.hidden,'② 点击「添加渠道」对话框打开(hidden=false)');
  ok(d.getElementById('dlgCancel') && d.getElementById('dlgOk'),'② 取消/确定按钮有稳定 id');
  if(!d.getElementById('dlgCancel')){ console.log(`\n(旧版结构缺失, 后续交互检查跳过)  ${pass} 通过 / ${fail} 失败`); process.exit(1); }

  /* 校验失败保持打开 */
  d.getElementById('dlgOk').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  await tick(400);
  ok(!dlg.hidden,'② 名称/URL 为空时点确定 → 对话框保持打开');
  /* 填合法数据后保存关闭 */
  const set=(f,v)=>{const el=d.querySelector(`#dlgBody [data-f="${f}"]`); if(el) el.value=v;};
  set('name','测试渠道'); set('baseUrl','https://api.example.com/v1');
  d.getElementById('dlgOk').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  await tick(500);
  ok(!!dlg.hidden,'② 合法数据点确定 → 对话框关闭');
  /* 取消 */
  d.getElementById('pv-add').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  await tick(300);
  ok(!dlg.hidden,'② 再次打开');
  const cancelBtn=d.getElementById('dlgCancel');
  if(cancelBtn) cancelBtn.dispatchEvent(new w.MouseEvent('click',{bubbles:true})); else ok(false,'② 取消按钮存在(旧版缺 #dlgCancel)');
  await tick(400);
  ok(!!dlg.hidden,'② 点取消 → 关闭且不保存');

  /* ---- 收尾 ---- */
  console.log(`\nv2 视觉修复专项测试: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail?1:0);
})();
