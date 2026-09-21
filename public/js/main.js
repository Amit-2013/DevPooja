/* Router, event handlers and startup. Every mutation goes to the API; the server is the source of truth. */
const ROUTES={'':home,pujas,puja:pujaDetail,book,pandits:panditsPage,pandit:panditProfile,temples,samagri:samagriPage,prasad:prasadPage,festivals:festivalsPage,astrology,corporate,about,contact,account,rewards:rewardsPage,plus:plusPage,partner,'register-pandit':regPandit,portal,admin};
function render(keep){const r=route();if(r.page!=='book')W=null;const fn=ROUTES[r.page]||nf;header();$('#view').innerHTML=fn(r);const h=$('#view h1');document.title=(h?h.textContent.slice(0,60)+' | ':'')+'DeivikPooja';if(!keep)scrollTo(0,0)}
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
 theme(){const el=document.documentElement,cur=el.dataset.theme||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'),nx=cur==='dark'?'light':'dark';el.dataset.theme=nx;store.set('dp_theme',nx)},
 burger(){$('#links').classList.toggle('open')},
 login(){loginModal()},'pandit-login'(){loginModal('pandit')},logout,close(){closeModal()},
 print(){try{window.print()}catch(e){toast('Printing is not available here')}},
 ltab(d,el){$$('.tabs button',el.closest('.mbox')).forEach(b=>b.classList.toggle('on',b===el));$('#lb').innerHTML=loginForm(d.v)},
 async sendotp(d,el){try{const r=await api('/auth/otp/send',{body:{mobile:val('lm')}});$('#lotp').innerHTML='<label class="f mt">Enter the 6-digit OTP'+(r.devOtp?' (demo OTP: '+r.devOtp+')':' sent by SMS')+'<input id="lo" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>';el.textContent='Verify and continue';el.dataset.act='verifyotp';$('#lo').focus()}catch(e){toast(e.message)}},
 async verifyotp(){try{doLogin(await api('/auth/otp/verify',{body:{mobile:val('lm'),otp:val('lo'),name:val('ln'),as:PAGE.la==='pandit'?'pandit':undefined}}))}catch(e){toast(e.message)}},
 async emlogin(){try{doLogin(await api('/auth/email',{body:{email:val('le'),password:val('lp'),name:val('ln')}}))}catch(e){toast(e.message)}},
 async 'demo-user'(){try{doLogin(await api('/auth/demo',{body:{role:'customer'}}))}catch(e){toast(e.message)}},
 async 'demo-pandit'(){try{await doLogin(await api('/auth/demo',{body:{role:'pandit'}}))}catch(e){toast(e.message)}},
 async alogin(){try{await doLogin(await api('/auth/admin',{body:{email:val('ae'),password:val('ap2')}}))}catch(e){toast(e.message)}},
 hsearch(){location.hash='#/pujas?q='+encodeURIComponent(val('hq'))},
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
 bmed(d){const b=B(d.id),m=b.mediaUrls||[];modal('<h2>Photos and video</h2><div class="grid g3 mt">'+(m.length?m.map(u=>isImg(u)?'<a href="'+esc(u)+'" target="_blank" rel="noopener"><img src="'+esc(u)+'" alt="Puja photo" style="width:100%;border-radius:8px;aspect-ratio:4/3;object-fit:cover"></a>':'<video controls src="'+esc(u)+'" style="width:100%;border-radius:8px"></video>').join(''):'<div class="ph">🪔</div>')+'</div>'+(m.length?'':'<p class="sm mut mt">The pandit has not uploaded media for this puja.</p>'))},
 bcert(d){const b=B(d.id),pd=PD(b.panditId);modal('<div class="cert"><h2>Puja Completion Certificate</h2><p class="mt">This confirms that</p><h3 style="font-size:1.5rem">'+esc(PU(b.pujaId).n)+'</h3><p>was performed for <b>'+esc(b.member&&b.member!=='Self'?b.member:me().n)+'</b> on '+fmtD(b.date)+'<br>by <b>'+esc(pd?pd.n:'DeivikPooja pandit')+'</b> ('+MODES[b.mode].n+')</p><p class="sm mut mt">Booking '+b.id+'. Digital confirmation by DeivikPooja.</p></div><button class="btn s mt noprint" data-act="print">Print</button>')},
 brev(d){PAGE.rv={id:d.id,r:5};modal('<h2>Rate your puja</h2><div class="row mt" id="rst">'+[1,2,3,4,5].map(n=>'<button class="chip on" data-act="rstar" data-v="'+n+'" aria-label="'+n+' stars">'+n+' ★</button>').join('')+'</div><label class="f mt">Your review<textarea id="rvt" maxlength="500"></textarea></label><button class="btn mt" data-act="brevok">Submit review</button>')},
 rstar(d){PAGE.rv.r=+d.v;$$('#rst .chip').forEach((c,i)=>c.classList.toggle('on',i<+d.v))},
 async brevok(){await closeAnd(run(()=>api('/bookings/'+PAGE.rv.id+'/review',{body:{r:PAGE.rv.r,t:val('rvt')}}),'Thank you. You earned 10 points.'))},
 psave(){run(()=>api('/me',{method:'PATCH',body:{name:val('pn'),email:val('pe'),pref:{deity:val('pdv'),lang:val('pl2'),wa:$('#pwa').checked,sms:$('#psm').checked,em:$('#pem').checked}}}),'Profile saved')},
 aadd(){run(()=>api('/me/addresses',{body:{l:val('al'),line:val('ai'),city:val('ac'),pin:val('ap')}}),'Address saved')},
 adel(d){run(()=>api('/me/addresses/'+d.id,{method:'DELETE'}))},
 fadd(){run(()=>api('/me/family',{body:{n:val('fn'),rel:val('fr'),gotra:val('fg')}}),'Member saved')},
 fdel(d){run(()=>api('/me/family/'+d.id,{method:'DELETE'}))},
 tadd(){run(()=>api('/tickets',{body:{b:val('tb'),t:val('tt')}}),'Ticket raised')},
 plus(d){if(!me()){afterLogin=()=>render(true);loginModal();return}run(()=>api('/me/plus',{body:{on:true}}),'Welcome to DeivikPooja Plus')},
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
 acm(){run(()=>api('/admin/settings',{body:{commission:val('cm')}}),'Commission updated')},
 acc(){run(()=>api('/admin/coupons',{body:{code:val('ncc'),type:val('nct'),val:val('ncv'),max:val('ncm')}}),'Coupon created')},
 acpn(d,el){run(()=>api('/admin/coupons/'+d.id,{method:'PATCH',body:{active:el.checked}}))},
 apay(d){run(()=>api('/admin/payouts/'+d.id+'/pay',{body:{}}),'Marked paid')},
 abn(d,el){run(()=>api('/admin/banners/'+d.id,{method:'PATCH',body:{enabled:el.checked}}))},
 acam(){run(()=>api('/admin/campaigns',{body:{name:val('cn2'),channel:val('cc2'),audience:val('ca2')}}),'Campaign scheduled')},
 async apush(){const r=await run(()=>api('/admin/push',{body:{message:val('pnm')}}));if(r&&r.sent!==undefined)toast('Sent to '+r.sent+' customers')},
 ares(d){run(()=>api('/admin/inventory/'+d.id+'/restock',{body:{qty:20}}),'Restocked')},
 adel2(d){run(()=>api('/admin/bookings/'+d.id+'/ops',{body:{sam:'Delivered'}}),'Marked delivered')},
 adsp(d){run(()=>api('/admin/bookings/'+d.id+'/ops',{body:{pra:d.v}}),'Prasad '+d.v.toLowerCase())},
 aord(d){run(()=>api('/admin/orders/'+d.id+'/advance',{body:{}}))},
 atk(d){run(()=>api('/admin/tickets/'+d.id+'/resolve',{body:{}}),'Ticket resolved')},
 ahid(d){run(()=>api('/admin/reviews/'+d.id+'/toggle',{body:{}}))}
};
const INP={
 pf(el){PAGE.f[el.dataset.k]=el.value;$('#pl').innerHTML=pujaResults()},
 pdf(el){PAGE.pf[el.dataset.k]=el.value;$('#pdl').innerHTML=panditList()},
 wz(el){const k=el.dataset.k,v=el.value;if(k.startsWith('addr.'))W.addr[k.slice(5)]=v;else W[k]=v;
  if(k==='asel'){const u=me(),a=u&&u.addr.find(x=>x.id===v);W.addr=a?Object.assign({},a):{line:'',city:W.addr.city,pin:''}}
  if(k==='date'&&W.panditId&&!free(PD(W.panditId),W.date,W.slot)){W.panditId='';W.pSel=false;toast('Your chosen pandit is not free on that date. Choose again.')}
  if(el.dataset.re)render(true)},
 horo(el){const o=$('#hout');if(el.value==='')return;const i=+el.value,dy=Math.floor((new Date()-new Date(new Date().getFullYear(),0,0))/864e5);o.innerHTML='<b>'+RASHI[i]+'</b><p class="mt">'+HORO[(i+dy)%HORO.length]+'</p>'},
 abf(el){PAGE.abf=el.value;render(true)},
 aas(el){run(()=>api('/admin/bookings/'+el.dataset.id+'/assign',{body:{panditId:el.value}}),'Assignment updated')},
 ast(el){run(()=>api('/admin/bookings/'+el.dataset.id+'/status',{body:{status:el.value}}),'Status updated')}
};
document.addEventListener('click',e=>{const el=e.target.closest('[data-act]');if(!el)return;const f=ACT[el.dataset.act];if(f)f(el.dataset,el,e);if(el.dataset.act==='close')closeModal()});
document.addEventListener('click',e=>{if(e.target.id==='modal')closeModal();if(e.target.closest('.links a'))$('#links').classList.remove('open')});
document.addEventListener('input',e=>{const el=e.target;if(!el.dataset||!el.dataset.in||el.dataset.re)return;if(el.tagName==='SELECT'||el.type==='date')return;const f=INP[el.dataset.in];if(f)f(el)});
document.addEventListener('change',e=>{const el=e.target;if(!el.dataset||!el.dataset.in)return;const f=INP[el.dataset.in];if(f)f(el)});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();if(e.key==='Enter'||e.key===' '){const el=e.target.closest&&e.target.closest('.opt[data-act]');if(el){e.preventDefault();el.click()}}if(e.key==='Enter'){if(e.target.id==='aq')ACT.ask();if(e.target.id==='hq')ACT.hsearch()}});
window.addEventListener('hashchange',()=>{const p=pageOf();if(['account','portal','admin','book'].includes(p))sync().then(()=>render()).catch(()=>render());else render()});
const th=store.get('dp_theme',null);if(th)document.documentElement.dataset.theme=th;
(async()=>{try{await sync();if(token&&!session)setToken(null)}catch(e){$('#view').innerHTML='<div class="page"><div class="wrap"><h1>DeivikPooja is unavailable</h1><p class="mut mt">'+esc(e.message)+'</p></div></div>';return}footer();render()})();
