const fs=require('fs'); const {JSDOM}=require('/workspace/tmp/npmtest/node_modules/jsdom');
const HTML=fs.readFileSync('/workspace/ai-gateway/m3/v2/index.html','utf8');
const MW=fs.readFileSync('/workspace/tmp/npmtest/mw-v2.js','utf8');
// 先替换脚本里的 import 再 eval
const script=HTML.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const fixedScript=script.replace("await import('/admin/m3/vendor/mw-v2.js')","Promise.resolve(); await true");
const dom=new JSDOM('<!doctype html><body></body>',{runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window, d=w.document;
class O{constructor(){}observe(){}unobserve(){}disconnect(){}takeRecords(){return[]}}
w.matchMedia=q=>({matches:false,media:q,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
w.IntersectionObserver=O;w.ResizeObserver=O;w.requestAnimationFrame=cb=>setTimeout(()=>cb(1),0);
const _ai=w.HTMLElement.prototype.attachInternals;
w.HTMLElement.prototype.attachInternals=function(){const i=_ai.call(this);
  i.setFormValue||=()=>{};i.setValidity||=()=>{};
  Object.defineProperty(i,'form',{get(){return null},configurable:true});
  i.willValidate=true;i.validity=i.validity||{valid:true};return i;};
w.HTMLElement.prototype.animate=function(){return{finished:Promise.resolve(),cancel(){},onfinish:null}};
if(w.ElementInternals)Object.defineProperty(w.ElementInternals.prototype,'role',{get(){return this.__r||''},set(v){this.__r=v},configurable:true});
if(w.HTMLDialogElement){const DP=w.HTMLDialogElement.prototype;DP.showModal=DP.show=()=>{};DP.close=()=>{};}
w.PointerEvent=class extends w.MouseEvent{constructor(t,o={}){super(t,o);this.pointerId=o?.pointerId??1;this.pointerType=o?.pointerType??'mouse';this.isPrimary=o?.isPrimary??true;this.buttons=o?.buttons??0;}};
w.confirm=()=>true;
const cons=[]; w.console.error=(...a)=>cons.push(a.join(' '));
w.eval(MW+'//# sourceURL=mw-v2.js');
w.eval('(async()=>'+fixedScript+'//# sourceURL=panel.js)()');
setTimeout(()=>{
  console.log('=== 调试报告 ===');
  console.log('compatBar 可见:', !d.getElementById('compatBar').classList.contains('hidden'));
  console.log('navbar 存在:', !!d.getElementById('navbar'));
  console.log('console errors:', cons.length, cons.slice(0,2).join(' | '));
  console.log('已知 MD 注册:', Object.keys(w.customElements._definitions||{}).filter(k=>k.startsWith('md-')).length);
  // 检查 bottom nav 是否有子元素
  const nav=d.getElementById('navbar');
  if(nav) console.log('navbar inner:', nav.innerHTML.slice(0,200));
  process.exit(0);
},2500);
