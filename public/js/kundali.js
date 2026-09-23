/* Kundali -> Dosh -> Recommendation flow (customer side). Talks to /api/kundali/*.
   K (state) persists in PAGE.k so the result survives re-renders; the form lives at #/kundali. */

const PURPOSES = ['General', 'Marriage', 'Career', 'Business', 'Health & Wellness', 'Finance', 'Education', 'Family', 'Child', 'Spiritual', 'Property', 'Other'];
const DOSH_ICON = { high: '⚠', medium: '⚠', low: 'ℹ', none: '✓' };
const DOSH_LABEL = { high: 'Strong indication', medium: 'Moderate indication', low: 'Mild indication', none: 'Not detected' };

function kundaliForm(){const k=PAGE.kf||(PAGE.kf={place:'',placeId:0,placeLabel:'',accuracy:'exact',purpose:'General'});
 return'<div class="page"><div class="wrap" style="max-width:760px"><h1>Generate your Kundali</h1><p class="mut mb">Enter the birth details. We compute the chart with an astronomy-grade ephemeris, analyse it for traditional conditions, and suggest sevas — you never have to pick a puja first.</p>'+
 '<div class="card"><h3>Personal details</h3><div class="frm mt"><label class="f">Full name<input id="kn" autocomplete="name"></label>'+
 '<label class="f">Gender<select id="kg"><option value="">Prefer not to say</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select></label>'+
 '<div class="row mt"><label class="f" style="flex:1">Date of birth<input id="kd" type="date" max="'+iso(new Date())+'"></label><label class="f" style="flex:1">Time of birth (24h)<input id="kt" type="time"></label></div>'+
 '<label class="f mt">Birth time accuracy<select id="ka">'+[['exact','Exact — as recorded'],['approximate','Approximate — within a few hours'],['unknown','Unknown']].map(a=>'<option value="'+a[0]+'"'+(k.accuracy===a[0]?' selected':'')+'>'+a[1]+'</option>').join('')+'</select></label>'+
 '<label class="f mt">Place of birth<input id="kp" data-in="kplaceIn" placeholder="Start typing a city…" autocomplete="off" value="'+esc(k.placeLabel)+'"></label><div id="kpl" class="mut sm"></div>'+
 '<label class="f mt">Purpose (optional)<select id="ku">'+PURPOSES.map(p=>'<option'+(k.purpose===p?' selected':'')+'>'+p+'</option>').join('')+'</select></label>'+
 '<div class="row mt"><label class="f" style="flex:1">Mobile (optional)<input id="km" inputmode="numeric" maxlength="10" placeholder="10 digits"></label><label class="f" style="flex:1">Email (optional)<input id="ke" type="email"></label></div>'+
 '<label class="f mt">Gotra (optional)<input id="kgot" placeholder="For sankalp, if you know it"></label></div>'+
 '<label class="row mt2"><input type="checkbox" id="ksave" checked> Save this profile to my account (used for sankalp and future pujas)</label>'+
 '<p class="sm mut mt">Calculated for the exact place and time you give — not your browser location. Traditional Jyotish interpretation only; no predictions or guarantees.</p>'+
 '<button class="btn blk mt" data-act="kgen">Generate Kundali</button></div>'+
 (PAGE.k?'<div class="card mt"><h3>Your last generated Kundali</h3><p class="sm mut mt">'+esc(PAGE.k.chart.meta.name)+', '+fmtD(PAGE.k.chart.meta.dob)+' — '+esc(PAGE.k.chart.lagna.signName)+' lagna, '+esc(PAGE.k.chart.rashi.signName)+' rashi.</p><a class="btn s mt" href="#/kundali/result">Open result</a></div>':'')+
 '</div></div>'}

function kPlacePick(el){const q=el.value.trim();PAGE.kf.placeLabel=el.value;
 if(q.length<2){$('#kpl').innerHTML='';return}
 clearTimeout(PAGE.kf._t);PAGE.kf._t=setTimeout(async()=>{
  try{const r=await api('/kundali/places?q='+encodeURIComponent(q));
   $('#kpl').innerHTML=r.places.length?'<div class="col mt">'+r.places.map(p=>'<button class="chip" data-act="kplace" data-id="'+p.id+'" data-label="'+esc(p.label)+'" data-json=\''+esc(JSON.stringify(p))+'\'>'+esc(p.label)+'</button>').join('')+'</div>':'<span class="mut">No matching city. Try another spelling.</span>'}catch(e){$('#kpl').textContent=''}} ,250)}

function kLoading(name){return'<div class="page"><div class="wrap c" style="max-width:520px"><div class="kload">'+diya()+'</div><h1 class="mt">Preparing your Kundali…</h1><p class="mut mt">Computing sidereal planetary positions for '+esc(name||'your birth details')+', building the houses and running the analysis. This takes a moment.</p></div></div>'}

