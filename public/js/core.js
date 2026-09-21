
/* ---------- state, API and pricing glue ---------- */
let db=null,session=null,cart=store.get('dp_cart',[]),W=null,afterLogin=null,PAGE={},token=store.get('dp_token',null);
const saveCart=()=>store.set('dp_cart',cart);
const setToken=t=>{token=t;try{t?localStorage.setItem('dp_token',JSON.stringify(t)):localStorage.removeItem('dp_token')}catch(e){}};

async function api(path,o){o=o||{};const h={};if(token)h.Authorization='Bearer '+token;let body;
 if(o.form)body=o.form;else if(o.body!==undefined){h['Content-Type']='application/json';body=JSON.stringify(o.body)}
 let r;try{r=await fetch('/api'+path,{method:o.method||(body!==undefined?'POST':'GET'),headers:h,body})}catch(e){throw new Error('Cannot reach the server. Check your connection.')}
 const j=await r.json().catch(()=>({}));
 if(r.status===401&&token&&!o.quiet){setToken(null);session=null}
 if(!r.ok)throw Object.assign(new Error(j.error||'Something went wrong'),{status:r.status});return j}
function applyState(s){db=s;session=s.session;
 [['pujas',PUJAS],['kits',KITS],['prasad',PRASAD],['temples',TEMPLES],['festivals',FEST]].forEach(([k,arr])=>{arr.length=0;arr.push(...s.catalog[k])})}
async function sync(){applyState(await api('/state'))}
/* run a mutation, refresh state, re-render. Returns the API result, or null after showing the error. */
async function run(fn,ok){try{const r=await fn();await sync();if(ok)toast(ok);render(true);return r||true}catch(e){toast(e.message);return null}}

const me=()=>session&&session.role==='customer'?db.me:null;
const PU=id=>PUJAS.find(p=>p.id===id);
const PD=id=>db.pandits.find(p=>p.id===id);
const TP=id=>TEMPLES.find(p=>p.id===id);
const US=id=>db.users.find(u=>u.id===id);

/* local preview only: the server recomputes the real price when the booking is created */
function quote(o){const p=PU(o.pujaId),pd=PD(o.panditId),u=me();
 return Pricing.quote(o.mode,{puja:p,pandit:pd||null,plus:!!(u&&u.plus),kits:(o.sam||[]).map(id=>({price:KITS.find(k=>k.id===id).p})),prasad:(o.pra||[]).map(id=>({price:PRASAD.find(k=>k.id===id).p})),coupon:o.couponObj||null,points:u?u.pts:0,usePoints:!!o.useP})}
function busy(pid,date,slot,skip){return db.busy.some(b=>b.p===pid&&b.date===date&&b.slot===slot&&b.id!==skip)}
function free(pd,date,slot,skip){return !!pd&&pd.st==='verified'&&pd.avail&&!(pd.off||[]).includes(date)&&(!slot||!busy(pd.id,date,slot,skip))}
function modesFor(p){return Object.keys(MODES).filter(m=>m!=='temple'||TEMPLES.some(t=>t.pujas.includes(p.id)))}

