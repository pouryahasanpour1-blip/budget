/* همگام‌سازی آنلاین «بودجه» با Supabase
   فقط یک خط <script src="sync.js"></script> قبل از </body> در index.html لازم است. */
(()=>{
'use strict';
const SKEY='bd-home-v1',K_CFG='bd-sync-cfg',K_AUTH='bd-sync-auth',K_PASS='bd-sync-pass',K_OLD='bd-sync-pass-old',K_LAST='bd-sync-last';
/* اختیاری: می‌تونی آدرس و کلید رو همین‌جا بذاری تا موقع ورود نپرسه */
const DEFAULT_URL='',DEFAULT_KEY='';
const COLS=[['tx','tx'],['acc','accs'],['cat','cats'],['sg','sg'],['rec','rec'],['dbt','dbt']];
const MAPS=['bud','goal','mb','mg','u','balert','dbtTx'];

const g=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[<>&"]/g,m=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m]));
const rawSet=Storage.prototype.setItem;
const ls=(k,v)=>{try{if(v===undefined)return localStorage.getItem(k);if(v===null)localStorage.removeItem(k);else rawSet.call(localStorage,k,v)}catch(e){}};
const cfg=()=>{let c={};try{c=JSON.parse(ls(K_CFG)||'{}')}catch(e){}return{url:String(c.url||DEFAULT_URL).trim().replace(/\/+$/,''),key:String(c.key||DEFAULT_KEY).trim()}};
const cfgOk=()=>{const c=cfg();return /^https:\/\//.test(c.url)&&c.key.length>20};
let auth=null;try{auth=JSON.parse(ls(K_AUTH)||'null')}catch(e){}
let st={s:auth?'idle':'off',m:'',t:+(ls(K_LAST)||0)};
let rev=null,pulled=false,busy=false,again=false,applying=false,lastHash=null,timer=null;

/* ---------- ردیابی حذف‌ها (tombstone) ---------- */
const known={};
const bState=()=>JSON.stringify([S.bud||{},S.mb]),gState=()=>JSON.stringify([S.goal||{},S.mg]);
function snap(){COLS.forEach(([k,a])=>known[k]=new Set((S[a]||[]).map(x=>x.id)));known.bud=bState();known.goal=gState();if(S.budTs===undefined)S.budTs=0;if(S.goalTs===undefined)S.goalTs=0}
function trackDel(){
  S.dl=S.dl||{};const n=Date.now();
  COLS.forEach(([k,a])=>{const cur=new Set((S[a]||[]).map(x=>x.id));known[k].forEach(id=>{if(!cur.has(id))S.dl[k+':'+id]=n});known[k]=cur});
  if(known.bud!==bState()){const m=S.dl['bud:*'];if(m&&!Object.keys(S.bud||{}).length&&S.mb===undefined)S.budTs=Math.max(S.budTs||0,m);else{S.budTs=n;delete S.dl['bud:*']}known.bud=bState()}
  if(known.goal!==gState()){const m=S.dl['goal:*'];if(m&&!Object.keys(S.goal||{}).length&&S.mg===undefined)S.goalTs=Math.max(S.goalTs||0,m);else{S.goalTs=n;delete S.dl['goal:*']}known.goal=gState()}
  const cut=n-90*864e5;Object.keys(S.dl).forEach(x=>{if(!x.endsWith(':*')&&S.dl[x]<cut)delete S.dl[x]});
}
Storage.prototype.setItem=function(k,v){
  if(this===localStorage&&k===SKEY&&!applying){
    try{trackDel();S.ts=Date.now();v=JSON.stringify(S)}catch(e){}
    rawSet.call(this,k,v);schedule();return;
  }
  return rawSet.call(this,k,v);
};

/* ---------- داده‌ی قابل ارسال ---------- */
const strip=o=>{const y=Object.assign({},o);delete y.img;return y};
function payload(){
  const p={v:1,ts:S.ts||0,dl:S.dl||{}};
  COLS.forEach(([k,a])=>p[a]=(S[a]||[]).map(strip));
  MAPS.forEach(m=>{if(S[m]!==undefined)p[m]=S[m]});
  p.budTs=S.budTs||0;p.goalTs=S.goalTs||0;
  return p;
}
const canon=o=>Array.isArray(o)?'['+o.map(canon).join(',')+']':o&&typeof o==='object'?'{'+Object.keys(o).sort().map(k=>JSON.stringify(k)+':'+canon(o[k])).join(',')+'}':JSON.stringify(o);
function hp(p){const q=Object.assign({},p);delete q.ts;delete q.dl;q.tx=(q.tx||[]).slice().sort((a,b)=>a.id<b.id?-1:1);const s=canon(q);let h=5381;for(let i=0;i<s.length;i++)h=((h<<5)+h+s.charCodeAt(i))|0;return h+':'+s.length}

/* ---------- ادغام ---------- */
function merge(r){
  const rn=(r.ts||0)>(S.ts||0);
  const dl=Object.assign({},S.dl||{});
  Object.entries(r.dl||{}).forEach(([k,t])=>{dl[k]=Math.max(dl[k]||0,t)});
  COLS.forEach(([k,a])=>{
    const L=S[a]||[],R=r[a]||[],lm=new Map(L.map(x=>[x.id,x])),rm=new Map(R.map(x=>[x.id,x]));
    const pick=id=>{
      const l=lm.get(id),x=rm.get(id);
      if(!x)return l;if(!l)return x;
      if(canon(strip(l))===canon(strip(x)))return l;
      if(rn){const y=strip(x);if(l.img)y.img=l.img;return y}
      return l;
    };
    const ids=rn?[...R.map(x=>x.id),...L.map(x=>x.id).filter(id=>!rm.has(id))]:[...L.map(x=>x.id),...R.map(x=>x.id).filter(id=>!lm.has(id))];
    S[a]=ids.filter(id=>!dl[k+':'+id]).map(pick);
  });
  const group=(name,total)=>{
    const key=name+':*',lm=(S.dl||{})[key]||0,rm=(r.dl||{})[key]||0,mark=Math.max(lm,rm),lt=S[name+'Ts']||0,rt=r[name+'Ts']||0;
    if(mark&&lt<=mark&&rt<=mark){S[name]={};delete S[total];S[name+'Ts']=mark;dl[key]=mark;return}
    if(mark){delete dl[key];const takeRemote=rt>lt,src=takeRemote?r[name]:S[name],val=takeRemote?r[total]:S[total];S[name]=Object.assign({},src||{});if(val===undefined)delete S[total];else S[total]=val;S[name+'Ts']=Math.max(lt,rt);return}
    delete dl[key];const L=S[name]||{},R=r[name]||{},remoteWins=rt>lt;S[name]=Object.assign({},L,R,remoteWins?R:L);
    if(remoteWins&&r[total]!==undefined)S[total]=r[total];else if(S[total]===undefined&&r[total]!==undefined)S[total]=r[total];
    S[name+'Ts']=Math.max(lt,rt);
  };
  group('bud','mb');group('goal','mg');
  if(rn)MAPS.filter(m=>!['bud','goal','mb','mg'].includes(m)).forEach(m=>{
    if(r[m]===undefined)return;
    S[m]=r[m];
  });
  S.dl=dl;S.ts=Math.max(S.ts||0,r.ts||0);
}

/* ---------- رمزنگاری اختیاری ---------- */
const te=new TextEncoder(),td=new TextDecoder();
const b2s=u=>{let s='';for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));return btoa(s)};
const s2b=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function dkey(pass,salt){const m=await crypto.subtle.importKey('raw',te.encode(pass),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:150000,hash:'SHA-256'},m,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
async function seal(p){
  const pass=ls(K_PASS);if(!pass)return{enc:0,p};
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),k=await dkey(pass,salt);
  const c=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},k,te.encode(JSON.stringify(p))));
  return{enc:1,s:b2s(salt),i:b2s(iv),c:b2s(c)};
}
async function open(d){
  if(!d)return null;
  if(!d.enc)return d.p;
  const cands=[ls(K_PASS),ls(K_OLD)].filter(Boolean);
  if(!cands.length)throw new Error('NEEDPASS');
  for(const pw of cands){try{const k=await dkey(pw,s2b(d.s));return JSON.parse(td.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:s2b(d.i)},k,s2b(d.c))))}catch(e){}}
  throw new Error('BADPASS');
}

