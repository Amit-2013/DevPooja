/* Router, event handlers and startup. Every mutation goes to the API; the server is the source of truth. */
const ROUTES={'':home,pujas,puja:pujaDetail,book,pandits:panditsPage,pandit:panditProfile,temples,samagri:samagriPage,prasad:prasadPage,festivals:festivalsPage,astrology,corporate,about,contact,account,rewards:rewardsPage,plus:plusPage,partner,'register-pandit':regPandit,portal,admin,'custom-puja':customPujaPage,kundali(r){return r.arg==='result'?kundaliResult():kundaliForm()}};
function render(keep){const r=route();if(r.page!=='book')W=null;const fn=ROUTES[r.page]||nf;header();$('#view').innerHTML=fn(r);const h=$('#view h1');document.title=(h?h.textContent.slice(0,60)+' | ':'')+'DaivikPooja';if(!keep)scrollTo(0,0)}
async function logout(){setToken(null);try{await sync()}catch(e){}location.hash='#/';render()}
const chk=v=>v&&v.trim().length>0;
const lead=(type,name,details)=>api('/leads',{body:{type,name,details}});
const B=id=>db.bookings.find(b=>b.id===id);
const isImg=u=>/\.(jpe?g|png|webp)$/i.test(u);

function bdetModal(b){const p=PU(b.pujaId),pd=PD(b.panditId),u=US(b.userId)||{n:'Customer'};modal('<h2>'+p.ic+' '+esc(p.n)+'</h2><p class="sm mut">'+b.id+' '+badge(b.status)+'</p><div class="grid g2 mt"><div><p class="sm"><b>Customer:</b> '+esc(u.n)+'<br><b>Type:</b> '+MODES[b.mode].n+'<br><b>When:</b> '+fmtD(b.date)+', '+b.slot+'<br><b>Where:</b> '+(b.mode==='temple'?esc((TP(b.templeId)||{}).n||''):esc(b.addr?b.addr.line+', '+b.addr.city:''))+'<br><b>Pandit:</b> '+(pd?esc(pd.n):'Being assigned')+'<br><b>For:</b> '+esc(b.member||'Self')+(b.notes?'<br><b>Instructions:</b> '+esc(b.notes):'')+'<br><b>Payment:</b> '+esc(b.pay.method)+', ref '+esc(b.pay.ref||'')+'</p><h3 class="mt">Audit trail</h3><ul class="sm mt" style="padding-left:18px">'+b.log.map(l=>'<li>'+esc(l[0])+', '+fmtD(l[1])+'</li>').join('')+'</ul></div><div class="card flat"><h3>Price breakdown</h3><div class="mt">'+sumLines(b.q)+'</div></div></div>',1)}
function say(who,html){const m=document.createElement('div');m.className='msg '+who;m.innerHTML=html;$('#msgs').appendChild(m);$('#msgs').scrollTop=1e9}
function askGuide(q){if(!q)return;$('#asst').classList.add('on');say('u',esc(q));setTimeout(()=>say('a',guide(q)),250)}
function openAsst(){const a=$('#asst');a.classList.toggle('on');if(a.classList.contains('on')&&!$('#msgs').children.length){say('a','Namaste. Tell me what you are seeking, ask about a festival, or ask how booking works.<div class="row mt">'+['I want peace and prosperity in my family','What is needed for Diwali?','How do refunds work?'].map(x=>'<button class="chip" data-act="askq" data-q="'+x+'">'+x+'</button>').join('')+'</div><div class="sm mut mt">Suggestions come from the catalogue and simple rules.</div>');$('#aq').focus()}}
const pageOf=()=>route().page;
const closeAnd=async(p)=>{const r=await p;if(r)closeModal();return r};
const fdate=()=>addDays(1);