/* shared UI */
function toast(m){const e=document.createElement('div');e.className='tst';e.textContent=m;$('#toast').appendChild(e);setTimeout(()=>e.remove(),3200)}
function modal(html,wide){const m=$('#modal');m.innerHTML='<div class="mbox'+(wide?' wide':'')+'"><button class="mx" data-act="close" aria-label="Close">&times;</button>'+html+'</div>';m.classList.add('on')}
function closeModal(){const m=$('#modal');m.classList.remove('on');m.innerHTML=''}
const badge=s=>{const m={Completed:'ok',Confirmed:'info',Assigned:'info',Started:'warn',New:'warn',Cancelled:'bad',Open:'warn',Resolved:'ok',Paid:'ok',Pending:'warn',Delivered:'ok',Dispatched:'info',Packed:'info',Processed:'ok',Initiated:'warn',verified:'ok',pending:'warn',rejected:'bad',Sent:'ok',Scheduled:'info'};return'<span class="badge '+(m[s]||'')+'">'+esc(s)+'</span>'};
const av=(p,sz)=>'<div class="av" style="background:'+p.color+(sz?';width:'+sz+'px;height:'+sz+'px':'')+'" aria-hidden="true">'+p.n.replace(/^(Pt\.|Acharya)\s/,'').split(' ').map(x=>x[0]).slice(0,2).join('')+'</div>';
const diya=()=>'<svg class="diya" viewBox="0 0 48 44" aria-hidden="true"><g class="flame"><path d="M24 2c5 7 8 11 5 17-2 4-8 4-10 0-3-6 2-10 5-17z" fill="#ffb62e"/><path d="M24 10c2.5 4 3.5 6 2 9-1 2-4 2-5 0-1.5-3 1.5-5 3-9z" fill="#fff2b0"/></g><path d="M3 24h42c0 10-9 18-21 18S3 34 3 24z" fill="#d2381b"/><path d="M3 24h42" stroke="#f2a900" stroke-width="3"/></svg>';
const logoSvg='<svg viewBox="0 0 48 44" aria-hidden="true"><path d="M24 2c5 7 8 11 5 17-2 4-8 4-10 0-3-6 2-10 5-17z" fill="#f2a900"/><path d="M3 24h42c0 10-9 18-21 18S3 34 3 24z" fill="currentColor"/></svg>';
function mandala(){let s='<svg viewBox="-200 -200 400 400" class="mandala" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.2">';for(let r=30;r<=190;r+=32)s+='<circle r="'+r+'"/>';for(let i=0;i<16;i++)s+='<g transform="rotate('+i*22.5+')"><ellipse cx="0" cy="-120" rx="16" ry="48"/><ellipse cx="0" cy="-168" rx="9" ry="22"/></g>';for(let i=0;i<8;i++)s+='<g transform="rotate('+(i*45+22.5)+')"><path d="M0-30Q14-60 0-90Q-14-60 0-30Z"/></g>';return s+'</g></svg>'}

function pujaCard(p){return'<article class="card pc"><a class="arch" href="#/puja/'+p.id+'" aria-label="'+esc(p.n)+'">'+p.ic+'</a><div class="bd"><span class="cat">'+p.cat+'</span><h3><a href="#/puja/'+p.id+'">'+esc(p.n)+'</a></h3><div class="hi">'+p.h+'</div><p class="sm mut">'+esc(p.ben)+'</p><div class="meta"><span>'+p.dur+' min</span><span>from <b>'+inr(p.price*.7)+'</b></span></div><div class="row mt"><a class="btn s" href="#/book/'+p.id+'">'+t('book')+'</a><a class="btn s sec" href="#/puja/'+p.id+'">Details</a></div></div></article>'}
function panditCard(p){return'<article class="card"><div class="row" style="flex-wrap:nowrap">'+av(p)+'<div><h3><a href="#/pandit/'+p.id+'">'+esc(p.n)+'</a></h3><div class="sm mut">'+esc(p.city)+', '+p.exp+' years</div><div>'+stars(p.rating)+' <span class="sm mut">'+p.rating+' ('+p.rev+')</span></div></div></div><p class="sm mt">'+esc(p.bio)+'</p><div class="row mt"><span class="vt">✔ KYC verified</span><span class="sm mut">'+p.langs.join(', ')+'</span></div><div class="row mt"><a class="btn s sec" href="#/pandit/'+p.id+'">View profile</a></div></article>'}
function kitCard(k){return'<article class="card"><div class="row sp"><span style="font-size:2rem">'+k.ic+'</span><b>'+inr(k.p)+'</b></div><h3 class="mt">'+esc(k.n)+'</h3><ul class="sm mut" style="padding-left:18px;margin:8px 0">'+k.items.slice(0,4).map(i=>'<li>'+esc(i)+'</li>').join('')+'</ul><div class="sm mut">+'+(k.items.length-4>0?k.items.length-4:0)+' more items</div><div class="row mt"><button class="btn s" data-act="cadd" data-id="'+k.id+'">Add to cart</button><button class="btn s ghost" data-act="kit" data-id="'+k.id+'">Contents</button></div></article>'}