/* ---------- ارتباط با Supabase ---------- */
function setAuth(j){
  auth={at:j.access_token,rt:j.refresh_token,exp:Math.floor(Date.now()/1000)+(j.expires_in||3600),uid:j.user&&j.user.id,email:j.user&&j.user.email};
  ls(K_AUTH,JSON.stringify(auth));
}
async function refresh(){
  const c=cfg();
  const r=await fetch(c.url+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{apikey:c.key,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:auth.rt})});
  if(r.status===400||r.status===401){auth=null;ls(K_AUTH,null);pulled=false;throw new Error('SESSION')}
  if(!r.ok)throw new Error('HTTP '+r.status);
  setAuth(await r.json());
}
async function api(path,o,retry){
  if(!auth)throw new Error('SESSION');
  if(auth.exp-Date.now()/1000<60)await refresh();
  const c=cfg();o=o||{};
  const r=await fetch(c.url+path,Object.assign({},o,{headers:Object.assign({apikey:c.key,Authorization:'Bearer '+auth.at,'Content-Type':'application/json'},o.headers||{})}));
  if(r.status===401&&!retry){await refresh();return api(path,o,1)}
  return r;
}
async function getRow(){
  const r=await api('/rest/v1/budget_data?select=rev,data&limit=1');
  if(!r.ok)throw new Error(await errText(r));
  const a=await r.json();return a[0]||null;
}
async function putRow(row,data){
  let r;
  if(!row){
    r=await api('/rest/v1/budget_data',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({data})});
    if(r.status===409)return false;
  }else{
    r=await api('/rest/v1/budget_data?user_id=eq.'+auth.uid+'&rev=eq.'+row.rev,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({data,rev:row.rev+1,updated_at:new Date().toISOString()})});
  }
  if(!r.ok)throw new Error(await errText(r));
  const a=await r.json();
  if(!a.length)return false;
  rev=a[0].rev;return true;
}
async function errText(r){try{const j=await r.json();return j.message||j.msg||j.error_description||('HTTP '+r.status)}catch(e){return 'HTTP '+r.status}}