const ACT={
 lang(){lang=lang==='en'?'hi':'en';store.set('dp_lang',lang);render(true)},
 setlang(d){if(d.v===lang)return;lang=d.v;store.set('dp_lang',lang);render(true)},
 theme(){const el=document.documentElement,cur=el.dataset.theme||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'),nx=cur==='dark'?'light':'dark';el.dataset.theme=nx;store.set('dp_theme',nx)},
 burger(){$('#links').classList.toggle('open')},
 login(){loginModal()},'pandit-login'(){loginModal('pandit')},logout,close(){closeModal()},
 print(){try{window.print()}catch(e){toast('Printing is not available here')}},
 ltab(d,el){$$('.tabs button',el.closest('.mbox')).forEach(b=>b.classList.toggle('on',b===el));$('#lb').innerHTML=loginForm(d.v)},
 async sendotp(d,el){try{const r=await api('/auth/otp/send',{body:{mobile:val('lm')}});$('#lotp').innerHTML='<label class="f mt">Enter the 6-digit OTP'+(r.devOtp?' (demo OTP: '+r.devOtp+')':' sent by SMS')+'<input id="lo" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>';el.textContent='Verify and continue';el.dataset.act='verifyotp';$('#lo').focus()}catch(e){toast(e.message)}},
 async verifyotp(){try{doLogin(await api('/auth/otp/verify',{body:{mobile:val('lm'),otp:val('lo'),name:val('ln'),as:PAGE.la==='pandit'?'pandit':undefined}}))}catch(e){toast(e.message)}},
 async emlogin(){try{doLogin(await api('/auth/email',{body:{email:val('le'),password:val('lp'),name:val('ln')}}))}catch(e){toast(e.message)}},
 async 'demo-user'(){try{doLogin(await api('/auth/demo',{body:{role:'customer'}}))}catch(e){toast(e.message)}},
 /* customised puja request (public form) */
 async cpureq(){if(!chk(val('cun'))||!/\d{10}/.test(val('cum').replace(/\D/g,'')))return toast('Enter your name and a 10-digit mobile');
  try{await api('/custom-puja',{body:{name:val('cun'),mobile:val('cum').replace(/\D/g,'').slice(-10),purpose:val('cupu')||undefined,deity:val('cud')||undefined,preferredDate:val('cupd')||undefined,city:val('cuci')||undefined,budget:val('cub')?+val('cub'):undefined,notes:val('cuno')||undefined}});toast('Request received. Our team will call you within one working day.');render(true)}catch(e){toast(e.message)}},
 dfill(d){const m=$('#lm');if(m)m.value=d.m;const n=$('#ln');if(n&&d.n)n.value=d.n;const o=$('#lo');if(o)o.focus();},
 dfillemail(d){const tabs=$$('#lb');const e=$('#le');if(e){e.value=d.m;}const p=$('#lp');if(p)p.value='demo1234';const n=$('#ln');if(n&&d.n)n.value=d.n;const b=$('[data-act=emlogin]');if(b)b.focus();if(!e)toast('Switch to the Email tab first');},
 async 'demo-pandit'(){try{await doLogin(await api('/auth/demo',{body:{role:'pandit'}}))}catch(e){toast(e.message)}},
 async alogin(){try{await doLogin(await api('/auth/admin',{body:{email:val('ae'),password:val('ap2')}}))}catch(e){toast(e.message)}},
 /* kundali admin */
 akcond(d,el){run(()=>api('/admin/kundali/conditions/'+d.id,{method:'PATCH',body:{active:el.checked}}))},
 /* demo data tab */
 async amock(){try{const r=await api('/admin/demo/bookings',{body:{count:val('mkcount')}});await sync();toast('Mock bookings created: '+(r.created||0));render(true)}catch(e){toast(e.message)}},
 async areset(){if(val('mkconfirm')!=='RESET')return toast('Type RESET in the box to confirm');
  try{const r=await api('/admin/demo/reset',{body:{confirm:'RESET'}});if(r.token)setToken(r.token);await sync();toast('All data reset to the fresh demo state');render();}catch(e){toast(e.message)}},
 akcedit(d){const c=((db.kundali||{}).conditions||[]).find(x=>x.code===d.id);if(!c)return;
  modal('<h2>Edit condition</h2><div class="frm mt"><label class="f">Name<input id="kcen" value="'+esc(c.name)+'"></label><label class="f">Customer-facing description<textarea id="kced">'+esc(c.descr||'')+'</textarea></label><label class="f">Suggested remedy<textarea id="kcer">'+esc(c.remedy||'')+'</textarea></label><label class="f">Severity<select id="kces">'+['low','medium','high'].map(s=>'<option'+(c.severity===s?' selected':'')+'>'+s+'</option>').join('')+'</select></label><button class="btn mt" data-act="akceditok" data-id="'+esc(c.code)+'">Save</button></div>')},
 async akceditok(d){await closeAnd(run(()=>api('/admin/kundali/conditions/'+d.id,{method:'PATCH',body:{name:val('kcen'),descr:val('kced'),remedy:val('kcer'),severity:val('kces')}}),'Condition saved'))},
 async akrule(){await closeAnd(run(()=>api('/admin/kundali/rules',{body:{conditionCode:val('krc'),pujaId:val('krp'),priority:val('krr'),weight:val('krw'),reason:val('krreason')}}),'Mapping saved'))},
 async akcondadd(){await closeAnd(run(()=>api('/admin/kundali/conditions',{body:{code:val('knc'),name:val('knn'),severity:val('kns'),descr:val('knd')}}),'Condition added'))},
 hsearch(){location.hash='#/pujas?q='+encodeURIComponent(val('hq'))},
 /* kundali flow */
 async kgen(){const f=PAGE.kf=PAGE.kf||{};const Lg=lang==='hi';
  const fam=route().q.family; /* family member kundali: /#/kundali?family=fmXXX */
  if(!fam){
   if(!chk(val('kn')))return toast(Lg?'अपना पूरा नाम भरें':'Enter your full name');
   if(!val('kd'))return toast(Lg?'जन्म तिथि भरें':'Enter your date of birth');
   if(!f.placeId)return toast(Lg?'सूची से जन्म स्थान चुनें':'Choose your birth place from the list');
   const acc=val('ka');
   if(acc==='exact'&&!val('kt'))return toast(Lg?'जन्म समय भरें, या शुद्धता बदलें':'Enter the time of birth, or change accuracy to approximate/unknown');
  }
  const body={name:val('kn'),gender:val('kg')||undefined,dob:val('kd'),tob:val('kt')||undefined,birthTimeAccuracy:val('ka'),placeId:f.placeId||undefined,purpose:val('ku'),email:val('ke')||undefined,mobile:val('km')||undefined,gotra:val('kgot')||undefined,save:$('#ksave')?$('#ksave').checked:true,idemKey:'ui-'+Date.now()+'-'+Math.random().toString(36).slice(2,8)};
  if(fam){body.familyMemberId=fam;delete body.name;delete body.dob;delete body.tob;delete body.gender;body.placeId=f.placeId||undefined;
   const q=await api('/kundali/quote',{body:{relationship:'Family'}}).catch(()=>null);
   if(q&&!confirm('Family Member Kundali\nPrice: '+inr(q.quote.final)+' ('+q.quote.currency+')\n\nContinue to generation?'))return;
  }
  const prev=$('#view').innerHTML;$('#view').innerHTML=kLoading('...');
  try{const r=await api('/kundali/generate',{body});
   r.catalogConditions=await api('/kundali/conditions').then(x=>x.conditions).catch(()=>[]);
   PAGE.k=r;
   if(location.hash!=='#/kundali/result')location.hash='#/kundali/result';else render(true);
   scrollTo(0,0);
  }catch(e){$('#view').innerHTML=prev;toast(e.message)}},
 kplace(d,el){const f=PAGE.kf=PAGE.kf||{};f.placeId=+d.id;f.placeLabel=d.label;try{f.placeData=JSON.parse(d.json)}catch(e){f.placeData=null}$('#kp').value=d.label;$('#kpl').innerHTML='<span class="badge ok">'+esc(d.label)+'</span>';const box=$('#kverify');if(box)box.innerHTML=f.placeData?kVerifyBox(f.placeData):''},
 intent(d){$('#skout').innerHTML=sankalpOut(d.q)},
 asst:openAsst,ask(){const q=val('aq');$('#aq').value='';askGuide(q)},askq(d){askGuide(d.q)},askp(d){askGuide('Tell me about '+PU(d.id).n+' and what I need')},
 calm(d){const g=PAGE.cal;g.m+=+d.d;if(g.m<0){g.m=11;g.y--}if(g.m>11){g.m=0;g.y++}calRender()},
 /* cart */
 cart(){cartModal()},cadd(d){const c=cart.find(x=>x.k===d.id);c?c.q++:cart.push({k:d.id,q:1});saveCart();header();toast('Added to cart')},
 cq(d){const c=cart.find(x=>x.k===d.id);c.q+=+d.d;if(c.q<1)cart=cart.filter(x=>x!==c);saveCart();header();cartModal()},
 kit(d){const k=KITS.find(x=>x.id===d.id);modal('<h2>'+k.ic+' '+k.n+'</h2><ul class="mt" style="padding-left:20px">'+k.items.map(i=>'<li>'+esc(i)+'</li>').join('')+'</ul><div class="row mt"><b>'+inr(k.p)+'</b><button class="btn s" data-act="cadd" data-id="'+k.id+'">Add to cart</button></div>')},
 async corder(){if(!me()){afterLogin=()=>cartModal();closeModal();loginModal();return}
  const r=await run(()=>api('/orders',{body:{items:cart.map(c=>({k:c.k,q:c.q})),address:val('cad'),city:val('cct')}}),'Order placed');if(r){cart=[];saveCart();closeModal();location.hash='#/account/orders'}},
 /* wizard */
 'wz-mode'(d){W.mode=d.v;W.step=2;W.templeId=W.mode==='temple'?W.templeId:'';render(true)},
 'wz-slot'(d){W.slot=d.v;if(W.panditId&&!free(PD(W.panditId),W.date,W.slot)){W.panditId='';W.pSel=false}render(true)},
 'wz-temple'(d){W.templeId=d.v;render(true)},
 'wz-pandit'(d){W.panditId=d.v;W.pSel=true;render(true)},
 'wz-sam'(d){const i=W.sam.indexOf(d.v);i>-1?W.sam.splice(i,1):W.sam.push(d.v);render(true)},
 'wz-pra'(d){const i=W.pra.indexOf(d.v);i>-1?W.pra.splice(i,1):W.pra.push(d.v);render(true)},
 async 'wz-coupon'(){const c=val('cpn').toUpperCase();if(!c){W.coupon='';W.couponObj=null;W.cmsg='';return render(true)}
  try{const r=await api('/quote',{body:{pujaId:W.pujaId,mode:W.mode||'home',panditId:W.panditId,sam:W.sam,pra:W.pra,coupon:c}});if(r.couponError){W.coupon='';W.couponObj=null;W.cmsg=r.couponError}else{W.coupon=c;W.couponObj=r.coupon;W.cmsg='Coupon applied.'}}catch(e){W.cmsg=e.message}render(true)},
 'wz-pts'(d,el){W.useP=el.checked;render(true)},'wz-method'(d){W.pay=d.v;render(true)},
 'wz-back'(){W.step--;render(true);scrollTo(0,0)},'wz-next':wizNext,'wz-pay':wizPay,
 /* customer account */
 bdet(d){bdetModal(B(d.id))},
 binv(d){modal(invoiceHtml(B(d.id)),1)},
 bres(d){const b=B(d.id);PAGE.rs={id:b.id,slot:b.slot};modal('<h2>Reschedule '+b.id+'</h2><label class="f mt">New date<input type="date" id="rd" min="'+addDays(1)+'" value="'+b.date+'"></label><div class="slots mt" id="rsl">'+SLOTS.map(s=>'<button class="chip '+(s===b.slot?'on':'')+'" data-act="rslot" data-v="'+s+'">'+s+'</button>').join('')+'</div><button class="btn mt" data-act="bresok">Confirm new time</button>')},
 rslot(d,el){PAGE.rs.slot=d.v;$$('#rsl .chip').forEach(c=>c.classList.toggle('on',c===el))},
 async bresok(){await closeAnd(run(()=>api('/bookings/'+PAGE.rs.id+'/reschedule',{body:{date:val('rd'),slot:PAGE.rs.slot}}),'Rescheduled'))},
 bcan(d){const b=B(d.id),pc=refundPct(b);PAGE.cn=b.id;modal('<h2>Cancel '+b.id+'?</h2><p class="mt">Refund policy: 100% more than 48 hours ahead, 75% between 24 and 48 hours, 50% within 24 hours.</p><div class="note mt">You will get <b>'+pc+'%</b>, which is <b>'+inr(b.q.total*pc/100)+'</b>, back to your original payment method.</div><div class="row mt"><button class="btn bad" data-act="bcanok">Cancel booking</button><button class="btn ghost" data-act="close">Keep booking</button></div>')},
 async bcanok(){await closeAnd(run(()=>api('/bookings/'+PAGE.cn+'/cancel',{body:{}}),'Booking cancelled. Refund initiated.'))},
 blive(d){const b=B(d.id),pd=PD(b.panditId);modal('<h2>Live puja</h2><div class="vid"><div style="font-size:3rem" class="flame">🪔</div><b>'+esc(pd?pd.n:'Pandit')+' is conducting the puja</b><span class="sm" style="opacity:.8">Video room. Plug in your video provider (see README)</span></div><p class="sm mut mt">Your sankalp is read with your name and gotra. Photos and a certificate follow after completion.</p><button class="btn mt" data-act="close">Leave call</button>')},
 bmed(d){const b=B(d.id),m=b.mediaUrls||[];modal('<h2>Photos and video</h2><div class="grid g3 mt">'+(m.length?m.map(u=>isImg(u)?'<a href="'+esc(u)+'" target="_blank" rel="noopener"><img src="'+esc(mediaUrl(u))+'" alt="Puja photo" style="width:100%;border-radius:8px;aspect-ratio:4/3;object-fit:cover"></a>':'<video controls src="'+esc(mediaUrl(u))+'" style="width:100%;border-radius:8px"></video>').join(''):'<div class="ph">🪔</div>')+'</div>'+(m.length?'':'<p class="sm mut mt">The pandit has not uploaded media for this puja.</p>'))},
 bcert(d){const b=B(d.id),pd=PD(b.panditId);modal('<div class="cert"><h2>Puja Completion Certificate</h2><p class="mt">This confirms that</p><h3 style="font-size:1.5rem">'+esc(PU(b.pujaId).n)+'</h3><p>was performed for <b>'+esc(b.member&&b.member!=='Self'?b.member:me().n)+'</b> on '+fmtD(b.date)+'<br>by <b>'+esc(pd?pd.n:'DaivikPooja pandit')+'</b> ('+MODES[b.mode].n+')</p><p class="sm mut mt">Booking '+b.id+'. Digital confirmation by DaivikPooja.</p></div><button class="btn s mt noprint" data-act="print">Print</button>')},
 brev(d){PAGE.rv={id:d.id,r:5};modal('<h2>Rate your puja</h2><div class="row mt" id="rst">'+[1,2,3,4,5].map(n=>'<button class="chip on" data-act="rstar" data-v="'+n+'" aria-label="'+n+' stars">'+n+' ★</button>').join('')+'</div><label class="f mt">Your review<textarea id="rvt" maxlength="500"></textarea></label><button class="btn mt" data-act="brevok">Submit review</button>')},
 rstar(d){PAGE.rv.r=+d.v;$$('#rst .chip').forEach((c,i)=>c.classList.toggle('on',i<+d.v))},
 async brevok(){await closeAnd(run(()=>api('/bookings/'+PAGE.rv.id+'/review',{body:{r:PAGE.rv.r,t:val('rvt')}}),'Thank you. You earned 10 points.'))},
 psave(){run(()=>api('/me',{method:'PATCH',body:{name:val('pn'),email:val('pe'),pref:{deity:val('pdv'),lang:val('pl2'),wa:$('#pwa').checked,sms:$('#psm').checked,em:$('#pem').checked}}}),'Profile saved')},
 aadd(){run(()=>api('/me/addresses',{body:{l:val('al'),line:val('ai'),city:val('ac'),pin:val('ap')}}),'Address saved')},
 adel(d){run(()=>api('/me/addresses/'+d.id,{method:'DELETE'}))},
 async fadd(){try{await api('/me/family',{body:{relationship:val('frel')||undefined,name:val('fn'),gender:val('fgen')||undefined,dob:val('fdob')||undefined,tob:val('ftob')||undefined,gotra:val('fg')||undefined,city:val('fcity')||undefined}});await sync();toast('Family member saved');render(true)}catch(e){toast(e.message)}},
 fdel(d){run(()=>api('/me/family/'+d.id,{method:'DELETE'}))},
 tadd(){run(()=>api('/tickets',{body:{b:val('tb'),t:val('tt')}}),'Ticket raised')},
 plus(d){if(!me()){afterLogin=()=>render(true);loginModal();return}run(()=>api('/me/plus',{body:{on:true}}),'Welcome to DaivikPooja Plus')},
 plusx(){run(()=>api('/me/plus',{body:{on:false}}),'Membership cancelled')},
 /* public forms */
 astr(d){modal('<h2>'+esc(d.n)+'</h2><div class="frm mt"><label class="f">Name<input id="an"></label><label class="f">Mobile<input id="am" inputmode="numeric" maxlength="10"></label></div><button class="btn mt" data-act="astrok" data-n="'+esc(d.n)+'">Request callback</button>')},
 async astrok(d){if(!chk(val('an'))||!/^\d{10}$/.test(val('am')))return toast('Enter your name and a 10-digit mobile');try{await lead('Astrology',val('an'),d.n+', '+val('am'));closeModal();toast('Request received. We will call you.')}catch(e){toast(e.message)}},
 async kundli(){if(!chk(val('kn'))||!val('kd')||!chk(val('kp')))return toast('Fill name, date and place of birth');try{await lead('Kundli',val('kn'),'Born '+val('kd')+' '+val('kt')+', '+val('kp')+', '+val('km'));toast('Kundli request received')}catch(e){toast(e.message)}},
 async corp(){if(!chk(val('cc'))||!/^\S+@\S+\.\S+$/.test(val('ce')))return toast('Enter company and a valid email');try{await lead('Corporate',val('cc'),val('cty')+', '+val('cat')+' attendees, '+val('cn')+', '+val('ce')+', '+val('cp'));toast('Request sent. Your account manager will reach out.')}catch(e){toast(e.message)}},
 async contact(){if(!chk(val('ctn'))||!chk(val('ctm')))return toast('Enter your name and message');try{await lead('Contact',val('ctn'),val('ctm')+' | '+val('ctc')+(val('ctb')?' | Booking '+val('ctb'):''));$('#ctm').value='';toast('Message sent. We reply within one working day.')}catch(e){toast(e.message)}},
 async rotp(){try{const r=await api('/auth/otp/send',{body:{mobile:val('rm')}});$('#rotpm').textContent=r.devOtp?'Demo OTP: '+r.devOtp:'OTP sent by SMS'}catch(e){toast(e.message)}},
 async regp(){const f=new FormData();f.append('name',val('rn'));f.append('mobile',val('rm'));f.append('otp',val('rotp'));f.append('city',val('rc'));f.append('exp',val('rx')||'0');f.append('idType',val('rid'));f.append('spec',$$('.rsp:checked').map(x=>x.value).join(','));f.append('langs',$$('.rsl:checked').map(x=>x.value).join(','));
  [['rf1','idDoc'],['rf2','cert'],['rf3','photo']].forEach(([id,k])=>{const e=$('#'+id);if(e&&e.files[0])f.append(k,e.files[0])});
  try{await api('/pandit/register',{form:f});location.hash='#/partner';toast('Application submitted. KYC review is in progress.')}catch(e){toast(e.message)}},
 /* pandit portal */
 pacc(d){run(()=>api('/pandit/bookings/'+d.id+'/accept',{body:{}}),'Booking accepted')},
 prej(d){run(()=>api('/pandit/bookings/'+d.id+'/reject',{body:{}}),'Booking declined. Admin will reassign.')},
 pstart(d){run(()=>api('/pandit/bookings/'+d.id+'/start',{body:{}}),'Puja started')},
 pdone(d){const b=B(d.id),p=PU(b.pujaId);modal('<h2>Completion update</h2><p class="sm mut">'+esc(p.n)+', '+b.id+'</p><div class="col mt">'+['Sankalp taken with names and gotra','Main worship and aarti completed','Samagri used and remaining handed over','Customer satisfied and blessings given'].map(x=>'<label><input type="checkbox" class="dck"> '+x+'</label>').join('')+'</div><label class="f mt">Upload photos or video (optional, up to 8 files)<input type="file" id="pmedia" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"></label><button class="btn mt" data-act="pdoneok" data-id="'+b.id+'">Mark completed</button>')},
 async pdoneok(d){if($$('.dck:checked').length<4)return toast('Complete the checklist first');const f=new FormData();[...($('#pmedia').files||[])].forEach(x=>f.append('media',x));await closeAnd(run(()=>api('/pandit/bookings/'+d.id+'/complete',{form:f}),'Puja marked completed. Payout queued.'))},
 pchk(d){const b=B(d.id),p=PU(b.pujaId);modal('<h2>Puja checklist</h2><p class="sm mut">'+esc(p.n)+'</p><h3 class="mt">Samagri</h3><div class="col mt">'+p.sam.map(s=>'<label><input type="checkbox"> '+esc(s)+'</label>').join('')+'</div><h3 class="mt">Steps</h3><ol class="sm mt" style="padding-left:20px"><li>Sankalp</li><li>Invocation of '+esc(p.deity)+'</li><li>Main worship</li><li>Aarti</li><li>Prasad and blessings</li></ol>')},
 poff(d){run(()=>api('/pandit/availability',{body:{date:d.d}}))},
 pcm(d){const g=PAGE.pc;g.m+=+d.d;if(g.m<0){g.m=11;g.y--}if(g.m>11){g.m=0;g.y++}render(true)},
 psv(){run(()=>api('/pandit/profile',{method:'PATCH',body:{city:val('qc'),exp:val('qx'),langs:val('ql'),bio:val('qb'),spec:$$('.qs:checked').map(x=>x.value).join(','),avail:$('#qa').checked}}),'Profile saved')},
 pfeat(){run(()=>api('/pandit/feature',{body:{}}),'Featured listing activated')},
 /* admin */
 aman(){modal('<h2>Manual booking</h2><div class="frm mt"><label class="f">Customer name<input id="mn"></label><label class="f">Mobile<input id="mm" inputmode="numeric" maxlength="10"></label><label class="f">Puja<select id="mp">'+PUJAS.map(p=>'<option value="'+p.id+'">'+p.n+'</option>').join('')+'</select></label><label class="f">Type<select id="mt">'+Object.entries(MODES).map(([k,m])=>'<option value="'+k+'">'+m.n+'</option>').join('')+'</select></label><label class="f">Date<input type="date" id="md" value="'+addDays(2)+'"></label><label class="f">Slot<select id="ms">'+SLOTS.map(s=>'<option>'+s+'</option>').join('')+'</select></label><label class="f">City<select id="mc">'+CITIES.map(c=>'<option>'+c+'</option>').join('')+'</select></label></div><button class="btn mt" data-act="amanok">Create booking</button>')},
 async amanok(){await closeAnd(run(()=>api('/admin/bookings/manual',{body:{name:val('mn'),mobile:val('mm'),pujaId:val('mp'),mode:val('mt'),date:val('md'),slot:val('ms'),city:val('mc')}}),'Booking created'))},
 arf(d){run(()=>api('/admin/bookings/'+d.id+'/refund',{body:{}}),'Refund processed')},
 aesc(d){run(()=>api('/admin/bookings/'+d.id+'/escalate',{body:{}}))},
 akyc(d){run(()=>api('/admin/pandits/'+d.id+'/kyc',{body:{status:d.v}}),'KYC '+d.v)},
 afeat(d){run(()=>api('/admin/pandits/'+d.id+'/feature',{body:{}}))},
 async adoc(d){try{const r=await fetch('/api/admin/pandits/'+d.id+'/docs/'+d.k,{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw new Error('Document not available');const u=URL.createObjectURL(await r.blob());window.open(u,'_blank','noopener')}catch(e){toast(e.message)}},
 apr(d){run(()=>api('/admin/pujas/'+d.id,{method:'PATCH',body:{price:val('pp_'+d.id)}}),'Price saved')},
 ahide(d,el){run(()=>api('/admin/pujas/'+d.id,{method:'PATCH',body:{hidden:!el.checked}}))},
 anp(){run(()=>api('/admin/pujas',{body:{name:val('npn'),hindi:val('nph'),cat:val('npc'),dur:val('npd'),price:val('npp'),kit:val('npk')}}),'Puja added')},
 apuedit(d){const p=PU(d.id);if(!p)return;
  modal('<h2>Edit puja</h2><div class="frm mt"><label class="f">Name<input id="pen" value="'+esc(p.n)+'"></label><label class="f">Hindi name<input id="peh" value="'+esc(p.h||'')+'"></label><label class="f">Category<input id="pec" value="'+esc(p.cat||'')+'"></label><label class="f">Deity<input id="ped" value="'+esc(p.deity||'')+'"></label><label class="f">Benefits (English)<textarea id="peb">'+esc(p.ben||'')+'</textarea></label><label class="f">लाभ (Hindi)<textarea id="pebh">'+esc(p.benHi||'')+'</textarea></label><div class="row mt"><label class="f" style="flex:1">Duration (min)<input id="pedu" type="number" value="'+p.dur+'"></label><label class="f" style="flex:1">Base price<input id="pep" type="number" value="'+p.price+'"></label></div><label class="f">Samagri kit<select id="pek">'+KITS.map(k=>'<option value="'+k.id+'"'+(p.kit===k.id?' selected':'')+'>'+k.n+'</option>').join('')+'</select></label><label class="row mt"><input type="checkbox" id="pev" '+(p.hidden?'':'checked')+'> Visible in catalogue</label><button class="btn mt" data-act="apueditok" data-id="'+esc(p.id)+'">Save puja</button></div>')},
 async apueditok(d){await closeAnd(run(()=>api('/admin/pujas/'+d.id,{method:'PATCH',body:{name:val('pen'),hindi:val('peh'),cat:val('pec'),deity:val('ped'),ben:val('peb'),benHi:val('pebh'),dur:val('pedu'),price:val('pep'),kit:val('pek'),hidden:!$('#pev').checked}}),'Puja saved'))},
 acopy(d){try{navigator.clipboard.writeText(d.id||'');toast('Copied: '+(d.id||''))}catch(e){toast(d.id||'')}},
 acrstatus(d,el){run(()=>api('/admin/custom-requests/'+d.id,{method:'PATCH',body:{status:el.value}}),'Request updated')},  aexport(d){const rf=PAGE.rf||{};const qs=[];if(rf.status)qs.push('status='+encodeURIComponent(rf.status));if(rf.from)qs.push('from='+rf.from);if(rf.to)qs.push('to='+rf.to);window.open('/api/admin/export/'+d.id+'.xlsx'+(qs.length?'?'+qs.join('&'):''),'_blank');toast('Export started — check downloads');setTimeout(()=>{api('/admin/export-logs').then(x=>{PAGE.expLogs=x.logs;render(true)}).catch(()=>{})},1200)},
 arfc(){PAGE.rf={status:'',from:'',to:''};render(true)},
 async akprice(){try{await api('/admin/kundali/pricing',{method:'PUT',body:{familyPrice:+val('kpf'),additionalPrice:+val('kpa'),gstPct:+val('kpg'),discountPct:+val('kpd'),couponEligible:val('kpce')==='1',active:val('kpac')==='1',freeCounts:{customer:+val('kpfc'),plus:+val('kpfp'),premium:+val('kpfm')}}});PAGE.kprice=null;await sync();toast('Kundali pricing saved')}catch(e){toast(e.message)}},
 async atoggle(d,el){try{const b={};b[d.id]=el.checked;await api('/admin/service-toggles',{method:'PUT',body:b});await sync();toast('Service '+(el.checked?'enabled':'hidden'))}catch(e){toast(e.message);el.checked=!el.checked}},
 acconvert(d){const q=(PAGE.creq||[]).find(x=>x.id===d.id);if(!q)return;
  modal('<h2>Convert request '+esc(q.id)+' into a puja</h2><p class="sm mut mt">From '+esc(q.name)+(q.city?', '+esc(q.city):'')+' — '+esc(q.purpose||'custom request')+'</p><div class="frm mt"><label class="f">Puja name<input id="cvn" value="'+esc(q.deity?q.deity+' Puja':'Custom Puja')+'"></label><label class="f">Hindi name<input id="cvh" value="'+esc(q.deity||'विशेष पूजा')+'"></label><div class="row mt"><label class="f" style="flex:1">Duration (min)<input id="cvd" type="number" value="90"></label><label class="f" style="flex:1">Price<input id="cvp" type="number" value="'+(q.budget||2500)+'"></label></div></div><button class="btn mt" data-act="acconvertok" data-id="'+esc(q.id)+'">Create puja</button>')},
 async acconvertok(d){await closeAnd(run(()=>api('/admin/custom-requests/'+d.id+'/convert',{body:{name:val('cvn'),hindi:val('cvh'),dur:val('cvd'),price:val('cvp')}}),'Request converted into a puja'));PAGE.creq=null;},
 acm(){run(()=>api('/admin/settings',{body:{commission:val('cm')}}),'Commission updated')},
 acc(){run(()=>api('/admin/coupons',{body:{code:val('ncc'),type:val('nct'),val:val('ncv'),max:val('ncm')}}),'Coupon created')},
 acpn(d,el){run(()=>api('/admin/coupons/'+d.id,{method:'PATCH',body:{active:el.checked}}))},
 apay(d){run(()=>api('/admin/payouts/'+d.id+'/pay',{body:{}}),'Marked paid')},
 abn(d,el){run(()=>api('/admin/banners/'+d.id,{method:'PATCH',body:{enabled:el.checked}}))},
 acam(){run(()=>api('/admin/campaigns',{body:{name:val('cn2'),channel:val('cc2'),audience:val('ca2')}}),'Campaign scheduled')},
 async apush(){const r=await run(()=>api('/admin/push',{body:{message:val('pnm')}}));if(r&&r.sent!==undefined)toast('Sent to '+r.sent+' customers')},
 ares(d){run(()=>api('/admin/inventory/'+d.id+'/restock',{body:{qty:20}}),'Restocked')},
 akit(d){run(()=>api('/admin/kits/'+d.id,{method:'PATCH',body:{price:val('kp_'+d.id)}}),'Kit price saved')},
 akst(d){run(()=>api('/admin/kits/'+d.id,{method:'PATCH',body:{stock:val('ks_'+d.id)}}),'Kit stock updated')},
 akact(d,el){run(()=>api('/admin/kits/'+d.id,{method:'PATCH',body:{active:el.checked}}))},
 ank(){run(()=>api('/admin/kits',{body:{name:val('nkn'),price:val('nkp'),stock:val('nks'),items:val('nki').split('\n').map(x=>x.trim()).filter(Boolean)}}),'Kit added')},
 aprs(d){run(()=>api('/admin/prasad/'+d.id,{method:'PATCH',body:{price:val('ppr_'+d.id)}}),'Prasad price saved')},
 aprst(d){run(()=>api('/admin/prasad/'+d.id,{method:'PATCH',body:{stock:val('psr_'+d.id)===''?null:val('psr_'+d.id)}}),'Prasad stock updated')},
 apract(d,el){run(()=>api('/admin/prasad/'+d.id,{method:'PATCH',body:{active:el.checked}}))},
 anpr(){run(()=>api('/admin/prasad',{body:{name:val('npn2'),price:val('npp2'),descr:val('npd2'),stock:val('nps2')}}),'Prasad added')},
 akdel(d){modal('<h2>Delete kit?</h2><p class="mt">'+esc(KITS.find(k=>k.id===d.id).n)+'</p><p class="sm mut mt">Only possible if no puja, booking or order references it. Otherwise deactivate it.</p><div class="row mt"><button class="btn bad" data-act="akdelok" data-id="'+d.id+'">Delete</button><button class="btn ghost" data-act="close">Keep</button></div>')},
 async akdelok(d){await closeAnd(run(()=>api('/admin/kits/'+d.id,{method:'DELETE'}),'Kit deleted'))},
 aprdel(d){modal('<h2>Delete prasad item?</h2><p class="mt">'+esc(PRASAD.find(k=>k.id===d.id).n)+'</p><p class="sm mut mt">Only possible if no booking or order references it. Otherwise deactivate it.</p><div class="row mt"><button class="btn bad" data-act="aprdelok" data-id="'+d.id+'">Delete</button><button class="btn ghost" data-act="close">Keep</button></div>')},
 async aprdelok(d){await closeAnd(run(()=>api('/admin/prasad/'+d.id,{method:'DELETE'}),'Prasad item deleted'))},
 adel2(d){run(()=>api('/admin/bookings/'+d.id+'/ops',{body:{sam:'Delivered'}}),'Marked delivered')},
 adsp(d){run(()=>api('/admin/bookings/'+d.id+'/ops',{body:{pra:d.v}}),'Prasad '+d.v.toLowerCase())},
 aord(d){run(()=>api('/admin/orders/'+d.id+'/advance',{body:{}}))},
 atk(d){run(()=>api('/admin/tickets/'+d.id+'/resolve',{body:{}}),'Ticket resolved')},
 ahid(d){run(()=>api('/admin/reviews/'+d.id+'/toggle',{body:{}}))},
/* --- accounts, audit and puja photos (migration 009) --- */
 acctq(el){PAGE.acctQ=el.value;render(true)},
 async acctrole(d){PAGE.acctRole=d.v;if(PAGE.accts&&PAGE.accts[d.v]){render(true);return}try{const x=await api('/admin/accounts/'+d.v);PAGE.accts=PAGE.accts||{};PAGE.accts[d.v]=x.accounts;render(true)}catch(e){toast(e.message)}},
 async aview(d){try{const r=await api('/admin/users/'+d.id);modal('<h2>Account — '+esc(r.user.name)+'</h2><p class="sm mut">'+esc(r.user.role)+' · '+esc(r.user.id)+'</p><div class="frm mt">'+[['Login ID',r.user.email||r.user.mobile||r.user.id],['Status',r.user.status],['Joined',r.user.joined||''],['Last login',r.user.lastLoginAt?new Date(r.user.lastLoginAt).toLocaleString('en-IN')+' ('+esc(r.user.lastLoginMethod||'')+')':'Never'],['Must change password',r.user.forceChange?'Yes':'No']].map(x=>'<div class="ln"><span class="mut">'+x[0]+'</span><b>'+esc(String(x[1]))+'</b></div>').join('')+'</div><p class="sm mut mt">Passwords are stored as bcrypt hashes and cannot be displayed.</p>',true)}catch(e){toast(e.message)}},
 async aresetpw(d){if(!confirm('Reset the password for '+d.n+'? A one-time temporary password will be generated; they must change it at next login.'))return;try{const r=await api('/admin/users/'+d.id+'/reset-password',{body:{}});modal('<h2>Temporary password</h2><p class="mt">Share this one-time password with <b>'+esc(d.n)+'</b> now — it will not be shown again.</p><div class="card flat c mt"><h1 style="letter-spacing:2px">'+esc(r.tempPassword)+'</h1></div><p class="sm mut mt">They will be asked to set a new password at next login. This action is recorded in the audit log.</p><button class="btn blk mt" data-act="close">Done</button>')}catch(e){toast(e.message)}},
 async aforce(d){try{await api('/admin/users/'+d.id+'/force-change',{body:{}});await sync();toast('Password change will be required at next login')}catch(e){toast(e.message)}},
 async astatus(d,el){if(d.v!=='active'&&!confirm((d.v==='suspended'?'Suspend':'Disable')+' this account? They will be logged out and blocked from logging in.'))return;try{await api('/admin/users/'+d.id+'/status',{body:{status:d.v}});PAGE.accts=null;await sync();toast('Account '+(d.v==='active'?'reactivated':d.v+'d'));render(true)}catch(e){toast(e.message)}},
 /* puja photo manager (admin + pandit): tabs, metadata, bulk actions, credits */
 amedia(d){PAGE.amediaPid=d.id;PAGE.amtab=PAGE.amtab||'all';openMediaModal(d.id)},
 amtab(d){PAGE.amtab=d.v;amRefresh()},
 amsel(d,el){const sel=PAGE.amsel=PAGE.amsel||{};sel[d.id]=el.checked},
 ambulk(d){const ids=Object.entries(PAGE.amsel||{}).filter(([,v])=>v).map(([k])=>k);if(!ids.length)return toast('Select photos first');
  if(d.v==='delete'&&!confirm('Delete '+ids.length+' photo(s)? Files are removed from the server.'))return;
  api('/admin/media/bulk',{method:'POST',body:{ids,op:d.v}}).then(r=>{toast(r.changed+' of '+ids.length+' updated');PAGE.amsel={};amRefresh()}).catch(e=>toast(e.message))},
 amcredits(){api('/admin/media/credits').then(r=>{modal('<h2>Photo credits & attribution</h2><div class="note mb">Every image\'s provenance and license, read from the puja_media records (PHOTO-MEDIA-SPEC.md). Attribution is required for CC-licensed works.</div>'+(r.credits.length?TB(['Preview','Puja','Creator','License / source','State','Source','Uploaded'],r.credits.map(c=>['<img src="'+mediaUrl(c.thumb||c.url)+'" alt="'+esc(c.altText||'photo')+'" style="width:52px;height:40px;object-fit:cover;border-radius:6px">','<b>'+esc(c.pujaName)+'</b><br><span class="sm mut">'+esc((c.altText||'').slice(0,44))+'</span>',esc(c.creator||'—'),esc(c.license||'—')+(c.creditUrl?'<br><a class="sm" target="_blank" rel="noopener" href="'+esc(c.creditUrl)+'">Commons page ↗</a>':''),c.status==='APPROVED'&&c.isPublished?badge('Paid'):c.status==='APPROVED'?'<span class="badge info">Approved</span>':'<span class="badge">'+esc(c.status)+'</span>','<span class="badge '+(c.source==='seeded'?'info':c.source==='pandit'?'warn':'')+'">'+esc(c.source)+'</span>',c.createdAt?new Date(c.createdAt).toLocaleDateString('en-IN'):'—'])):'<div class="card">No photos yet.</div>')+'<p class="sm mut mt">Excel: Reports → “Puja media” carries the same license/creator/credit columns.</p>',true)}).catch(e=>toast(e.message))},
 amupload(){const inp=$('#amf');if(!inp||!inp.files||!inp.files.length)return toast('Choose photos first');const fd=new FormData();[...inp.files].forEach(f=>fd.append('media',f));if($('#amalt'))fd.append('altText',$('#amalt').value);if($('#amcat'))fd.append('category',$('#amcat').value);const b=document.querySelector('[data-act=amupload]');if(b){b.disabled=true;b.textContent='Uploading…'}api('/admin/pujas/'+PAGE.amediaPid+'/media',{method:'POST',form:fd}).then(()=>{PAGE.amtab='all';amRefresh();toast('Uploaded and published')}).catch(e=>toast(e.message)).finally(()=>{const b2=document.querySelector('[data-act=amupload]');if(b2){b2.disabled=false;b2.textContent='Upload photos'}})},
 ammod(d){const patch=d.v==='primary'?{primary:1}:d.v==='publish'?{published:1}:d.v==='unpublish'?{published:0}:d.v==='approve'?{status:'APPROVED'}:d.v==='reject'?{status:'REJECTED',rejectReason:prompt('Rejection reason shown to the pandit:','Does not meet the photo guidelines')||undefined}:{status:d.v};api('/admin/media/'+d.id,{method:'PATCH',body:patch}).then(()=>{toast('Photo updated');amRefresh()}).catch(e=>toast(e.message))},
 amdel(d){if(!confirm('Delete this photo? The file is removed from the server.'))return;api('/admin/media/'+d.id,{method:'DELETE'}).then(()=>{toast('Photo deleted');amRefresh()}).catch(e=>toast(e.message))},
 pmdel(d){if(!confirm('Delete this pending upload?'))return;api('/pandit/media/'+d.id,{method:'DELETE'}).then(()=>{toast('Upload deleted');PAGE.pmedia=null;render(true)}).catch(e=>toast(e.message))},
 async pmupload(){const inp=$('#pmf'),sel=$('#pmb');if(!inp||!inp.files||!inp.files.length)return toast('Choose photos first');if(!sel||!sel.value)return toast('Select the booking first');if(!$('#pmalt')||!$('#pmalt').value.trim())return toast('Describe the photo (alt text is required)');const fd=new FormData();[...inp.files].forEach(f=>fd.append('media',f));fd.append('bookingId',sel.value);fd.append('altText',$('#pmalt').value.trim());
  try{const r=await api('/pandit/media',{method:'POST',form:fd});PAGE.pmedia=r.media.concat(PAGE.pmedia||[]);toast('Uploaded — awaiting admin review');render(true)}catch(e){toast(e.message)}},
 cpwok(){doChangePw()},
 chpw(){if(!session)return loginModal();changePwModal(false)},
 /* customer gallery: category tabs + load more */
 galcat(d){const g=PAGE.gal;if(!g)return;g.cat=d.v;g.offset=0;const q=g.cat==='all'?'?limit=8&page=1':'?limit=8&page=1&category='+g.cat;
  api('/pujas/'+g.pujaId+'/photos'+q).then(x=>{g.items=x.photos;g.total=x.total;g.offset=x.photos.length;const grid=$('#galgrid');if(grid)grid.innerHTML=galCards(x.photos);toast('Showing '+x.total+' photo(s)')}).catch(e=>toast(e.message))},
 galmore(){const g=PAGE.gal;if(!g)return;const q='?limit=8&offset='+g.offset+(g.cat!=='all'?'&category='+g.cat:'');
  api('/pujas/'+g.pujaId+'/photos'+q).then(x=>{g.items=g.items.concat(x.photos);g.offset+=x.photos.length;const grid=$('#galgrid');if(grid)grid.innerHTML=galCards(g.items);const btn=$('[data-act=galmore]');if(x.nextOffset==null&&btn)btn.parentElement.remove()}).catch(e=>toast(e.message))},
 /* lightbox: full-screen viewer; loads the ORIGINAL only when opened */
 galopen(d){const g=PAGE.gal;if(!g||!g.items.length)return;openLightbox(+d.i||0)},
 glnav(d){moveLightbox(d.v==='next'?1:-1)},
 glclose(){closeLightbox()},
};
const INP={
 pf(el){PAGE.f[el.dataset.k]=el.value;$('#pl').innerHTML=pujaResults()},
 kplaceIn(el){kPlacePick(el)},
 pdf(el){PAGE.pf[el.dataset.k]=el.value;$('#pdl').innerHTML=panditList()},
 wz(el){const k=el.dataset.k,v=el.value;if(k.startsWith('addr.'))W.addr[k.slice(5)]=v;else W[k]=v;
  if(k==='asel'){const u=me(),a=u&&u.addr.find(x=>x.id===v);W.addr=a?Object.assign({},a):{line:'',city:W.addr.city,pin:''}}
  if(k==='date'&&W.panditId&&!free(PD(W.panditId),W.date,W.slot)){W.panditId='';W.pSel=false;toast('Your chosen pandit is not free on that date. Choose again.')}
  if(el.dataset.re)render(true)},
 horo(el){const o=$('#hout');if(el.value==='')return;const i=+el.value,dy=Math.floor((new Date()-new Date(new Date().getFullYear(),0,0))/864e5);o.innerHTML='<b>'+RASHI[i]+'</b><p class="mt">'+HORO[(i+dy)%HORO.length]+'</p>'},
 abf(el){PAGE.abf=el.value;render(true)},
 amfile(){ACT.amupload()},
 pmfile(){ACT.pmupload()},
 rfst(el){PAGE.rf=PAGE.rf||{};PAGE.rf.status=el.value},
 rff(el){PAGE.rf=PAGE.rf||{};PAGE.rf.from=el.value},
 rft(el){PAGE.rf=PAGE.rf||{};PAGE.rf.to=el.value},
 aas(el){run(()=>api('/admin/bookings/'+el.dataset.id+'/assign',{body:{panditId:el.value}}),'Assignment updated')},
 ast(el){run(()=>api('/admin/bookings/'+el.dataset.id+'/status',{body:{status:el.value}}),'Status updated')},

};
/* media manager helpers (admin photo gallery modal): tabs, metadata, bulk */
const AMTABS=[['all','All'],['PENDING_ADMIN_REVIEW','🟡 Pending'],['APPROVED','🟢 Approved'],['REJECTED','🔴 Rejected'],['seeded','Seeded'],['pandit','Pandit uploads']];
/* lightbox (customer gallery): lazy originals, keyboard + swipe nav, credits */
let glPrevOverflow='';
function openLightbox(i){const g=PAGE.gal;if(!g||!g.items[i])return;g.idx=i;glPrevOverflow=document.body.style.overflow;document.body.style.overflow='hidden';drawLightbox();document.addEventListener('keydown',glKeys);attachSwipe()}
function closeLightbox(){const el=$('#lightbox');if(el)el.remove();document.body.style.overflow=glPrevOverflow;document.removeEventListener('keydown',glKeys);PAGE.galSwipeOff&&PAGE.galSwipeOff();PAGE.galSwipeOff=null}
function glKeys(e){if(e.key==='Escape')closeLightbox();if(e.key==='ArrowRight')moveLightbox(1);if(e.key==='ArrowLeft')moveLightbox(-1)}
function moveLightbox(dir){const g=PAGE.gal;if(!g)return;g.idx=(g.idx+dir+g.items.length)%g.items.length;drawLightbox()}
function drawLightbox(){const g=PAGE.gal,p=g.items[g.idx];if(!p)return;
 let el=$('#lightbox');if(!el){el=document.createElement('div');el.id='lightbox';el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.innerHTML='<button class="glx" data-act="glclose" aria-label="Close">&times;</button><button class="gln prev" data-act="glnav" data-v="prev" aria-label="Previous">&#8249;</button><figure class="glfig"></figure><button class="gln next" data-act="glnav" data-v="next" aria-label="Next">&#8250;</button><div class="glbar"></div>';document.body.appendChild(el);
  el.addEventListener('click',e=>{if(e.target===el)closeLightbox()});}
 el.querySelector('.glfig').innerHTML='<picture>'+(p.webp?'<source type="image/webp" srcset="'+mediaUrl(p.webp)+'">':'')+'<img src="'+mediaUrl(p.url)+'" alt="'+esc(p.altText||'Puja photo')+'" decoding="async"></picture>';
 const cat=(g.cat&&g.cat!=='all')?g.cat.charAt(0).toUpperCase()+g.cat.slice(1):'Gallery';
 el.querySelector('.glbar').innerHTML='<div class="c"><b>'+(g.idx+1)+' / '+g.items.length+'</b> · '+esc(cat)+(p.isPrimary?' · <span class="badge ok">Primary</span>':'')+'</div>'+
  '<div class="c sm mt">'+(p.credit?'© '+esc(p.credit):(p.creator?'© '+esc(p.creator):''))+(p.license?' · '+esc(p.license):'')+(p.creditUrl?' · <a target="_blank" rel="noopener" href="'+esc(p.creditUrl)+'">Source ↗</a>':'')+'</div>'+
  '<div class="c sm mut">'+esc(p.altText||'')+'</div>';
 const nav=()=>{if(el&&el.parentNode){}}; // noop; nav buttons close over nothing new
}
function attachSwipe(){const el=$('#lightbox');if(!el||PAGE.galSwipeOff)return;let x0=null;const st=e=>{x0=e.touches?e.touches[0].clientX:e.clientX};const en=e=>{if(x0==null)return;const x=e.changedTouches?e.changedTouches[0].clientX:e.clientX;const dx=x-x0;if(Math.abs(dx)>50)moveLightbox(dx<0?1:-1);x0=null};
 el.addEventListener('touchstart',st,{passive:true});el.addEventListener('touchend',en,{passive:true});el.addEventListener('mousedown',st);el.addEventListener('mouseup',en);PAGE.galSwipeOff=()=>{el.removeEventListener('touchstart',st);el.removeEventListener('touchend',en);el.removeEventListener('mousedown',st);el.removeEventListener('mouseup',en)}}
const AMST={PENDING_ADMIN_REVIEW:['🟡 PENDING',''],APPROVED:['🟢 APPROVED','ok'],REJECTED:['🔴 REJECTED','bad']};
const amCard=m=>'<div class="card flat" style="width:170px;padding:8px"><label class="row" style="gap:6px;align-items:flex-start"><input type="checkbox" data-act="amsel" data-id="'+m.id+'" '+(PAGE.amsel&&PAGE.amsel[m.id]?'checked':'')+'> <img src="'+mediaUrl(m.thumbWebp||m.thumb||m.url)+'" alt="'+esc(m.altText||m.origName||'Puja photo')+'" loading="lazy" style="width:100%;height:100px;object-fit:cover;border-radius:8px;background:#eee"></label><div class="sm mt">'+(m.isPrimary?'<span class="badge ok">Primary</span> ':'')+'<span class="badge '+(AMST[m.status]||AMST.PENDING_ADMIN_REVIEW)[1]+'">'+(AMST[m.status]||AMST.PENDING_ADMIN_REVIEW)[0]+'</span>'+(m.status==='APPROVED'?(m.isPublished?' <span class="badge info">Published</span>':' <span class="badge">Unpublished</span>'):'')+' <span class="badge '+(m.source==='seeded'?'info':m.source==='pandit'?'warn':'')+'">'+esc(m.source||'admin')+'</span></div><div class="sm">'+esc(m.altText||m.origName||'').slice(0,40)+'</div>'+(m.source==='pandit'?'<div class="sm mut">Pandit upload'+(m.panditName?' · '+esc(m.panditName):'')+'</div>':'')+(m.status==='REJECTED'&&m.rejectReason?'<div class="sm" style="color:var(--bad)">Reason: '+esc(m.rejectReason)+'</div>':'')+(m.creator?'<div class="sm mut">© '+esc(m.creator).slice(0,28)+(m.license?' · '+esc(m.license):'')+'</div>':'')+'<div class="row mt" style="gap:4px;flex-wrap:wrap">'+(m.status!=='APPROVED'?'<button class="btn s" data-act="ammod" data-id="'+m.id+'" data-v="approve">Approve</button><button class="btn s bad" data-act="ammod" data-id="'+m.id+'" data-v="reject">Reject</button>':'<button class="btn s ghost" data-act="ammod" data-id="'+m.id+'" data-v="'+(m.isPublished?'unpublish':'publish')+'">'+(m.isPublished?'Unpublish':'Publish')+'</button><button class="btn s ghost" data-act="ammod" data-id="'+m.id+'" data-v="primary">Primary</button>')+'<a class="btn s ghost" href="'+mediaUrl('/api/media/'+m.id+'/download')+'" download>Get</a><button class="btn s bad" data-act="amdel" data-id="'+m.id+'">Del</button></div>'+(m.creditUrl?'<a class="sm mut" target="_blank" rel="noopener" href="'+esc(m.creditUrl)+'">Source ↗</a>':'')+'</div>';
function openMediaModal(pujaId){PAGE.amsel={};api('/admin/pujas/'+pujaId+'/media').then(r=>{PAGE.amData=r.media||[];PAGE.amediaPid=pujaId;drawMediaModal()}).catch(e=>toast(e.message))}
function drawMediaModal(){const all=PAGE.amData||[],t=PAGE.amtab||'all';const list=t==='all'?all:all.filter(m=>t==='seeded'||t==='pandit'?m.source===t:m.status===t);
 modal('<h2>Puja Photos — '+esc((PU(PAGE.amediaPid)||{}).n||PAGE.amediaPid)+'</h2><div class="tabs mt">'+AMTABS.map(x=>'<button class="'+(t===x[0]?'on':'')+'" data-act="amtab" data-v="'+x[0]+'">'+x[1]+' ('+(x[0]==='all'?all.length:all.filter(m=>x[0]==='seeded'||x[0]==='pandit'?m.source===x[0]:m.status===x[0]).length)+')</button>').join('')+'<button class="" data-act="amcredits">Credits</button></div>'+
 '<div class="row mt" style="gap:8px;flex-wrap:wrap;align-items:end"><label class="btn s" style="cursor:pointer">Upload photos<input type="file" id="amf" multiple accept="image/jpeg,image/png,image/webp" style="display:none" data-in="amfile"></label><label class="f">Alt text<input id="amalt" placeholder="Describe the image" style="max-width:200px"></label><label class="f">Gallery<select id="amcat"><option value="puja">Puja</option><option value="ritual">Ritual</option><option value="temple">Temple</option><option value="seva">Previous seva</option></select></label><span class="sm mut">Bulk:</span><button class="btn s ghost" data-act="ambulk" data-v="approve">Approve</button><button class="btn s ghost" data-act="ambulk" data-v="publish">Publish</button><button class="btn s ghost" data-act="ambulk" data-v="unpublish">Unpublish</button><button class="btn s bad" data-act="ambulk" data-v="delete">Delete</button></div>'+
 '<div id="amgrid" class="row mt" style="flex-wrap:wrap">'+(list.length?list.map(amCard).join(''):'<div class="card">No photos in this view.</div>')+'</div><p class="sm mut mt">Metadata rules: PHOTO-MEDIA-SPEC.md — pandit uploads stay pending until you approve AND publish; seeded photos carry license + creator + source page.</p>',true)}
function amRefresh(){if(!PAGE.amediaPid)return;if($('#amgrid')){api('/admin/pujas/'+PAGE.amediaPid+'/media').then(r=>{PAGE.amData=r.media||[];if($('#amgrid'))drawMediaModal()}).catch(()=>{})}}
/* pandit photo card + actions */
const pmCard=m=>'<div class="card flat" style="width:170px;padding:8px"><picture>'+(m.thumbWebp?'<source type="image/webp" srcset="'+mediaUrl(m.thumbWebp)+'">':'')+'<img src="'+mediaUrl(m.thumb||m.url)+'" alt="'+esc(m.altText||m.origName||'photo')+'" loading="lazy" style="width:100%;height:110px;object-fit:cover;border-radius:8px;background:#eee"></picture><div class="sm mt">'+(m.status==='PENDING_ADMIN_REVIEW'?'<span class="badge">🟡 Pending review</span>':m.status==='APPROVED'?(m.isPublished?'<span class="badge ok">🟢 Live on site</span>':'<span class="badge info">🟢 Approved</span>'):'<span class="badge bad">🔴 Rejected</span>')+'</div><div class="sm mut">'+esc(m.altText||m.origName||'').slice(0,44)+'</div>'+(m.status==='REJECTED'&&m.rejectReason?'<div class="sm" style="color:var(--bad)">Admin: '+esc(m.rejectReason)+'</div>':'')+'<div class="sm mut">'+(m.createdAt?new Date(m.createdAt).toLocaleDateString('en-IN'):'')+'</div>'+(m.status==='PENDING_ADMIN_REVIEW'?'<button class="btn s bad mt" data-act="pmdel" data-id="'+m.id+'">Delete</button>':'')+'</div>';
document.addEventListener('click',e=>{const el=e.target.closest('[data-act]');if(!el)return;const f=ACT[el.dataset.act];if(f)f(el.dataset,el,e);if(el.dataset.act==='close')closeModal()});
document.addEventListener('click',e=>{if(e.target.id==='modal')closeModal();if(e.target.closest('.links a'))$('#links').classList.remove('open')});
document.addEventListener('input',e=>{const el=e.target;if(!el.dataset||!el.dataset.in||el.dataset.re)return;if(el.tagName==='SELECT'||el.type==='date')return;const f=INP[el.dataset.in];if(f)f(el)});
document.addEventListener('change',e=>{const el=e.target;if(!el.dataset||!el.dataset.in)return;const f=INP[el.dataset.in];if(f)f(el)});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();if(e.key==='Enter'||e.key===' '){const el=e.target.closest&&e.target.closest('.opt[data-act]');if(el){e.preventDefault();el.click()}}if(e.key==='Enter'){if(e.target.id==='aq')ACT.ask();if(e.target.id==='hq')ACT.hsearch()}});
window.addEventListener('hashchange',()=>{const p=pageOf();if(['account','portal','admin','book'].includes(p))sync().then(()=>render()).catch(()=>render());else render()});
const th=store.get('dp_theme',null);if(th)document.documentElement.dataset.theme=th;
(async()=>{try{await sync();if(token&&!session)setToken(null)}catch(e){$('#view').innerHTML='<div class="page"><div class="wrap"><h1>DaivikPooja is unavailable</h1><p class="mut mt">'+esc(e.message)+'</p></div></div>';return}footer();render()})();