function header(){
 const r=route(),u=me(),navs=[['pujas','pujas'],['pandits','pandits'],['temples','temples'],['samagri','samagri'],['prasad','prasad'],['festivals','festivals'],['astrology','astrology'],['corporate','corporate']];
 let usr='<button class="btn s" data-act="login">'+t('login')+'</button>';
 if(u)usr='<a class="btn s sec" href="#/account">'+esc(u.n.split(' ')[0])+(u.plus?' Plus':'')+'</a>';
 if(session&&session.role==='pandit')usr='<a class="btn s sec" href="#/portal">Pandit portal</a>';
 if(session&&session.role==='admin')usr='<a class="btn s sec" href="#/admin">Admin</a>';
 $('#hdr').innerHTML='<div class="util"><div class="wrap"><span>'+(db&&db.config.demo?'Demo mode: sample pandits, temples and reviews. Test OTP is 123456.':'Verified pandits, samagri and prasad, booked online')+'</span><span><a href="#/about">About us</a><a href="#/contact">Contact</a><a href="#/partner">Partner with us</a><button data-act="lang">'+(lang==='en'?'हिन्दी':'English')+'</button><button data-act="theme" aria-label="Toggle light or dark theme">Theme</button></span></div></div><div class="nav"><div class="wrap navin"><a class="logo" href="#/">'+logoSvg+'<span>DevPooja<small>देवपूजा</small></span></a><nav class="links" id="links" aria-label="Main">'+navs.map(n=>'<a href="#/'+n[0]+'" class="'+(r.page===n[0]?'on':'')+'">'+t(n[1])+'</a>').join('')+'</nav><div class="navr"><button class="cartb" data-act="cart" aria-label="Cart">🛒'+(cart.length?'<i>'+cart.reduce((a,c)=>a+c.q,0)+'</i>':'')+'</button>'+usr+'<button class="burger" data-act="burger" aria-label="Menu">☰</button></div></div></div>';
}
function footer(){$('#ftr').innerHTML='<div class="wrap"><div class="grid g4"><div><div class="logo" style="color:#fff">'+logoSvg+'<span>DevPooja</span></div><p class="sm mt">The complete puja experience on one trusted platform: puja, verified pandit, samagri, prasad.</p></div><div><h4>Explore</h4><a href="#/pujas">Puja catalogue</a><a href="#/pandits">Verified pandits</a><a href="#/temples">Temples</a><a href="#/festivals">Festival calendar</a><a href="#/astrology">Astrology</a></div><div><h4>Shop and save</h4><a href="#/samagri">Samagri kits</a><a href="#/prasad">Prasad</a><a href="#/rewards">DevPooja Rewards</a><a href="#/plus">DevPooja Plus</a><a href="#/corporate">Corporate puja</a></div><div><h4>Company</h4><a href="#/about">About</a><a href="#/contact">Contact and support</a><a href="#/partner">Pandit partners</a><a href="#/admin">Admin panel (demo)</a></div></div><p class="sm mt2" style="opacity:.7">'+(db&&db.config.demo?'Demo data is loaded. Prices, pandits, temples and reviews are illustrative.':'')+'</p></div>'}

/* router */
function route(){const h=location.hash.replace(/^#\/?/,'');const[p,qs]=h.split('?');const parts=p.split('/').filter(Boolean);return{page:parts[0]||'',arg:parts[1],arg2:parts[2],q:Object.fromEntries(new URLSearchParams(qs||''))}}