/* ---------- حلقه‌ی همگام‌سازی ---------- */
async function sync(){
  if(!auth||!cfgOk())return;
  if(busy){again=true;return}
  busy=true;setSt('syncing');
  try{
    for(let i=0;i<4;i++){
      const row=await getRow();
      const rp=row?await open(row.data):null;
      const before=hp(payload());
      if(rp){
        applying=true;
        try{merge(rp);rawSet.call(localStorage,SKEY,JSON.stringify(S))}finally{applying=false}
        snap();
        if(hp(payload())!==before&&typeof render==='function')render();
      }
      pulled=true;
      const p=payload(),h=hp(p);
      if(rp&&hp(rp)===h){lastHash=h;break}
      if(await putRow(row,await seal(p))){lastHash=h;break}
    }
    ls(K_OLD,null);st.t=Date.now();ls(K_LAST,String(st.t));setSt('idle');
  }catch(e){
    const m=e&&e.message;
    if(m==='NEEDPASS')setSt('error','رمز رمزنگاری لازمه');
    else if(m==='BADPASS')setSt('error','رمز رمزنگاری اشتباهه');
    else if(m==='SESSION')setSt('off','نشست تموم شد؛ دوباره وارد شو');
    else if(!navigator.onLine||e instanceof TypeError)setSt('error','آفلاین؛ بعداً همگام می‌شه');
    else setSt('error',m||'خطا');
  }finally{busy=false;if(again){again=false;schedule()}}
}
function schedule(){
  if(!auth||!cfgOk())return;
  clearTimeout(timer);
  timer=setTimeout(()=>{if(pulled&&lastHash&&hp(payload())===lastHash)return;sync()},2500);
}
function setSt(s,m){
  st.s=s;st.m=m||'';
  if(g('sybody')&&g('syg').classList.contains('open'))ui();
  if(typeof view!=='undefined'&&view==='set'&&typeof render==='function'&&!applying)render();
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync()});
window.addEventListener('online',sync);
setInterval(()=>{if(!document.hidden)sync()},120000);

