/* Kundali -> Dosh -> Recommendation flow (customer side). Talks to /api/kundali/*.
   K (state) persists in PAGE.k so the result survives re-renders; the form lives at #/kundali.
   Fully bilingual: lang ('en'|'hi') comes from the header selector; switching re-renders
   the saved result without regenerating the chart. English fields are the fallback when
   an older saved kundali has no Hindi fields. */

const PURPOSES = ['General', 'Marriage', 'Career', 'Business', 'Health & Wellness', 'Finance', 'Education', 'Family', 'Child', 'Spiritual', 'Property', 'Other'];
const PURPOSES_HI = ['सामान्य', 'विवाह', 'करियर', 'व्यापार', 'स्वास्थ्य और कल्याण', 'धन', 'शिक्षा', 'परिवार', 'संतान', 'आध्यात्मिक', 'संपत्ति', 'अन्य'];
const DOSH_ICON = { high: '⚠', medium: '⚠', low: 'ℹ', none: '✓' };
const DOSH_LABEL = { high: ['Strong indication', 'प्रबल संकेत'], medium: ['Moderate indication', 'मध्यम संकेत'], low: ['Mild indication', 'हल्का संकेत'], none: ['Not detected', 'पहचाना नहीं गया'] };
const PLANET_KEY = { sun: ['Sun', 'सूर्य'], moon: ['Moon', 'चंद्र'], mars: ['Mars', 'मंगल'], mercury: ['Mercury', 'बुध'], jupiter: ['Jupiter', 'गुरु'], venus: ['Venus', 'शुक्र'], saturn: ['Saturn', 'शनि'], rahu: ['Rahu', 'राहु'], ketu: ['Ketu', 'केतु'] };
const PRIO_LABEL = { primary: ['Primary recommendation', 'प्रमुख अनुशंसा'], secondary: ['Supplementary practice', 'पूरक अभ्यास'], optional: ['Optional spiritual practice', 'वैकल्पिक आध्यात्मिक अभ्यास'] };

const L = (en, hi) => lang === 'hi' && hi != null ? hi : en;
const pick = (en, hi) => lang === 'hi' && hi ? hi : (en || hi || '');
const fmtCoord = (n, isLat) => Math.abs(n).toFixed(4) + '° ' + (isLat ? (n >= 0 ? 'N' : 'S') : (n >= 0 ? 'E' : 'W'));
const ordinalHi = (n) => ({ 1: 'प्रथम', 2: 'द्वितीय', 3: 'तृतीय', 4: 'चतुर्थ', 5: 'पंचम', 6: 'षष्ठ', 7: 'सप्तम', 8: 'अष्टम', 9: 'नवम', 10: 'दशम', 11: 'एकादश', 12: 'द्वादश' }[n] || String(n));
const placeLine = (p) => [p.city, p.state, p.country].filter(Boolean).join(', ');
const coordLine = (p) => fmtCoord(p.lat, true) + ', ' + fmtCoord(p.lon, false) + (p.utcOffset ? ' · ' + p.utcOffset : '') + (p.tz && lang !== 'hi' ? ' · ' + p.tz : '');

