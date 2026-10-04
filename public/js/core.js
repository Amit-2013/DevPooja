
/* ---------- state, API and pricing glue ---------- */
let db=null,session=null,cart=store.get('dp_cart',[]),W=null,afterLogin=null,PAGE={},token=store.get('dp_token',null);
/* API base for split hosting (static site + hosted backend). Empty = same origin.
   window.DP_API_BASE is written by tools/build-netlify.js into config.js; a
   localStorage dp_api_base value overrides it for quick tests without a rebuild. */
const API_BASE=(function(){let b=window.DP_API_BASE||'';try{b=localStorage.getItem('dp_api_base')||b}catch(e){}return String(b).replace(/\/+$/,'')})();
const mediaUrl=u=>/^(https?:)?\/\//i.test(u)?u:API_BASE+u;
const saveCart=()=>store.set('dp_cart',cart);
const setToken=t=>{token=t;try{t?localStorage.setItem('dp_token',JSON.stringify(t)):localStorage.removeItem('dp_token')}catch(e){}};

async function api(path,o){o=o||{};
 /* The GitHub Pages build installs a static read-only backend here (js/pages-demo.js). */
 if(window.PagesDemo)return window.PagesDemo.request(path,o);
 const h={};if(token)h.Authorization='Bearer '+token;let body;
 if(o.form)body=o.form;else if(o.body!==undefined){h['Content-Type']='application/json';body=JSON.stringify(o.body)}
 let r;try{r=await fetch(API_BASE+'/api'+path,{method:o.method||(body!==undefined?'POST':'GET'),headers:h,body})}catch(e){throw new Error('Cannot reach the server'+(API_BASE?' at '+API_BASE:' - is the backend running?')+' Check your connection.')}
 const j=await r.json().catch(()=>({}));
 if(r.status===401&&token&&!o.quiet){setToken(null);session=null}
 if(!r.ok)throw Object.assign(new Error(j.error||'Something went wrong'),{status:r.status});return j}
