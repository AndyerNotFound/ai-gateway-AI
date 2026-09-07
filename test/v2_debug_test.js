const fs=require('fs'); const {JSDOM}=require('/workspace/tmp/npmtest/node_modules/jsdom');
const HTML=fs.readFileSync('./m3/v2/index.html','utf8');
const MW=fs.readFileSync('/workspace/tmp/npmtest/mw-v2.js','utf8');
const dom=new JSDOM(HTML,{runScripts:'outside-only',pretendToBeVisual:true,url:'http://127.0.0.1:16384/admin/m3/v2'});
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
w.eval('(async()=>'+HTML.match(/<script type="module">([\s\S]*?)<\/script>/)[1]+'//# sourceURL=panel.js')();
setTimeout(()=>{
  console.log('=== 调试报告 ===');
  console.log('MD 组件注册数:', Object.keys(w.customElements._definitions||{}).length);
  const registered=Object.keys(w.customElements._definitions||{}).filter(k=>k.startsWith('md-'));
  console.log('MD 标签:', registered.filter(k=>['md-navigation-bar','md-navigation-tab','md-filled-button','md-outlined-select','md-switch','md-dialog','md-list-item'].includes(k)).join(', '));
  console.log('navbar 存在:', !!d.getElementById('navbar'));
  const nav=d.getElementById('navbar');
  console.log('navbar 节点:', nav?nav.outerHTML.slice(0,100):'MISSING');
  console.log('compatBar 可见:', !d.getElementById('compatBar').classList.contains('hidden'));
  console.log('console error 数:', cons.length, cons.slice(0,3).join('; '));
  // 检查所有 md-* 元素的 computed style
  const tags=d.querySelectorAll('[class*=md-]');
  console.log('含 md- 类名的元素:', tags.length);
  process.exit(0);
},2000);