function kundaliForm(){const k=PAGE.kf||(PAGE.kf={place:'',placeId:0,placeLabel:'',placeData:null,accuracy:'exact',purpose:'General'});
 const Lg=lang==='hi';
 return'<div class="page"><div class="wrap" style="max-width:760px"><h1>'+(Lg?'अपनी कुंडली बनाएँ':'Generate your Kundali')+'</h1><p class="mut mb">'+(Lg?'जन्म विवरण भरें। हम खगोल-स्तरीय गणना से कुंडली बनाते हैं, पारंपरिक दोष विश्लेषण करते हैं और उपयुक्त सेवा सुझाते हैं — आपको पहले पूजा चुनने की ज़रूरत नहीं।':'Enter the birth details. We compute the chart with an astronomy-grade ephemeris, analyse it for traditional conditions, and suggest sevas — you never have to pick a puja first.')+'</p>'+
 '<div class="card"><h3>'+(Lg?'व्यक्तिगत विवरण':'Personal details')+'</h3><div class="frm mt"><label class="f">'+(Lg?'पूरा नाम':'Full name')+'<input id="kn" autocomplete="name"></label>'+
 '<label class="f">'+(Lg?'लिंग':'Gender')+'<select id="kg"><option value="">'+(Lg?'बताना नहीं चाहते':'Prefer not to say')+'</option><option value="male">'+(Lg?'पुरुष':'Male')+'</option><option value="female">'+(Lg?'महिला':'Female')+'</option><option value="other">'+(Lg?'अन्य':'Other')+'</option></select></label>'+
 '<div class="row mt"><label class="f" style="flex:1">'+(Lg?'जन्म तिथि':'Date of birth')+'<input id="kd" type="date" max="'+iso(new Date())+'"></label><label class="f" style="flex:1">'+(Lg?'जन्म समय (24 घंटे)':'Time of birth (24h)')+'<input id="kt" type="time"></label></div>'+
 '<label class="f mt">'+(Lg?'जन्म समय की शुद्धता':'Birth time accuracy')+'<select id="ka">'+[['exact',Lg?'सटीक — जैसा अभिलेखित है':'Exact — as recorded'],['approximate',Lg?'लगभग — कुछ घंटों के भीतर':'Approximate — within a few hours'],['unknown',Lg?'अज्ञात':'Unknown']].map(a=>'<option value="'+a[0]+'"'+(k.accuracy===a[0]?' selected':'')+'>'+a[1]+'</option>').join('')+'</select></label>'+
 '<label class="f mt">'+(Lg?'जन्म स्थान':'Place of birth')+'<input id="kp" data-in="kplaceIn" placeholder="'+(Lg?'शहर का नाम टाइप करें…':'Start typing a city…')+'" autocomplete="off" value="'+esc(k.placeLabel)+'"></label><div id="kpl" class="mut sm"></div><div id="kverify"></div>'+
 '<label class="f mt">'+(Lg?'उद्देश्य (वैकल्पिक)':'Purpose (optional)')+'<select id="ku">'+PURPOSES.map((p,i)=>'<option'+(k.purpose===p?' selected':'')+' value="'+p+'">'+(Lg?PURPOSES_HI[i]:p)+'</option>').join('')+'</select></label>'+
 '<div class="row mt"><label class="f" style="flex:1">'+(Lg?'मोबाइल (वैकल्पिक)':'Mobile (optional)')+'<input id="km" inputmode="numeric" maxlength="10" placeholder="10 digits"></label><label class="f" style="flex:1">'+(Lg?'ईमेल (वैकल्पिक)':'Email (optional)')+'<input id="ke" type="email"></label></div>'+
 '<label class="f mt">'+(Lg?'गोत्र (वैकल्पिक)':'Gotra (optional)')+'<input id="kgot" placeholder="'+(Lg?'संकल्प हेतु, यदि ज्ञात हो':'For sankalp, if you know it')+'"></label></div>'+
 '<label class="row mt2"><input type="checkbox" id="ksave" checked> '+(Lg?'यह प्रोफ़ाइल मेरे खाते में सहेजें (संकल्प और भविष्य की पूजा हेतु)':'Save this profile to my account (used for sankalp and future pujas)')+'</label>'+
 '<p class="sm mut mt">'+(Lg?'आपके द्वारा दिए गए स्थान और समय हेतु सटीक गणना — ब्राउज़र लोकेशन पर नहीं। केवल पारंपरिक ज्योतिष व्याख्या; कोई भविष्यवाणी नहीं।':'Calculated for the exact place and time you give — not your browser location. Traditional Jyotish interpretation only; no predictions or guarantees.')+'</p>'+
 '<button class="btn blk mt" data-act="kgen">'+(Lg?'कुंडली बनाएँ':'Generate Kundali')+'</button></div>'+
 (PAGE.k?'<div class="card mt"><h3>'+(Lg?'आपकी पिछली कुंडली':'Your last generated Kundali')+'</h3><p class="sm mut mt">'+esc(PAGE.k.chart.meta.name)+', '+fmtD(PAGE.k.chart.meta.dob)+' — '+esc(pick(PAGE.k.chart.lagna.signName,PAGE.k.chart.lagna.signHi))+' '+(Lg?'लग्न':'lagna')+', '+esc(pick(PAGE.k.chart.rashi.signName,PAGE.k.chart.rashi.signHi))+' '+(Lg?'राशि':'rashi')+'.</p><a class="btn s mt" href="#/kundali/result">'+(Lg?'परिणाम देखें':'Open result')+'</a></div>':'')+
 '</div></div>'}