function applyState(s){db=s;session=s.session;
 /* Phase C: the footer's social icons are rows in the state — refresh just that
    row whenever state updates (the footer otherwise builds once at boot), so an
    admin's hide/add is visible without a reload. */
 const fsoc=document.querySelector('#ftr .ftr-socials');if(fsoc)fsoc.innerHTML=socialLinksHtml();
 /* Kundali commercial layer: pricing (public) + family + my kundalis (logged in).
    These fetches resolve AFTER sync() returns; re-rendering unconditionally here
    used to clobber whatever the caller rendered next (e.g. the booking
    confirmation replaced by a fresh wizard). Only re-render when the current
    page actually consumes this data. */
 const consumes=()=>location.hash.startsWith('#/kundali')||location.hash.startsWith('#/account');
 api('/kundali/pricing').then(p=>{db.kundaliPricing=Object.assign({prices:p.prices,gstPct:p.gstPct,quota:p.quota},{});if(s.me&&db.kundaliPricing&&db.kundaliPricing.quota===null)db.kundaliPricing.quota=p.quota;if(consumes())render(true)}).catch(()=>{});
 if(s.me){api('/kundali/mine').then(m=>{db.myKundalis=m.kundalis;if(db.kundaliPricing)db.kundaliPricing.quota=m.quota;if(consumes())render(true)}).catch(()=>{});}
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
const badge=s=>{if(lang==='hi'&&STATUS_HI[s])return'<span class="badge '+(s==='Completed'||s==='verified'||s==='Paid'||s==='Resolved'||s==='Processed'||s==='Delivered'?'ok':s==='New'||s==='pending'||s==='Packed'||s==='Dispatched'||s==='Scheduled'||s==='Sent'?'info':s==='Cancelled'||s==='rejected'?'bad':'warn')+'">'+STATUS_HI[s]+'</span>';
 const m={Completed:'ok',Confirmed:'info',Assigned:'info',Started:'warn',New:'warn',Cancelled:'bad',Open:'warn',Resolved:'ok',OPEN:'warn',UNDER_REVIEW:'info',PANDIT_RESPONSE:'warn',CUSTOMER_RESPONSE:'info',DECISION:'warn',RESOLVED:'ok',Paid:'ok',Pending:'warn',Delivered:'ok',Dispatched:'info',Packed:'info',Processed:'ok',Initiated:'warn',verified:'ok',pending:'warn',rejected:'bad',Sent:'ok',Scheduled:'info',PENDING:'warn',ON_HOLD:'bad',PROCESSING:'info',DISBURSED:'ok',FAILED:'bad',REVERSED:'warn'};return'<span class="badge '+(m[s]||'')+'">'+esc(s)+'</span>'};
const av=(p,sz)=>p&&p.photo?'<img src="'+esc(p.photo)+'" alt="" style="width:'+(sz||40)+'px;height:'+(sz||40)+'px;border-radius:50%;object-fit:cover" aria-hidden="true">':'<div class="av" style="background:'+(p?p.color:'#0c4b49')+(sz?';width:'+sz+'px;height:'+sz+'px':'')+'" aria-hidden="true">'+(p?p.n.replace(/^(Pt\.|Acharya)\s/,'').split(' ').map(x=>x[0]).slice(0,2).join(''):'')+'</div>';
const diya=()=>'<svg class="diya" viewBox="0 0 48 44" aria-hidden="true"><g class="flame"><path d="M24 2c5 7 8 11 5 17-2 4-8 4-10 0-3-6 2-10 5-17z" fill="#ffb62e"/><path d="M24 10c2.5 4 3.5 6 2 9-1 2-4 2-5 0-1.5-3 1.5-5 3-9z" fill="#fff2b0"/></g><path d="M3 24h42c0 10-9 18-21 18S3 34 3 24z" fill="#d2381b"/><path d="M3 24h42" stroke="#f2a900" stroke-width="3"/></svg>';
const logoSvg='<svg viewBox="0 0 48 44" aria-hidden="true"><path d="M24 2c5 7 8 11 5 17-2 4-8 4-10 0-3-6 2-10 5-17z" fill="#f2a900"/><path d="M3 24h42c0 10-9 18-21 18S3 34 3 24z" fill="currentColor"/></svg>';
function mandala(){let s='<svg viewBox="-200 -200 400 400" class="mandala" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.2">';for(let r=30;r<=190;r+=32)s+='<circle r="'+r+'"/>';for(let i=0;i<16;i++)s+='<g transform="rotate('+i*22.5+')"><ellipse cx="0" cy="-120" rx="16" ry="48"/><ellipse cx="0" cy="-168" rx="9" ry="22"/></g>';for(let i=0;i<8;i++)s+='<g transform="rotate('+(i*45+22.5)+')"><path d="M0-30Q14-60 0-90Q-14-60 0-30Z"/></g>';return s+'</g></svg>'}

function pujaCard(p){return'<article class="card pc"><a class="arch" href="#/puja/'+p.id+'" aria-label="'+esc(p.n)+'">'+p.ic+'</a><div class="bd"><span class="cat">'+p.cat+'</span><h3><a href="#/puja/'+p.id+'">'+esc(lang==='hi'&&p.h?p.h:p.n)+'</a></h3><div class="hi">'+p.h+'</div><p class="sm mut">'+esc(lang==='hi'&&p.benHi?p.benHi:p.ben)+'</p><div class="meta"><span>'+p.dur+' min</span><span>from <b>'+inr(p.price*.7)+'</b></span></div><div class="row mt"><a class="btn s" href="#/book/'+p.id+'">'+t('book')+'</a><a class="btn s sec" href="#/puja/'+p.id+'">'+t('details')+'</a></div></div></article>'}
function panditCard(p){return'<article class="card"><div class="row" style="flex-wrap:nowrap">'+av(p)+'<div><h3><a href="#/pandit/'+p.id+'">'+esc(p.n)+'</a></h3><div class="sm mut">'+esc(p.city)+', '+p.exp+' years</div><div>'+stars(p.rating)+' <span class="sm mut">'+p.rating+' ('+p.rev+')</span></div></div></div><p class="sm mt">'+esc(p.bio)+'</p><div class="row mt"><span class="vt">✔ KYC verified</span><span class="sm mut">'+p.langs.join(', ')+'</span></div><div class="row mt"><a class="btn s sec" href="#/pandit/'+p.id+'">View profile</a></div></article>'}
function kitCard(k){return'<article class="card"><div class="row sp"><span style="font-size:2rem">'+k.ic+'</span><b>'+inr(k.p)+'</b></div><h3 class="mt">'+esc(k.n)+'</h3><ul class="sm mut" style="padding-left:18px;margin:8px 0">'+k.items.slice(0,4).map(i=>'<li>'+esc(i)+'</li>').join('')+'</ul><div class="sm mut">+'+(k.items.length-4>0?k.items.length-4:0)+' more items</div><div class="row mt"><button class="btn s" data-act="cadd" data-id="'+k.id+'">Add to cart</button><button class="btn s ghost" data-act="kit" data-id="'+k.id+'">Contents</button></div></article>'}

function header(){
 const r=route(),u=me(),tg=(db&&db.toggles)||{};
 /* Services master switch: when the admin turns services OFF, every bookable
    service leaves the header and a pause notice takes the utility bar. */
 const svc=tg.services!==false;
 const navs=[['pujas','pujas',svc&&tg.home!==false&&tg.online!==false&&tg.temple!==false&&tg.customized!==false],['nri-packages','nri',svc&&tg.nri!==false],['pandits','pandits',svc&&tg.pandit!==false],['temples','temples',svc&&tg.templeDir!==false],['samagri','samagri',svc&&tg.samagri!==false],['prasad','prasad',svc&&tg.prasad!==false],['festivals','festivals',true],['gallery','gallery',true],['kundali','kundali',svc&&tg.kundali!==false],['astrology','astrology',svc&&tg.astrology!==false],['corporate','corporate',true]].filter(n=>n[2]);
 let usr='<button class="btn s" data-act="login">'+t('login')+'</button>';
 if(u)usr='<a class="btn s sec" href="#/account">'+esc(u.n.split(' ')[0])+(u.plus?' Plus':'')+'</a>';
 if(session&&session.role==='pandit')usr='<a class="btn s sec" href="#/portal">Pandit portal</a>';
 if(session&&session.role==='admin')usr='<a class="btn s sec" href="#/admin">Admin</a>';
 const langSel='<span class="langsel" role="group" aria-label="Language"><button data-act="setlang" data-v="en" '+(lang==='en'?'class="on"':'')+' aria-pressed="'+(lang==='en')+'">English</button><span aria-hidden="true">|</span><button data-act="setlang" data-v="hi" '+(lang==='hi'?'class="on"':'')+' aria-pressed="'+(lang==='hi')+'">हिंदी</button></span>';
 /* Notifications centre (item): bell badge for every signed-in role — the count
    is state.notifsUnread, cleared by POST /me/notifs/read when the panel opens. */
 const bell=session?'<button class="cartb" data-act="notifs" aria-label="Notifications">🔔'+(((db&&db.notifsUnread)||0)?'<i>'+db.notifsUnread+'</i>':'')+'</button>':'';
 $('#hdr').innerHTML='<div class="util"><div class="wrap"><span>'+(svc?'':'<b>Services are paused</b> — new bookings are temporarily closed. ')+(db&&db.config.demo?'Demo mode: sample pandits, temples and reviews. Test OTP is 123456.':'Verified pandits, samagri and prasad, booked online')+'</span><span>'+langSel+'<a href="#/about">'+(lang==='hi'?'हमारे बारे में':'About us')+'</a><a href="#/contact">'+(lang==='hi'?'संपर्क':'Contact')+'</a><a href="#/partner">'+(lang==='hi'?'साझेदारी':'Partner with us')+'</a><a href="#/our-people">'+(lang==='hi'?'हमारे लोग':'Our People')+'</a><button data-act="theme" aria-label="Toggle light or dark theme">'+(lang==='hi'?'थीम':'Theme')+'</button></span></div></div><div class="nav"><div class="wrap navin"><a class="logo" href="#/">'+logoSvg+'<span>DaivikPuja<small>दैविक पूजा</small></span></a><nav class="links" id="links" aria-label="Main">'+navs.map(n=>'<a href="#/'+n[0]+'" class="'+(r.page===n[0]?'on':'')+'">'+t(n[1])+'</a>').join('')+'</nav><div class="navr">'+bell+'<button class="cartb" data-act="cart" aria-label="Cart">🛒'+(cart.length?'<i>'+cart.reduce((a,c)=>a+c.q,0)+'</i>':'')+'</button>'+usr+'<button class="burger" data-act="burger" aria-label="Menu">☰</button></div></div></div>';
}

/* Additional-requirements Phase C: built-in inline SVG set for the social
   footer icons. Rows arrive from /state (`socials`); each row's icon column
   picks a glyph and ANY unknown key falls back to the generic globe — a new
   platform can be published in the admin before its glyph exists, and the
   footer never renders a broken image. No external icon fonts, no images. */
const SOCIAL_ICONS={
 facebook:'<path fill="currentColor" d="M13.4 21.5v-8h2.7l.4-3.1h-3.1V8.4c0-.9.25-1.5 1.55-1.5H16.6V4.1c-.3-.04-1.3-.13-2.47-.13-2.45 0-4.13 1.5-4.13 4.24V10.4H7.3v3.1h2.7v8z"/>',
 instagram:'<g fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.4" y="3.4" width="17.2" height="17.2" rx="5"/><circle cx="12" cy="12" r="4.1"/><circle cx="17.1" cy="6.9" r="1.15" fill="currentColor" stroke="none"/></g>',
 youtube:'<path fill="currentColor" d="M21.6 7.2a2.5 2.5 0 0 0-1.75-1.77C18.25 5 12 5 12 5s-6.25 0-7.85.43A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.75 1.77C5.75 19 12 19 12 19s6.25 0 7.85-.43a2.5 2.5 0 0 0 1.75-1.77A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8zM10 15.4V8.6l5.9 3.4z"/>',
 x:'<path fill="currentColor" d="M17.6 3h3.1l-6.8 7.8L22 21h-6.3l-4.9-6.4L5.1 21H2l7.3-8.3L2 3h6.4l4.4 5.9zm-1.1 16.1h1.7L7.6 4.8H5.8z"/>',
 twitter:'<path fill="currentColor" d="M22 5.9c-.7.3-1.5.5-2.4.6.9-.5 1.5-1.3 1.8-2.3-.8.5-1.7.8-2.6 1a4.1 4.1 0 0 0-7 3.7A11.6 11.6 0 0 1 3.4 4.7a4.1 4.1 0 0 0 1.3 5.5c-.7 0-1.3-.2-1.9-.5 0 2 1.4 3.7 3.3 4.1-.6.2-1.2.2-1.9.1a4.1 4.1 0 0 0 3.8 2.9A8.2 8.2 0 0 1 2 18.6a11.6 11.6 0 0 0 6.3 1.8c7.5 0 11.7-6.3 11.7-11.7v-.5c.8-.6 1.5-1.3 2-2.3z"/>',
 linkedin:'<path fill="currentColor" d="M5 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3.2 9.4h3.6V21H3.2zM9.6 9.4h3.4v1.6c.7-1.1 2-1.9 3.7-1.9 3 0 4.3 1.9 4.3 5.1V21h-3.6v-5.6c0-1.6-.6-2.6-2-2.6-1.1 0-1.7.7-2 1.5-.1.2-.1.6-.1.9V21H9.6z"/>',
 whatsapp:'<path fill="currentColor" d="M12 2.5a9.5 9.5 0 0 0-8.1 14.4L2.5 21.5l4.7-1.3A9.5 9.5 0 1 0 12 2.5zm0 17.2a7.7 7.7 0 0 1-3.9-1.1l-.3-.2-2.8.8.8-2.7-.2-.3A7.7 7.7 0 1 1 12 19.7zm4.2-5.7c-.2-.1-1.4-.7-1.6-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.3 6.3 0 0 1-3.1-2.7c-.2-.4 0-.5.1-.6l.4-.5c.1-.2.1-.3 0-.5l-.8-1.9c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.2.3-.9.9-.9 2.1s.9 2.4 1 2.6c.1.2 1.8 2.9 4.5 4 .6.3 1.1.4 1.5.5.7.2 1.3.2 1.7.1.6-.1 1.4-.6 1.6-1.1.2-.6.2-1 .1-1.1z"/>',
 telegram:'<path fill="currentColor" d="M21.5 4.3 2.9 11.5c-.9.4-.9 1.6 0 2l4.6 1.4 1.7 5.3c.3.8 1.2 1 1.8.4l2.4-2.4 4.6 3.4c.7.5 1.6.1 1.8-.7l3.2-14.9c.2-.9-.7-1.6-1.5-1.1zM8.9 14.6l9.2-5.8-7.4 6.7-.3 3.3z"/>',
 website:'<g fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.4 5.6 3.4 8.5s-1 5.9-3.4 8.5c-2.4-2.6-3.4-5.6-3.4-8.5s1-5.9 3.4-8.5z"/></g>',
 globe:'<g fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.4 5.6 3.4 8.5s-1 5.9-3.4 8.5c-2.4-2.6-3.4-5.6-3.4-8.5s1-5.9 3.4-8.5z"/></g>'
};
const SOCIAL_LABEL={facebook:'Facebook',instagram:'Instagram',youtube:'YouTube',x:'X (Twitter)',twitter:'Twitter',linkedin:'LinkedIn',whatsapp:'WhatsApp',telegram:'Telegram',website:'Website'};
const socialTitle=(s)=>SOCIAL_LABEL[String(s.platform||'').toLowerCase()]||s.platform||'Social profile';
function socialIconSvg(key,size){const k=String(key||'').toLowerCase();const body=SOCIAL_ICONS[k]||SOCIAL_ICONS.globe;const n=size||18;return '<svg viewBox="0 0 24 24" width="'+n+'" height="'+n+'" aria-hidden="true" focusable="false">'+body+'</svg>'}
function socialLinksHtml(){const links=(db&&db.socials)||[];return links.map((s)=>'<a class="socialicon" href="'+esc(s.url)+'" target="_blank" rel="noopener noreferrer" aria-label="'+esc(socialTitle(s))+'" title="'+esc(socialTitle(s))+'">'+socialIconSvg(s.icon||s.platform,20)+'</a>').join('')}
function footer(){$('#ftr').innerHTML='<div class="wrap"><div class="grid g4"><div><div class="logo" style="color:#fff">'+logoSvg+'<span>DaivikPuja</span></div><p class="sm mt"><b>DaivikPuja – Sanatan Seva Platform</b><br>The complete puja experience on one trusted platform: puja, verified pandit, samagri, prasad.</p><div class="ftr-socials">'+socialLinksHtml()+'</div></div><div><h4>Explore</h4><a href="#/pujas">Puja catalogue</a><a href="#/pandits">Verified pandits</a><a href="#/temples">Temples</a><a href="#/festivals">Festival calendar</a><a href="#/gallery">Photo gallery</a><a href="#/kundali">Kundali</a><a href="#/astrology">Astrology</a></div><div><h4>Shop and save</h4><a href="#/samagri">Samagri kits</a><a href="#/prasad">Prasad</a><a href="#/rewards">DaivikPuja Rewards</a><a href="#/plus">DaivikPuja Plus</a><a href="#/custom-puja">Customised puja</a><a href="#/nri-packages">Puja packages for the diaspora</a><a href="#/corporate">Corporate puja</a></div><div><h4>Company</h4><a href="#/about">About</a><a href="#/contact">Contact and support</a><a href="#/our-people">Our people</a><a href="#/partner">Pandit partners</a><a href="#/admin">Admin panel (demo)</a></div></div><p class="sm mt2" style="opacity:.7">'+(db&&db.config.demo?'Demo data is loaded. Prices, pandits, temples and reviews are illustrative.':'')+'</p></div>'}

/* router */
function route(){const h=location.hash.replace(/^#\/?/,'');const[p,qs]=h.split('?');const parts=p.split('/').filter(Boolean);return{page:parts[0]||'',arg:parts[1],arg2:parts[2],q:Object.fromEntries(new URLSearchParams(qs||''))}}