/* ---------- رابط کاربری ---------- */
const box=document.createElement('div');
box.className='bg';box.id='syg';
box.innerHTML='<div class="sheet" style="max-height:92vh"><h2>☁️ همگام‌سازی آنلاین</h2><div id="sybody"></div><div class="msg" id="symsg"></div><button class="btn s" id="syx" style="margin-top:12px">بستن</button></div>';
document.body.appendChild(box);
const sm=t=>{const m=g('symsg');if(m)m.textContent=t||''};
const fmtT=t=>{if(!t)return'';const d=new Date(t);return d.toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'})};
function ui(){
  const c=cfg(),inp=(id,ph,t,v)=>`<input id="${id}" type="${t||'text'}" placeholder="${ph}" value="${esc(v||'')}" dir="ltr" autocomplete="off" style="margin-bottom:8px">`;
  let h='';
  if(!cfgOk()){
    h='<div class="hint" style="text-align:right;line-height:1.9">آدرس پروژه و کلید را از Supabase › Project Settings › API بردار.</div>'+inp('syurl','Project URL (https://xxxx.supabase.co)','text',c.url)+inp('sykey','anon public key','text',c.key)+'<button class="btn" id="sycs">ذخیره</button>';
  }else if(!auth){
    h='<div class="hint" style="text-align:right;line-height:1.9">با یه ایمیل و رمز وارد شو. روی هر دستگاه همین ایمیل رو بزن تا اطلاعات یکی بشه.</div>'+inp('syem','ایمیل','email')+inp('sypw','رمز (حداقل ۶ کاراکتر)','password')+'<div class="two"><button class="btn" id="syin">ورود</button><button class="btn s" id="sysu">ساخت حساب</button></div><button class="mb" id="syfg" style="text-align:center;color:var(--mute)">تغییر آدرس سرور</button>';
  }else{
    const stt=st.s==='syncing'?'در حال همگام‌سازی…':st.s==='error'?'⚠️ '+esc(st.m):'✅ همگام'+(st.t?' · آخرین: '+fmtT(st.t):'');
    h=`<div class="card"><small style="color:var(--mute)">حساب</small><div style="font-weight:700;margin:2px 0 8px" dir="ltr">${esc(auth.email||'')}</div><div style="font-size:13px">${stt}</div></div>`+
    '<button class="btn" id="sysync">همگام‌سازی الان</button>'+
    '<div class="lbl">رمز رمزنگاری (اختیاری)</div><div class="hint" style="text-align:right;line-height:1.8;font-size:12.5px;min-height:0">با رمز، اطلاعات قبل از ارسال رمز می‌شه و حتی صاحب سرور هم نمی‌تونه بخونه. روی همه‌ی دستگاه‌ها باید همین رمز رو بزنی. اگه فراموشش کنی، اطلاعات روی سرور قابل بازیابی نیست.</div>'+
    inp('sypass',ls(K_PASS)?'رمز فعلی ذخیره شده':'رمز','password')+
    '<div class="two"><button class="btn s" id="sypset">ذخیره‌ی رمز</button><button class="btn s" id="sypclr">حذف رمز</button></div>'+
    '<div class="hint" style="text-align:right;line-height:1.8;font-size:12.5px">عکس رسیدها همگام نمی‌شن و فقط روی همون گوشی می‌مونن.</div>'+
    '<button class="mb" id="syout" style="color:var(--neg);text-align:center">خروج از حساب</button>';
  }
  g('sybody').innerHTML=h;
}
const tr=e=>{const m=e&&e.message||'';if(/Invalid login/i.test(m))return 'ایمیل یا رمز اشتباهه';if(/already registered/i.test(m))return 'این ایمیل قبلاً ثبت شده؛ وارد شو';if(e instanceof TypeError)return 'اتصال به سرور ممکن نشد';return m||'خطا'};
async function authCall(kind){
  const em=g('syem').value.trim(),pw=g('sypw').value;
  if(!em||pw.length<6)return sm('ایمیل و رمز (حداقل ۶ کاراکتر) را وارد کن');
  sm('…');
  try{
    const c=cfg(),r=await fetch(c.url+(kind==='in'?'/auth/v1/token?grant_type=password':'/auth/v1/signup'),{method:'POST',headers:{apikey:c.key,'Content-Type':'application/json'},body:JSON.stringify({email:em,password:pw})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.msg||j.error_description||j.message||'خطا');
    if(!j.access_token){sm('ایمیل تأیید فرستاده شد. بعد از تأیید، وارد شو. (یا توی Supabase گزینه‌ی Confirm email رو خاموش کن)');return}
    setAuth(j);pulled=false;lastHash=null;rev=null;ui();sm('');sync();
  }catch(e){sm(tr(e))}
}
box.addEventListener('click',e=>{
  if(e.target===box){box.classList.remove('open');return}
  const b=e.target.closest('button[id]');if(!b)return;
  const id=b.id;
  if(id==='syx')box.classList.remove('open');
  else if(id==='sycs'){const u=g('syurl').value.trim(),k=g('sykey').value.trim();if(!/^https:\/\//.test(u)||k.length<20)return sm('آدرس یا کلید درست نیست');ls(K_CFG,JSON.stringify({url:u,key:k}));sm('');ui()}
  else if(id==='syfg'){ls(K_CFG,null);ui()}
  else if(id==='syin')authCall('in');
  else if(id==='sysu')authCall('up');
  else if(id==='sysync'){sm('');lastHash=null;sync()}
  else if(id==='sypset'){const v=g('sypass').value;if(!v)return sm('رمز را بنویس');const o=ls(K_PASS);if(o&&o!==v)ls(K_OLD,o);ls(K_PASS,v);lastHash=null;sm('ذخیره شد');sync()}
  else if(id==='sypclr'){const o=ls(K_PASS);if(o)ls(K_OLD,o);ls(K_PASS,null);lastHash=null;sm('رمز حذف شد');sync()}
  else if(id==='syout'){auth=null;ls(K_AUTH,null);pulled=false;lastHash=null;rev=null;setSt('off');ui();sm('خارج شدی. اطلاعات این دستگاه سر جاشه.')}
});
document.addEventListener('click',e=>{if(e.target.closest('[data-act="syncui"]')){sm('');ui();box.classList.add('open')}},true);

/* ردیف جدید در تنظیمات */
const v0=window.vSet;
if(typeof v0==='function')window.vSet=function(){
  const h=v0.apply(this,arguments);
  const sub=auth?(st.s==='error'?'⚠️ '+st.m:st.s==='syncing'?'در حال همگام‌سازی…':'روشن · '+(auth.email||'')):'ورود با ایمیل برای همگام‌سازی بین دستگاه‌ها';
  const row='<div class="sgt">همگام‌سازی</div><div class="sg"><button class="srow" data-act="syncui" style="--c:#3b82f6"><div class="si"><svg viewBox="0 0 24 24"><path d="M7 18a4 4 0 01-.5-8A6 6 0 0118 9a4.5 4.5 0 01-.5 9z"/><path d="M12 11v5M10 14l2 2 2-2"/></svg></div><span><b>همگام‌سازی آنلاین</b><small>'+esc(sub)+'</small></span><em>‹</em></button></div>';
  const mk='<div class="sgt">ورود و خروج اطلاعات</div>';
  return h.includes(mk)?h.replace(mk,row+mk):h+row;
};

snap();
if(auth&&cfgOk())sync();
if(typeof view!=='undefined'&&view==='set'&&typeof render==='function')render();
})();