function kPlacePick(el){const q=el.value.trim();PAGE.kf.placeLabel=el.value;PAGE.kf.placeData=null;const v=$('#kverify');if(v)v.innerHTML='';
 if(q.length<2){$('#kpl').innerHTML='';return}
 clearTimeout(PAGE.kf._t);PAGE.kf._t=setTimeout(async()=>{
  try{const r=await api('/kundali/places?q='+encodeURIComponent(q));
   $('#kpl').innerHTML=r.places.length?'<div class="col mt">'+r.places.map(p=>'<button class="chip" data-act="kplace" data-id="'+p.id+'" data-label="'+esc(p.label)+'" data-json=\''+esc(JSON.stringify(p))+'\'>'+esc(p.label)+'</button>').join('')+'</div>':'<span class="mut">'+(lang==='hi'?'कोई मेल नहीं। वर्तनी बदलकर देखें।':'No matching city. Try another spelling.')+'</span>'}catch(e){$('#kpl').textContent=''}} ,250)}

/* Resolved-place confirmation shown the moment a customer picks a birth place,
   before Generate. Coordinates stay numeric and internationally readable. */
function kVerifyBox(p){const Lg=lang==='hi';
 return'<div class="card flat mt" id="kplacebox"><b>'+(Lg?'चयनित स्थान':'Selected Place')+'</b><p class="mt" style="margin:4px 0">'+esc(placeLine(p))+'</p><p class="sm mut" style="margin:0">'+fmtCoord(p.lat,true)+', '+fmtCoord(p.lon,false)+(p.tz?' · '+esc(p.tz):'')+(p.utcOffset?' · '+p.utcOffset:'')+'</p></div>'}

function kLoading(name){const Lg=lang==='hi';return'<div class="page"><div class="wrap c" style="max-width:520px"><div class="kload">'+diya()+'</div><h1 class="mt">'+(Lg?'आपकी कुंडली तैयार हो रही है…':'Preparing your Kundali…')+'</h1><p class="mut mt">'+(Lg?'ग्रहों की सायन स्थिति, भाव और विश्लेषण की गणना हो रही है। इसमें कुछ क्षण लगेंगे।':'Computing sidereal planetary positions for '+esc(name||'your birth details')+', building the houses and running the analysis. This takes a moment.')+'</p></div></div>'}

