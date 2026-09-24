'use strict';
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const inr=n=>'₹'+Math.round(n).toLocaleString('en-IN');
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const iso=d=>{const x=new Date(d);return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0')};
const addDays=n=>{const x=new Date();x.setHours(12,0,0,0);x.setDate(x.getDate()+n);return iso(x)};
const dt=s=>new Date(s+'T12:00:00');
const fmtD=s=>dt(s).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'});
const uid=p=>p+Math.random().toString(36).slice(2,7).toUpperCase();
const store={get(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};
const stars=r=>'<span class="star" aria-label="'+r+' out of 5">'+'★'.repeat(Math.round(r))+'☆'.repeat(5-Math.round(r))+'</span>';

const T={en:{pujas:'Pujas',pandits:'Pandits',temples:'Temples',samagri:'Samagri',prasad:'Prasad',festivals:'Festivals',kundali:'Kundali',astrology:'Astrology',corporate:'Corporate',login:'Login',h1a:'The whole puja,',h1b:'arranged in one place.',lead:'Choose the right puja, book a verified pandit, get samagri at your door, watch the ritual, and receive prasad.',search:'Search pujas, e.g. Griha Pravesh',find:'Find puja',sk:'Tell us your sankalp',book:'Book now'},
hi:{pujas:'पूजा',pandits:'पंडित',temples:'मंदिर',samagri:'सामग्री',prasad:'प्रसाद',festivals:'त्योहार',kundali:'कुंडली',astrology:'ज्योतिष',corporate:'कॉर्पोरेट',login:'लॉगिन',h1a:'संपूर्ण पूजा,',h1b:'एक ही जगह पर।',lead:'सही पूजा चुनें, सत्यापित पंडित बुक करें, सामग्री घर पर पाएँ, पूजा देखें और प्रसाद प्राप्त करें।',search:'पूजा खोजें, जैसे गृह प्रवेश',find:'पूजा खोजें',sk:'अपना संकल्प बताएँ',book:'अभी बुक करें',
 details:'विवरण',min:'मिनट',from:'से',newPuja:'नई पूजा चाहिए? अनुरोध भेजें',send:'भेजें',
 stNew:'नया',stConfirmed:'पुष्ट',stAssigned:'पंडित नियुक्त',stStarted:'प्रारंभ',stCompleted:'पूर्ण',stCancelled:'रद्द',stPendingPayment:'भुगतान लंबित'}};
/* Booking status labels (badge()); Hindi when lang==='hi'. */
const STATUS_HI={'New':'नया','Confirmed':'पुष्ट','Assigned':'पंडित नियुक्त','Started':'प्रारंभ','Completed':'पूर्ण','Cancelled':'रद्द','PendingPayment':'भुगतान लंबित','Open':'खुला','Resolved':'हल','Paid':'भुगतान','Pending':'लंबित','Delivered':'वितरित','Dispatched':'भेजा गया','Packed':'पैक','Processed':'प्रक्रिया','Initiated':'शुरू','verified':'सत्यापित','pending':'लंबित','rejected':'अस्वीकृत','Sent':'भेजा','Scheduled':'निर्धारित'};
const CITY_HI={'Delhi NCR':'दिल्ली एनसीआर',Mumbai:'मुंबई',Bengaluru:'बेंगलुरु',Pune:'पुणे',Jaipur:'जयपुर',Lucknow:'लखनऊ',Varanasi:'वाराणसी',Ahmedabad:'अहमदाबाद',Chennai:'चेन्नई',Hyderabad:'हैदराबाद',Kolkata:'कोलकाता',Kochi:'कोच्चि'};
let lang=store.get('dp_lang','en');const t=k=>(T[lang]||T.en)[k]||T.en[k]||k;

const MODES=Pricing.MODES;
const SLOTS=Pricing.SLOTS;
const CITIES=['Delhi NCR','Mumbai','Bengaluru','Pune','Jaipur','Lucknow','Varanasi','Ahmedabad','Chennai','Hyderabad'];
const CATS=['Festival','Life Event','Health & Dosha','Prosperity','Deity Worship'];
const STATUSES=['New','Confirmed','Assigned','Started','Completed','Cancelled'];

/* Catalogue arrays are filled from GET /api/state */
const PUJAS=[],KITS=[],PRASAD=[],TEMPLES=[],FEST=[];
const RECUR=[
{n:'Ekadashi',t:'Twice a month. Vishnu worship and fasting.',p:'satyanarayan'},
{n:'Purnima',t:'Full moon. Satyanarayan katha and charity.',p:'satyanarayan'},
{n:'Amavasya',t:'New moon. Tarpan and remembrance of ancestors.',p:'pitru'},
{n:'Masik Shivratri',t:'Monthly Shiva worship before the new moon.',p:'rudra'}];
const RASHI=['Mesha (Aries)','Vrishabha (Taurus)','Mithuna (Gemini)','Karka (Cancer)','Simha (Leo)','Kanya (Virgo)','Tula (Libra)','Vrishchika (Scorpio)','Dhanu (Sagittarius)','Makara (Capricorn)','Kumbha (Aquarius)','Meena (Pisces)'];
const HORO=['A steady day for work. Finish pending tasks before starting new ones.','Family conversations go well today. Listen more than you speak.','Money matters need patience. Avoid impulse purchases.','A good day to begin something you have postponed.','Take rest. Your energy is better spent on one priority.','Old contacts may help. Reply to that message you have been delaying.'];
const TESTI=[['Our Griha Pravesh went smoothly. The samagri arrived the evening before and the pandit explained each step.','Sample review: Neha K., Gurugram'],['My parents in Jaipur joined the Satyanarayan katha on video and heard our sankalp by name.','Sample review: Vikram S., Dubai'],['Everything was priced upfront and the invoice came on WhatsApp.','Sample review: Meera I., Bengaluru']];
const FAQ=[['Are the pandits verified?','Every pandit completes mobile OTP verification, ID and document KYC, and profile review before receiving bookings. Verified pandits carry a badge.'],['Can I get samagri without booking a pandit?','Yes. Order kits from the Samagri page. You can also add a kit to any puja booking.'],['What if I need to cancel?','Cancel from your account. Refunds depend on how close you are to the puja: 100% more than 48 hours ahead, 75% between 24 and 48 hours, 50% within 24 hours.'],['How does an online puja work?','At the booked time you join a video call. The pandit reads your sankalp with your name and gotra, and you can receive photos afterwards.'],['Does the muhurat or date need to be exact?','Your pandit can confirm the best time for your city. Use the festival calendar and astrology pages as guidance.']];
const LEARN=['How to conduct a Satyanarayan katha (checklist)','Correct pronunciation for common mantras','Customer etiquette and punctuality','Using the completion update and uploading photos','Festival season preparation guide'];
const MONTHLY=[['Apr',182],['May',214],['Jun',196],['Jul',248],['Aug',231],['Sep',276]];