function doshCard(d,cond){const sev=d.severity==='none'?'none':d.severity;
 return'<article class="card dosh dosh-'+sev+'"><div class="row sp"><h3 style="margin:0">'+DOSH_ICON[sev]+' '+esc(d.name||d.code)+'</h3><span class="badge '+(sev==='high'?'bad':sev==='medium'?'warn':sev==='low'?'info':'ok')+'">'+DOSH_LABEL[sev]+'</span></div>'+
 (d.detected?'<p class="sm mut mt">What it means: '+esc(d.explanation||(cond?cond.descr:''))+'</p>':'<p class="sm mut mt">'+esc(d.explanation||(cond?cond.descr:''))+'</p>')+
 (d.detected&&d.evidence&&d.evidence.length?'<details class="mt"><summary class="sm">Why this was identified</summary><ul class="sm mut" style="padding-left:18px;margin:8px 0">'+d.evidence.map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul></details>':'')+
 (d.detected&&d.recommendation?'<p class="sm mt"><b>Suggested spiritual remedy:</b> '+esc(d.recommendation)+'</p>':'')+
 (d.detected&&d.confidence!=null?'<p class="sm mut">Rule confidence: '+Math.round(d.confidence*100)+'%</p>':'')+
 '</article>'}

function recoCard(r){const p=PU(r.pujaId);
 return'<article class="card reco"><div class="row sp"><div><span class="badge '+(r.priority==='primary'?'ok':r.priority==='secondary'?'info':'')+'">'+(r.priority==='primary'?'Primary recommendation':r.priority==='secondary'?'Supplementary practice':'Optional spiritual practice')+'</span><h3 class="mt">'+(p?p.ic:'🪔')+' '+esc(r.name||(p?p.n:'Puja'))+'</h3></div>'+(p?'<b class="b" style="font-size:1.3rem">from '+inr(p.price*.7)+'</b>':'')+'</div>'+
 '<p class="sm mut mt">Why this seva? '+esc(r.reason||'Recommended based on the analysis of your Kundali.')+'</p>'+
 '<p class="sm mut">This is a traditional Jyotish-based recommendation. It is not a prediction or guarantee of any future event.</p>'+
 '<div class="row mt">'+(p?'<a class="btn s" href="#/book/'+p.id+'">Book now</a><a class="btn s sec" href="#/puja/'+p.id+'">View puja</a>':'')+'</div></article>'}

function kundaliResult(){const k=PAGE.k;if(!k)return'<div class="page"><div class="wrap"><h1>Kundali</h1><div class="card mt">No Kundali generated yet. <a href="#/kundali" style="text-decoration:underline">Generate one first</a>.</div></div></div>';
 const c=k.chart,byCode={};(k.catalogConditions||[]).forEach(x=>byCode[x.code]=x);
 const detected=k.analysis.doshas.filter(d=>d.detected),notDetected=k.analysis.doshas.filter(d=>!d.detected);
 const PLANETS=['sun','moon','mars','mercury','jupiter','venus','saturn','rahu','ketu'];
 const planetRows=PLANETS.map(p=>{const q=c.planets[p];return'<tr><td>'+p.charAt(0).toUpperCase()+p.slice(1)+'</td><td>'+esc(q.signName)+'</td><td>'+q.house+'</td><td>'+q.degreeInSign.toFixed(1)+'°</td><td>'+esc(q.nakshatra.name)+'-'+q.nakshatra.pada+'</td><td>'+esc(q.dignity)+'</td></tr>'}).join('');
 const primary=k.recommendations.filter(r=>r.priority==='primary'),others=k.recommendations.filter(r=>r.priority!=='primary');
 return'<div class="page"><div class="wrap"><div class="khead"><div class="wrap"><h1 style="color:#fff">Your Kundali</h1><p class="mt" style="color:#fff;opacity:.92;font-size:1.1rem">'+esc(c.meta.name)+' — '+fmtD(c.meta.dob)+(c.meta.tob&&c.meta.tob!=='Unknown'?', '+c.meta.tob:'')+'<br>'+esc(c.meta.place)+'</p></div></div>'+
 '<div class="grid g3 mt2"><div class="card c"><div class="sm mut">Lagna (Ascendant)</div><div class="b" style="font-size:1.5rem;font-family:Yatra One">'+esc(c.lagna.signName)+'</div><div class="sm mut">'+esc(c.lagna.lord)+' is the lord</div></div>'+
 '<div class="card c"><div class="sm mut">Rashi (Moon sign)</div><div class="b" style="font-size:1.5rem;font-family:Yatra One">'+esc(c.rashi.signName)+'</div><div class="sm mut">'+esc(c.panchang.nakshatra)+', pada '+c.planets.moon.nakshatra.pada+'</div></div>'+
 '<div class="card c"><div class="sm mut">Panchang at birth</div><div class="b" style="font-size:1.05rem">'+esc(c.panchang.tithi)+'</div><div class="sm mut">'+esc(c.panchang.vara)+'</div></div></div>'+
 '<div class="card mt2"><div class="row sp"><h3 style="margin:0">Kundali analysis</h3><span class="sm mut">engine '+esc(k.analysis.engine)+'</span></div><div class="row mt"><span class="badge ok">✓ Kundali generated</span><span class="badge ok">✓ Planetary analysis</span><span class="badge '+(detected.length?'warn':'ok')+'">'+(detected.length?'⚠ Dosh analysis: '+detected.length+' condition(s) flagged':'✓ Dosh analysis: nothing flagged')+'</span></div></div>'+
 '<h2 class="mt2 mb">Kundali dosh &amp; spiritual analysis</h2><p class="sm mut mb">Traditional Jyotish interpretation associates these combinations with certain life themes. A listed condition is not a prediction or a guarantee of any event.</p>'+
 (detected.length?detected.map(d=>doshCard(d,byCode[d.code])).join(''):'<div class="card dosh dosh-none"><div class="row sp"><h3 style="margin:0">✓ No traditional dosh conditions flagged</h3></div><p class="sm mut mt">The rules did not identify any of the analysed combinations in this chart. Every chart is unique — a pandit can still suggest a suitable seva for your sankalp.</p></div>')+
 (notDetected.length?'<details class="card flat mt"><summary class="sm">Conditions checked and not detected ('+notDetected.length+')</summary>'+notDetected.map(d=>doshCard(d,byCode[d.code])).join('')+'</details>':'')+
 (k.recommendations.length?'<h2 class="mt2 mb">Your recommended seva</h2><div class="grid g2">'+(primary.length?primary.map(recoCard).join(''):'')+'</div>'+(others.length?'<h3 class="mt2">Other spiritual recommendations</h3><div class="grid g2">'+others.map(recoCard).join('')+'</div>':''):'<div class="card mt2"><p class="mut">No specific seva matched this analysis. Browse the <a href="#/pujas" style="text-decoration:underline">puja catalogue</a> for a sankalp of your choice.</p></div>')+
 (k.havans&&k.havans.length?'<h2 class="mt2 mb">Recommended havan kund</h2><div class="grid g3">'+k.havans.map(h=>'<div class="card"><h3 style="margin:0">🔥 '+esc(h.name)+'</h3><p class="sm mut mt">'+esc(h.descr||'')+'</p><div class="row sp mt"><span class="sm mut">'+esc(h.material)+', '+h.size+' inch</span><b>'+inr(h.price)+'</b></div>'+(h.forPujas&&h.forPujas.length?'<a class="btn s ghost mt" href="#/puja/'+h.forPujas[0]+'">Used in '+esc((PU(h.forPujas[0])||{}).n||'puja')+'</a>':'')+'</div>').join('')+'</div>':'')+
 (k.samagri&&k.samagri.length?'<details class="card flat mt"><summary class="sm">Samagri traditionally used ('+k.samagri.length+' items)</summary><ul class="sm mut" style="padding-left:18px;margin:8px 0">'+k.samagri.map(s=>'<li>'+esc(s.name)+' — '+s.qty+' '+esc(s.unit)+'</li>').join('')+'</ul></details>':'')+
 '<h2 class="mt2 mb">Planetary overview</h2><div class="tw"><table><thead><tr><th>Planet</th><th>Sign</th><th>House</th><th>Degree</th><th>Nakshatra</th><th>Status</th></tr></thead><tbody>'+planetRows+'</tbody></table></div>'+
 '<details class="card flat mt"><summary class="sm">Dasha timeline (Vimshottari)</summary><div class="tw mt"><table><thead><tr><th>Lord</th><th>From</th><th>To</th><th>Years</th></tr></thead><tbody>'+c.dashas.periods.map(d=>'<tr'+(d===c.dashas.current?' class="b"':'')+'><td>'+d.lord+(d===c.dashas.current?' (current)':'')+'</td><td>'+fmtD(d.from)+'</td><td>'+fmtD(d.to)+'</td><td>'+d.years+'</td></tr>').join('')+'</tbody></table></div><p class="sm mut mt">Balance of the first dasha at birth: '+c.dashas.balanceAtBirth+' years.</p></details>'+
 '<div class="card mt2"><p class="sm mut">Positions are sidereal (Lahiri ayanamsa '+c.meta.ayanamsa+'°) computed by DaivikPooja\u2019s in-house ephemeris from your birth details. <a href="#/kundali" style="text-decoration:underline">Generate another Kundali</a>.</p></div>'+
 '</div></div>'}