function doshCard(d,cond){const Lg=lang==='hi';const sev=d.severity==='none'?'none':d.severity;
 const name=pick(d.name||d.code,d.nameHi||d.name);
 const expl=pick(d.explanation||(cond?cond.descr:''),d.explanationHi||(cond?cond.descrHi:''));
 const evi=(Lg&&(d.evidenceHi&&d.evidenceHi.length)?d.evidenceHi:d.evidence)||[];
 const label=DOSH_LABEL[sev]||DOSH_LABEL.none;
 const remedy=Lg&&d.remedyHi?d.remedyHi:(cond&&Lg&&cond.remedyHi?cond.remedyHi:d.recommendation);
 return'<article class="card dosh dosh-'+sev+'"><div class="row sp"><h3 style="margin:0">'+DOSH_ICON[sev]+' '+esc(name)+'</h3><span class="badge '+(sev==='high'?'bad':sev==='medium'?'warn':sev==='low'?'info':'ok')+'">'+esc(L(label[0],label[1]))+'</span></div>'+
 (d.detected?'<p class="sm mut mt">'+(Lg?'अर्थ: ':'What it means: ')+esc(expl)+'</p>':'<p class="sm mut mt">'+esc(expl)+'</p>')+
 (d.detected&&evi.length?'<details class="mt"><summary class="sm">'+(Lg?'यह क्यों पहचाना गया':'Why this was identified')+'</summary><ul class="sm mut" style="padding-left:18px;margin:8px 0">'+evi.map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul></details>':'')+
 (d.detected&&remedy?'<p class="sm mt"><b>'+(Lg?'सुझाया आध्यात्मिक उपाय:':'Suggested spiritual remedy:')+'</b> '+esc(remedy)+'</p>':'')+
 (d.detected&&d.confidence!=null?'<p class="sm mut">'+(Lg?'नियम विश्वास: ':'Rule confidence: ')+Math.round(d.confidence*100)+'%</p>':'')+
 '</article>'}

function recoCard(r){const Lg=lang==='hi';const p=PU(r.pujaId);
 const prio=PRIO_LABEL[r.priority]||PRIO_LABEL.secondary;
 return'<article class="card reco"><div class="row sp"><div><span class="badge '+(r.priority==='primary'?'ok':r.priority==='secondary'?'info':'')+'">'+esc(L(prio[0],prio[1]))+'</span><h3 class="mt">'+(p?p.ic:'🪔')+' '+esc(pick(r.name||(p?p.n:'Puja'),Lg&&(p?p.h:'')||''))+'</h3></div>'+(p?'<b class="b" style="font-size:1.3rem">'+(Lg?'से ':'from ')+inr(p.price*.7)+'</b>':'')+'</div>'+
 '<p class="sm mut mt">'+(Lg?'यह सेवा क्यों? ':'Why this seva? ')+esc(pick(r.reason||'Recommended based on the analysis of your Kundali.',Lg?r.reasonHi:''))+'</p>'+
 '<p class="sm mut">'+(Lg?'यह पारंपरिक ज्योतिष-आधारित अनुशंसा है। यह किसी भविष्य की घटना की भविष्यवाणी या गारंटी नहीं है।':'This is a traditional Jyotish-based recommendation. It is not a prediction or guarantee of any future event.')+'</p>'+
 '<div class="row mt">'+(p?'<a class="btn s" href="#/book/'+p.id+'">'+(Lg?'अभी बुक करें':'Book now')+'</a><a class="btn s sec" href="#/puja/'+p.id+'">'+(Lg?'पूजा देखें':'View puja')+'</a>':'')+'</div></article>'}

function kundaliResult(){const k=PAGE.k;if(!k){const Lg=lang==='hi';return'<div class="page"><div class="wrap"><h1>'+(Lg?'कुंडली':'Kundali')+'</h1><div class="card mt">'+(Lg?'अभी कोई कुंडली नहीं बनी। ':'No Kundali generated yet. ')+'<a href="#/kundali" style="text-decoration:underline">'+(Lg?'पहले बनाएँ':'Generate one first')+'</a>.</div></div></div>'}
 const Lg=lang==='hi';
 const c=k.chart,byCode={};(k.catalogConditions||[]).forEach(x=>byCode[x.code]=x);
 const detected=k.analysis.doshas.filter(d=>d.detected),notDetected=k.analysis.doshas.filter(d=>!d.detected);
 const place=k.place||{city:c.meta.city||c.meta.place,state:c.meta.state,country:c.meta.country,lat:c.meta.lat,lon:c.meta.lon,tz:c.meta.tz,utcOffset:''};
 const PLANETS=['sun','moon','mars','mercury','jupiter','venus','saturn','rahu','ketu'];
 const planetRows=PLANETS.map(p=>{const q=c.planets[p];const nm=pick(PLANET_KEY[p][0],Lg?PLANET_KEY[p][1]:'');
  return'<tr><td>'+nm+'</td><td>'+esc(pick(q.signName,q.signHi))+'</td><td>'+(Lg?ordinalHi(q.house):q.house)+'</td><td>'+q.degreeInSign.toFixed(1)+'°</td><td>'+esc(pick(q.nakshatra.name,q.nakshatra.nameHi))+'-'+q.nakshatra.pada+'</td><td>'+esc(pick(q.dignity,q.dignityHi))+'</td></tr>'}).join('');
 const primary=k.recommendations.filter(r=>r.priority==='primary'),others=k.recommendations.filter(r=>r.priority!=='primary');
 const houseRows=c.houses.map(h=>'<tr><td>'+(Lg?ordinalHi(h.house):h.house)+'</td><td>'+esc(pick(h.signName,h.signHi))+'</td><td>'+esc(pick(h.lord,h.lordHi))+'</td></tr>').join('');
 return'<div class="page"><div class="wrap"><div class="khead"><div class="wrap"><h1 style="color:#fff">'+(Lg?'आपकी कुंडली':'Your Kundali')+'</h1><p class="mt" style="color:#fff;opacity:.92;font-size:1.1rem">'+esc(c.meta.name)+' — '+fmtD(c.meta.dob)+(c.meta.tob&&c.meta.tob!=='Unknown'?', '+c.meta.tob:'')+'<br><span class="sm" style="opacity:.85">'+(Lg?'जन्म स्थान: ':'Birth Place: ')+esc(placeLine(place))+'</span><br><span class="sm" style="opacity:.75">'+fmtCoord(place.lat,true)+', '+fmtCoord(place.lon,false)+(place.utcOffset?' · '+place.utcOffset:'')+'</span></p></div></div>'+
 '<div class="grid g3 mt2"><div class="card c"><div class="sm mut">'+(Lg?'लग्न (उदय)':'Lagna (Ascendant)')+'</div><div class="b" style="font-size:1.5rem;font-family:Yatra One">'+esc(pick(c.lagna.signName,c.lagna.signHi))+'</div><div class="sm mut">'+esc(pick(c.lagna.lord,c.lagna.lordHi))+' '+(Lg?'स्वामी हैं':'is the lord')+'</div></div>'+
 '<div class="card c"><div class="sm mut">'+(Lg?'राशि (चंद्र राशि)':'Rashi (Moon sign)')+'</div><div class="b" style="font-size:1.5rem;font-family:Yatra One">'+esc(pick(c.rashi.signName,c.rashi.signHi))+'</div><div class="sm mut">'+esc(pick(c.panchang.nakshatra,c.panchang.nakshatraHi))+', '+(Lg?'चरण':'pada')+' '+c.planets.moon.nakshatra.pada+'</div></div>'+
 '<div class="card c"><div class="sm mut">'+(Lg?'जन्म पंचांग':'Panchang at birth')+'</div><div class="b" style="font-size:1.05rem">'+esc(pick(c.panchang.tithi,c.panchang.tithiHi))+'</div><div class="sm mut">'+esc(pick(c.panchang.vara,c.panchang.varaHi))+'</div></div></div>'+
 '<div class="card mt2"><div class="row sp"><h3 style="margin:0">'+(Lg?'कुंडली विश्लेषण':'Kundali analysis')+'</h3><span class="sm mut">'+(Lg?'इंजन ':'engine ')+esc(k.analysis.engine)+'</span></div><div class="row mt"><span class="badge ok">'+(Lg?'✓ कुंडली बनी':'✓ Kundali generated')+'</span><span class="badge ok">'+(Lg?'✓ ग्रह विश्लेषण':'✓ Planetary analysis')+'</span><span class="badge '+(detected.length?'warn':'ok')+'">'+(detected.length?(Lg?'⚠ दोष विश्लेषण: ':'⚠ Dosh analysis: ')+detected.length+(Lg?' स्थिति(याँ) चिह्नित':' condition(s) flagged'):(Lg?'✓ दोष विश्लेषण: कुछ नहीं चिह्नित':'✓ Dosh analysis: nothing flagged'))+'</span></div></div>'+
 '<h2 class="mt2 mb">'+(Lg?'कुंडली दोष एवं आध्यात्मिक विश्लेषण':'Kundali dosh & spiritual analysis')+'</h2><p class="sm mut mb">'+(Lg?'पारंपरिक ज्योतिष व्याख्या इन संयोगों को कुछ जीवन-विषयों से जोड़ती है। कोई भी सूचीबद्ध स्थिति भविष्यवाणी या गारंटी नहीं है।':'Traditional Jyotish interpretation associates these combinations with certain life themes. A listed condition is not a prediction or a guarantee of any event.')+'</p>'+
 (detected.length?detected.map(d=>doshCard(d,byCode[d.code])).join(''):'<div class="card dosh dosh-none"><div class="row sp"><h3 style="margin:0">'+(Lg?'✓ कोई पारंपरिक दोष चिह्नित नहीं':'✓ No traditional dosh conditions flagged')+'</h3></div><p class="sm mut mt">'+(Lg?'नियमों ने इस कुंडली में विश्लेषित संयोगों में से कोई नहीं पाया। हर कुंडली अनोखी है — पंडित जी आपके संकल्प हेतु उपयुक्त सेवा सुझा सकते हैं।':'The rules did not identify any of the analysed combinations in this chart. Every chart is unique — a pandit can still suggest a suitable seva for your sankalp.')+'</p></div>')+
 (notDetected.length?'<details class="card flat mt"><summary class="sm">'+(Lg?'जाँची गई, पहचानी नहीं गई स्थितियाँ (':'Conditions checked and not detected (')+notDetected.length+')</summary>'+notDetected.map(d=>doshCard(d,byCode[d.code])).join('')+'</details>':'')+
 (k.recommendations.length?'<h2 class="mt2 mb">'+(Lg?'आपकी अनुशंसित सेवा':'Your recommended seva')+'</h2><div class="grid g2">'+(primary.length?primary.map(recoCard).join(''):'')+'</div>'+(others.length?'<h3 class="mt2">'+(Lg?'अन्य आध्यात्मिक अनुशंसाएँ':'Other spiritual recommendations')+'</h3><div class="grid g2">'+others.map(recoCard).join('')+'</div>':''):'<div class="card mt2"><p class="mut">'+(Lg?'इस विश्लेषण से कोई विशेष सेवा नहीं जुड़ी। ':'No specific seva matched this analysis. ')+'<a href="#/pujas" style="text-decoration:underline">'+(Lg?'पूजा सूची देखें':'Browse the puja catalogue')+'</a>.</p></div>')+
 (k.havans&&k.havans.length?'<h2 class="mt2 mb">'+(Lg?'अनुशंसित हवन कुंड':'Recommended havan kund')+'</h2><div class="grid g3">'+k.havans.map(h=>'<div class="card"><h3 style="margin:0">🔥 '+esc(h.name)+'</h3><p class="sm mut mt">'+esc(h.descr||'')+'</p><div class="row sp mt"><span class="sm mut">'+esc(h.material)+', '+h.size+' '+(Lg?'इंच':'inch')+'</span><b>'+inr(h.price)+'</b></div>'+(h.forPujas&&h.forPujas.length?'<a class="btn s ghost mt" href="#/puja/'+h.forPujas[0]+'">'+(Lg?'प्रयुक्त ':'Used in ')+esc((PU(h.forPujas[0])||{}).n||(Lg?'पूजा':'puja'))+'</a>':'')+'</div>').join('')+'</div>':'')+
 (k.samagri&&k.samagri.length?'<details class="card flat mt"><summary class="sm">'+(Lg?'पारंपरिक सामग्री (':'Samagri traditionally used (')+k.samagri.length+' '+(Lg?'वस्तुएँ':'items')+')</summary><ul class="sm mut" style="padding-left:18px;margin:8px 0">'+k.samagri.map(s=>'<li>'+esc(s.name)+' — '+s.qty+' '+esc(s.unit)+'</li>').join('')+'</ul></details>':'')+
 '<h2 class="mt2 mb">'+(Lg?'ग्रह स्थिति':'Planetary overview')+'</h2><div class="tw"><table><thead><tr><th>'+(Lg?'ग्रह':'Planet')+'</th><th>'+(Lg?'राशि':'Sign')+'</th><th>'+(Lg?'भाव':'House')+'</th><th>'+(Lg?'अंश':'Degree')+'</th><th>'+(Lg?'नक्षत्र':'Nakshatra')+'</th><th>'+(Lg?'स्थिति':'Status')+'</th></tr></thead><tbody>'+planetRows+'</tbody></table></div>'+
 '<details class="card flat mt"><summary class="sm">'+(Lg?'भाव तालिका (12 भाव)':'Houses (12)')+'</summary><div class="tw mt"><table><thead><tr><th>'+(Lg?'भाव':'House')+'</th><th>'+(Lg?'राशि':'Sign')+'</th><th>'+(Lg?'स्वामी':'Lord')+'</th></tr></thead><tbody>'+houseRows+'</tbody></table></div></details>'+
 '<details class="card flat mt"><summary class="sm">'+(Lg?'दशा क्रम (विंशोत्तरी)':'Dasha timeline (Vimshottari)')+'</summary><div class="tw mt"><table><thead><tr><th>'+(Lg?'स्वामी':'Lord')+'</th><th>'+(Lg?'से':'From')+'</th><th>'+(Lg?'तक':'To')+'</th><th>'+(Lg?'वर्ष':'Years')+'</th></tr></thead><tbody>'+c.dashas.periods.map(d=>'<tr'+(d===c.dashas.current?' class="b"':'')+'><td>'+esc(pick(d.lord,d.lordHi))+(d===c.dashas.current?(Lg?' (वर्तमान)':' (current)'):'')+'</td><td>'+fmtD(d.from)+'</td><td>'+fmtD(d.to)+'</td><td>'+d.years+'</td></tr>').join('')+'</tbody></table></div><p class="sm mut mt">'+(Lg?'जन्म के समय प्रथम दशा का शेष: ':'Balance of the first dasha at birth: ')+c.dashas.balanceAtBirth+' '+(Lg?'वर्ष।':'years.')+'</p></details>'+
 '<div class="card mt2"><p class="sm mut">'+(Lg?'स्थितियाँ सायन (लहरी अयनांश '+c.meta.ayanamsa+'°) हैं, आपकी जन्म विवरणों से DaivikPooja की आंतरिक गणना द्वारा। ':'Positions are sidereal (Lahiri ayanamsa '+c.meta.ayanamsa+'°) computed by DaivikPooja\u2019s in-house ephemeris from your birth details. ')+'<a href="#/kundali" style="text-decoration:underline">'+(Lg?'नई कुंडली बनाएँ':'Generate another Kundali')+'</a>.</p></div>'+
 '<div class="note mt2"><p class="sm" style="margin:0">'+esc(L('This analysis follows traditional Jyotish rules on your birth details. It is offered for spiritual guidance and is not a prediction or guarantee of any future event.','यह विश्लेषण आपकी जन्म विवरणों पर पारंपरिक ज्योतिष नियमों के अनुसार है। यह आध्यात्मिक मार्गदर्शन हेतु है — यह किसी भी भविष्य की घटना की भविष्यवाणी या गारंटी नहीं है।'))+'</p></div>'+
 '</div></div>'}
