/* =====================================================================
   PRIME LIFE DIAGNOSTICS – PATIENT PORTAL
   Live version: data is stored in Supabase (UK, London region).
   ===================================================================== */
const CFG = window.PORTAL_CONFIG || {};
const BUCKET = "patient-files";
const SITE_URL = CFG.siteUrl || (location.origin + location.pathname);   // where email links (confirm, reset) should open
const NB = (window.NativeBridge && window.NativeBridge.isNative) ? window.NativeBridge : null;   // set only inside the phone app
const CLINIC_EMAIL = "info@primelifediagnostics.co.uk";
const CLINIC_PHONE = "01302 203565";
const IDLE_MINUTES = 30;               // automatic sign-out after inactivity
let sb = null;
if (CFG.supabaseUrl && CFG.supabaseKey && window.supabase) {
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
}

/* ---------- app state ---------- */
let role = null;            // 'patient' | 'clinic'
let me = null;              // patient object (patient) or {name, role, user_id} (staff)
let staffList = [];         // for the doctor dropdown
let page = "dashboard", ctx = {};
const db = { patients: [] };

/* ---------- small helpers ---------- */
function $(id){return document.getElementById(id)}
function toast(t){const el=$("toast");el.textContent=t;el.classList.add("show");clearTimeout(el._t);el._t=setTimeout(()=>el.classList.remove("show"),3200)}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function dt(d){if(!d)return"–";return new Date(d).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}
function initials(n){return (n||"").replace(/^Dr\.?\s*/,"").split(/\s+/).filter(Boolean).map(w=>w[0]).join("").slice(0,2).toUpperCase()}
function ukDate(iso){if(!iso)return"–";const [y,m,d]=iso.slice(0,10).split("-");return `${d}/${m}/${y}`}
function isoFromUk(d){const m=(d||"").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);if(!m)return null;let y=m[3];if(y.length===2)y=(+y>40?"19":"20")+y;return `${y}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`}
function today(){return new Date().toISOString().slice(0,10)}
function safeName(n){return (n||"file").replace(/[^A-Za-z0-9._-]+/g,"_").slice(-80)}
function uid(){return (crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(16).slice(2))}
function must(res,what){if(res.error){console.error(what,res.error);throw new Error((what?what+": ":"")+res.error.message)}return res.data}
function busy(on,msg){const b=$("busy");if(!b)return;b.classList.toggle("hidden",!on);if(msg)$("busyMsg").textContent=msg}
async function guard(fn,msg){try{busy(true,msg||"Saving…");return await fn()}catch(e){toast(e.message||"Something went wrong");console.error(e)}finally{busy(false)}}
async function audit(action,o={}){try{if(sb)await sb.from("audit_log").insert({action,patient_id:o.patient_id||null,report_id:o.report_id||null,details:o.details||null,user_id:(await sb.auth.getUser()).data.user?.id})}catch(e){}}

/* =====================================================================
   SIGN-IN SCREENS
   ===================================================================== */
function showScreen(id){["scrSignin","scrSignup","scrForgot","scrReset","scrMfa","scrMsg"].forEach(s=>$(s).classList.toggle("hidden",s!==id))}
function showLogin(){$("app").classList.add("hidden");$("login").classList.remove("hidden")}
function showApp(){$("login").classList.add("hidden");$("app").classList.remove("hidden")}
function loginMsg(title,body,back=true){$("msgTitle").textContent=title;$("msgBody").innerHTML=body;$("msgBack").classList.toggle("hidden",!back);showScreen("scrMsg")}
function setTab(t){$("tabIn").classList.toggle("on",t==="in");$("tabUp").classList.toggle("on",t==="up");showScreen(t==="in"?"scrSignin":"scrSignup")}

async function doSignIn(e){
  e.preventDefault();
  const email=$("inEmail").value.trim(), pw=$("inPw").value;
  await guard(async()=>{
    must(await sb.auth.signInWithPassword({email,password:pw}),"Sign-in failed");
    $("inPw").value="";
    await afterSignIn();
  },"Signing in…");
}
async function doSignUp(e){
  e.preventDefault();
  const email=$("upEmail").value.trim(), pw=$("upPw").value, pw2=$("upPw2").value;
  if(pw.length<10) return toast("Please choose a password of at least 10 characters.");
  if(pw!==pw2) return toast("The two passwords don't match.");
  await guard(async()=>{
    must(await sb.auth.signUp({email,password:pw,options:{emailRedirectTo:SITE_URL}}),"Couldn't create account");
    loginMsg("Check your email",`We've sent a confirmation link to <b>${esc(email)}</b>. Click it to activate your account, then come back here to sign in.<br><br><span class="small muted">Please use the same email address you gave the clinic, so your results can be linked to your account.</span>`);
  },"Creating account…");
}
async function doForgot(e){
  e.preventDefault();
  const email=$("fgEmail").value.trim();
  await guard(async()=>{
    must(await sb.auth.resetPasswordForEmail(email,{redirectTo:SITE_URL}),"Couldn't send reset email");
    loginMsg("Check your email",`If an account exists for <b>${esc(email)}</b>, we've sent a link to reset your password.`);
  },"Sending…");
}
async function doReset(e){
  e.preventDefault();
  const pw=$("rsPw").value; if(pw.length<10) return toast("Please choose a password of at least 10 characters.");
  await guard(async()=>{must(await sb.auth.updateUser({password:pw}),"Couldn't update password");toast("Password updated.");await afterSignIn()},"Updating…");
}

/* ---------- two-factor (required for staff) ---------- */
let mfaFactorId=null;
async function startMfa(){
  const f=must(await sb.auth.mfa.listFactors(),"2FA");
  const verified=(f.totp||[]).filter(x=>x.status==="verified");
  if(verified.length){
    mfaFactorId=verified[0].id;
    $("mfaTitle").textContent="Enter your security code";
    $("mfaBody").innerHTML="Open your authenticator app (e.g. Google Authenticator or Microsoft Authenticator) and enter the 6-digit code for <b>Prime Life portal</b>.";
    $("mfaQr").innerHTML="";
  } else {
    for(const x of (f.all||[])) if(x.status!=="verified") await sb.auth.mfa.unenroll({factorId:x.id});
    const en=must(await sb.auth.mfa.enroll({factorType:"totp",friendlyName:"Prime Life portal"}),"2FA setup");
    mfaFactorId=en.id;
    $("mfaTitle").textContent="Set up two-factor login";
    $("mfaBody").innerHTML="Staff accounts need a second step to protect patient data. Install an authenticator app on your phone (Google Authenticator or Microsoft Authenticator), scan this code, then enter the 6-digit code it shows.";
    $("mfaQr").innerHTML=`<img src="${en.totp.qr_code}" alt="QR code" style="width:180px;height:180px;display:block;margin:6px auto"><div class="small muted" style="text-align:center;word-break:break-all">Can't scan? Enter this key: <b>${esc(en.totp.secret)}</b></div>`;
  }
  $("mfaCode").value="";showLogin();showScreen("scrMfa");setTimeout(()=>$("mfaCode").focus(),50);
}
async function doMfa(e){
  e.preventDefault();
  const code=$("mfaCode").value.replace(/\s/g,"");
  await guard(async()=>{must(await sb.auth.mfa.challengeAndVerify({factorId:mfaFactorId,code}),"That code didn't work");await afterSignIn()},"Checking…");
}

/* ---------- after sign-in: work out who this is ---------- */
async function afterSignIn(){
  const user=(await sb.auth.getUser()).data.user; if(!user){showLogin();setTab("in");return}
  const staff=must(await sb.from("staff").select("*").eq("user_id",user.id).maybeSingle(),"Loading account");
  if(staff){
    if(!staff.active){await sb.auth.signOut();return loginMsg("Account disabled","This staff account has been switched off. Please speak to the practice manager.")}
    const aal=must(await sb.auth.mfa.getAuthenticatorAssuranceLevel(),"2FA");
    if(aal.currentLevel!=="aal2") return startMfa();
    role="clinic"; me={name:staff.full_name,role:staff.role,user_id:user.id};
    busy(true,"Loading patients…");
    try{await loadClinicData()}finally{busy(false)}
    showApp(); go("clinic-home");
  } else {
    role="patient";
    busy(true,"Loading your results…");
    try{
      const rows=must(await sb.from("patients").select(PATIENT_SELECT),"Loading results");
      if(!rows.length){busy(false);showLogin();loginMsg("We couldn't find your records yet",`Your account (<b>${esc(user.email)}</b>) isn't linked to a patient record. This usually means the clinic has a different email address for you, or your record hasn't been created yet.<br><br>Please contact us on <b>${CLINIC_PHONE}</b> or <b>${CLINIC_EMAIL}</b>.`,false);addSignOutToMsg();return}
      me=toPatient(rows[0]);
    }finally{busy(false)}
    showApp(); audit("signed_in",{patient_id:me.id}); go("dashboard");
    if(NB) nativeAfterPatientSignIn();
  }
}
function addSignOutToMsg(){$("msgBody").insertAdjacentHTML("beforeend",`<div style="margin-top:18px"><button class="btn block" onclick="logout()">Sign out</button></div>`)}
async function logout(){if(NB){try{await nativeBeforeSignOut()}catch(e){}}try{await sb.auth.signOut()}catch(e){}role=null;me=null;db.patients=[];FILES={};ctx={};showLogin();setTab("in")}

/* ---------- automatic sign-out when idle ---------- */
let idleT=null;
function resetIdle(){clearTimeout(idleT);if(role)idleT=setTimeout(()=>{logout();toast("You were signed out after "+IDLE_MINUTES+" minutes of inactivity.")},IDLE_MINUTES*60000)}
["click","keydown","mousemove","touchstart","scroll"].forEach(ev=>addEventListener(ev,resetIdle,{passive:true}));

/* =====================================================================
   DATA: load from Supabase and convert to the shape the screens use
   ===================================================================== */
const PATIENT_SELECT="*, reports(*, results(*)), documents(*)";
async function loadClinicData(){
  const rows=must(await sb.from("patients").select(PATIENT_SELECT).order("created_at",{ascending:false}),"Loading patients");
  FILES={};db.patients=rows.map(toPatient);
  staffList=must(await sb.from("staff").select("*").eq("active",true).order("full_name"),"Loading staff");
}
async function reloadPatient(pid){
  const row=must(await sb.from("patients").select(PATIENT_SELECT).eq("id",pid).single(),"Refreshing");
  const p=toPatient(row), i=db.patients.findIndex(x=>x.id===pid);
  if(i>=0)db.patients[i]=p; else db.patients.unshift(p);
  return p;
}
const docFileIds={};
function fileFor(d){if(docFileIds[d.id]&&FILES[docFileIds[d.id]])return docFileIds[d.id];const id=regFile({name:d.name,size:d.size_bytes||0,path:d.storage_path,docId:d.id,patientId:d.patient_id});docFileIds[d.id]=id;return id}
function toPatient(row){
  const docs=(row.documents||[]).slice().sort((a,b)=>b.created_at.localeCompare(a.created_at));
  const p={id:row.id,no:row.patient_no,name:row.full_name,dob:row.dob?ukDate(row.dob):"–",dobIso:row.dob,sex:row.sex||"",email:row.email||"",phone:row.phone||"",user_id:row.user_id,
    reports:(row.reports||[]).map(r=>{
      const letterDoc=docs.find(d=>d.report_id===r.id&&d.kind==="letter"), labDoc=docs.find(d=>d.report_id===r.id&&d.kind==="lab_report");
      return {id:r.id,title:r.title,date:r.collected_on||r.created_at.slice(0,10),received:r.reported_on||r.created_at.slice(0,10),ref:r.specimen_no||"",status:r.status,doctor:r.doctor_name||"",note:r.note||"",releasedAt:r.released_at,
        letter:letterDoc?fileFor(letterDoc):null,letterDocId:letterDoc?.id,labFile:labDoc?fileFor(labDoc):null,
        markers:(r.results||[]).slice().sort((a,b)=>a.position-b.position).map(x=>({name:x.name,value:x.value==null?null:Number(x.value),text:x.text_value||undefined,flag:x.flag||"",unit:x.unit||"",min:x.ref_min==null?null:Number(x.ref_min),max:x.ref_max==null?null:Number(x.ref_max),section:x.section||"Other",labNote:x.lab_note?x.lab_note.split("\n"):undefined}))};
    }),
    docs:docs.map(d=>({name:d.name,date:d.created_at.slice(0,10),size:sizeTxt(d.size_bytes||0),by:d.uploaded_by_name||"Clinic",file:fileFor(d),kind:d.kind,docId:d.id}))};
  return p;
}
function resultRows(rid,markers){
  return markers.filter(m=>m.name).map((m,i)=>({report_id:rid,position:i,section:m.section||"Other",name:m.name,value:(m.value===""||m.value==null||isNaN(+m.value))?null:+m.value,text_value:m.text||null,unit:m.unit||null,ref_min:m.min==null||m.min===""?null:+m.min,ref_max:m.max==null||m.max===""?null:+m.max,flag:m.flag||null,lab_note:m.labNote?m.labNote.join("\n"):null}));
}
async function saveResults(rid,markers){
  must(await sb.from("results").delete().eq("report_id",rid),"Saving results");
  const rows=resultRows(rid,markers); if(rows.length) must(await sb.from("results").insert(rows),"Saving results");
}
async function uploadFile(pid,folder,file,buf,kind,reportId,visible=true){
  const path=`${pid}/${folder}/${uid()}-${safeName(file.name)}`;
  const body=buf?new Blob([buf],{type:file.type||"application/octet-stream"}):file;
  must(await sb.storage.from(BUCKET).upload(path,body,{contentType:file.type||undefined,upsert:false}),"Uploading "+file.name);
  return must(await sb.from("documents").insert({patient_id:pid,report_id:reportId||null,kind,name:file.name,storage_path:path,size_bytes:file.size||null,visible_to_patient:visible,uploaded_by_name:me?.name||"Clinic"}).select().single(),"Saving document");
}
async function deleteDocument(docId){
  const d=must(await sb.from("documents").select("*").eq("id",docId).single(),"Removing file");
  await sb.storage.from(BUCKET).remove([d.storage_path]);
  must(await sb.from("documents").delete().eq("id",docId),"Removing file");
}
async function downloadFile(id){
  const f=FILES[id]; if(!f) return;
  try{
    if(!f.buf){const {data,error}=await sb.storage.from(BUCKET).download(f.path);if(error)throw error;f.buf=await data.arrayBuffer()}
    const url=URL.createObjectURL(new Blob([f.buf])); const a=document.createElement("a"); a.href=url; a.download=f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),4000);
  }catch(e){toast("Couldn't download: "+e.message)}
}

/* =====================================================================
   ROUTING + LAYOUT
   ===================================================================== */
function go(p,c={}){page=p;ctx=c;render();window.scrollTo(0,0)}
function render(){
  if(!me) return;
  $("whoName").textContent=me.name;
  $("whoAv").textContent=initials(me.name);
  $("whoRole").textContent= role==="patient"?"Patient · "+me.no:({manager:"Manager",reception:"Reception",doctor:"Doctor",admin:"Manager"}[me.role]||"Manager");
  const nav = role==="patient"
   ? [["dashboard","Overview",ICON.home],["reports","My results",ICON.rep],["documents","Documents",ICON.doc],["profile","My details",ICON.user]]
   : [["clinic-home","Review queue",ICON.inbox,awaiting().length],["upload","Upload lab report",ICON.up],["patients","Patients",ICON.users]];
  $("navItems").innerHTML = nav.map(n=>`<button class="nav ${page===n[0]||(ctx.navParent===n[0])?'on':''}" onclick="go('${n[0]}')">${n[2]}${n[1]}${n[3]?`<span class="count">${n[3]}</span>`:""}</button>`).join("");
  const V=$("view");
  const views=role==="patient"?{dashboard:pDash,reports:pReports,report:pReport,documents:pDocs,profile:pProfile}:{"clinic-home":cHome,upload:cUpload,patients:cPatients,patient:cPatient,review:cReview};
  (views[page]||Object.values(views)[0])(V);
}
function closeModal(){$("modalRoot").innerHTML=""}
function modal(html){$("modalRoot").innerHTML=`<div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal">${html}</div></div>`}

/* =====================================================================
   START-UP
   ===================================================================== */
async function boot(){
  if(!sb){showLogin();return loginMsg("Portal not configured yet","Add the Supabase Project URL and publishable key to <b>config.js</b>.",false)}
  sb.auth.onAuthStateChange((ev)=>{ if(ev==="PASSWORD_RECOVERY"){showLogin();showScreen("scrReset")} });
  const {data}=await sb.auth.getSession();
  if(/type=recovery/.test(location.hash)) return; // handled by the event above
  if(data.session){ if(NB && !(await nativeUnlockGate())){ await logout(); return } await guard(afterSignIn,"Loading…") } else { showLogin(); setTab("in") }
  history.replaceState(null,"",location.pathname);
}
/* ============================================================
   PLAIN-ENGLISH LIBRARY (matched to Inuvi test names)
   ============================================================ */
const LIB=[
 {re:/^hb ?a1c/i,name:"HbA1c (average blood sugar)",what:"Your average blood sugar level over the last 2–3 months.",high:"A raised HbA1c can mean your blood sugar has been running high. 42–47 is the 'prediabetes' range and 48 or above may mean diabetes. Your doctor will advise you on next steps."},
 {re:/^calcium/i,name:"Calcium",what:"A mineral needed for strong bones, muscles and nerves.",low:"A low calcium can be linked to low vitamin D.",high:"A raised calcium is worth discussing with your doctor, who may repeat the test."},
 {re:/^uric acid/i,name:"Uric Acid",what:"A waste product from breaking down certain foods. High levels can cause gout.",high:"Raised uric acid can be linked to diet, alcohol, dehydration or gout."},
 {re:/^c reactive protein|^crp/i,name:"CRP (inflammation)",what:"C-reactive protein rises when there is inflammation or infection somewhere in the body. The high-sensitivity test is also used as a marker of heart risk.",high:"A raised CRP often follows a recent cold, infection or injury. Your doctor may suggest repeating it once you're well."},
 {re:/^urea$/i,name:"Urea",what:"A waste product filtered out by your kidneys.",low:"A low urea is usually linked to diet and is rarely a concern.",high:"A raised urea can be caused by dehydration, a high-protein diet or reduced kidney function."},
 {re:/^creatinine/i,name:"Creatinine",what:"A waste product from your muscles that your kidneys filter out.",low:"A low level is usually linked to lower muscle mass and is rarely a concern.",high:"A raised level can mean the kidneys are filtering less well. It can also follow dehydration, heavy exercise or a high-protein diet."},
 {re:/^sodium/i,name:"Sodium",what:"A salt that helps control your body's fluid balance.",low:"Low sodium can be linked to drinking a lot of water or to some medicines.",high:"High sodium is usually a sign of dehydration."},
 {re:/^chloride/i,name:"Chloride",what:"A salt that works with sodium to keep fluids balanced."},
 {re:/^potassium/i,name:"Potassium",what:"A salt important for your heart and muscles."},
 {re:/gfr/i,name:"eGFR (kidney filtration)",what:"An estimate of how well your kidneys filter your blood, worked out from your creatinine, age and sex.",low:"A lower eGFR can mean reduced kidney function, but it is often affected by muscle mass, hydration and exercise. Values of 60–89 with no other signs are common, and your doctor may simply repeat the test."},
 {re:/^cholesterol$|^total cholesterol/i,name:"Total Cholesterol",what:"The total amount of cholesterol (a type of fat) in your blood.",high:"Raised cholesterol increases long-term heart and circulation risk. Diet, exercise and sometimes medication can help bring it down."},
 {re:/^triglycerides/i,name:"Triglycerides",what:"Another type of blood fat, affected by diet, alcohol and whether you fasted before the test.",high:"A raised level can be affected by not fasting, alcohol or sugary foods."},
 {re:/^hdl cholesterol/i,name:"HDL Cholesterol ('good')",what:"'Good' cholesterol, because it helps carry cholesterol away from the arteries.",low:"A low HDL is linked with higher heart risk. Regular exercise can help raise it.",high:"A high HDL is generally seen as protective."},
 {re:/^ldl cholesterol/i,name:"LDL Cholesterol ('bad')",what:"'Bad' cholesterol, because it can build up in the walls of your arteries.",high:"A raised LDL is worth discussing with your doctor alongside your other heart risk factors."},
 {re:/^non hdl/i,name:"Non-HDL Cholesterol",what:"All the 'bad' types of cholesterol added together. It's one of the best single measures of heart risk from cholesterol.",high:"A raised non-HDL cholesterol increases long-term heart risk. Your doctor may discuss lifestyle changes or treatment."},
 {re:/^hdl %/i,name:"HDL % of Total",what:"How much of your total cholesterol is the 'good' HDL type. Higher is better.",low:"A low percentage means less of your cholesterol is the protective type."},
 {re:/^thyroid stim|^tsh/i,name:"TSH (Thyroid Stimulating Hormone)",what:"The hormone your brain uses to tell the thyroid gland how hard to work.",low:"A low TSH can suggest an overactive thyroid.",high:"A high TSH can suggest an underactive thyroid, which can cause tiredness, feeling cold and weight gain."},
 {re:/^free t3/i,name:"Free T3",what:"The active thyroid hormone that controls how fast your body uses energy.",low:"A low level can suggest an underactive thyroid.",high:"A high level can suggest an overactive thyroid."},
 {re:/^free thyroxine|^free t4/i,name:"Free T4 (Thyroxine)",what:"The main hormone made by your thyroid gland.",low:"A low level can suggest an underactive thyroid.",high:"A high level can suggest an overactive thyroid."},
 {re:/^active b12/i,name:"Active Vitamin B12",what:"The form of vitamin B12 your body can actually use. It helps make red blood cells and keeps nerves healthy.",low:"Low B12 can cause tiredness, pins and needles or low mood."},
 {re:/^folate/i,name:"Folate",what:"Folate (vitamin B9) works with B12 to make healthy red blood cells.",low:"Low folate is often diet-related and can cause tiredness."},
 {re:/vitamin d/i,name:"Vitamin D",what:"Keeps your bones, teeth and muscles healthy. In the UK we make most of it from sunlight in the summer.",low:"Low vitamin D is very common in the UK, especially in autumn and winter. A daily supplement usually helps.",high:"Very high levels usually come from taking too much of a supplement."},
 {re:/^total protein/i,name:"Total Protein",what:"The total amount of protein in your blood, made up mainly of albumin and globulin."},
 {re:/^albumin/i,name:"Albumin",what:"The main protein made by your liver. It reflects your liver health and nutrition.",low:"A low albumin can be linked to liver problems, inflammation or poor nutrition.",high:"A high albumin usually means mild dehydration."},
 {re:/^globulin/i,name:"Globulin",what:"A group of proteins that includes antibodies, which help fight infection."},
 {re:/^alanine/i,name:"ALT (liver enzyme)",what:"An enzyme found mainly in the liver. It leaks into the blood when liver cells are irritated.",high:"A raised ALT can be linked to alcohol, fatty liver, some medicines or supplements, or recent hard exercise. Your doctor may suggest repeating it."},
 {re:/^alkaline/i,name:"ALP (Alkaline Phosphatase)",what:"An enzyme found in the liver and bones.",high:"A raised ALP can come from the liver or the bones (for example during growth or healing)."},
 {re:/^aspartate/i,name:"AST (liver/muscle enzyme)",what:"An enzyme found in the liver and muscles.",high:"A raised AST can be linked to the liver, but it is also commonly raised after intense exercise or muscle strain."},
 {re:/^gamma/i,name:"Gamma GT",what:"A liver enzyme that is sensitive to alcohol and some medicines.",high:"A raised Gamma GT is often linked to alcohol or fatty liver."},
 {re:/^bilirubin/i,name:"Bilirubin",what:"A yellow substance made when old red blood cells break down. The liver clears it.",high:"A mildly raised bilirubin is often due to Gilbert's syndrome, which is common and harmless."},
 {re:/^iron$/i,name:"Iron",what:"The amount of iron in your blood right now. It changes through the day and after meals."},
 {re:/^uibc/i,name:"UIBC",what:"Unsaturated iron-binding capacity: how much more iron your blood could carry.",high:"A raised UIBC can be an early sign of low iron stores, so it's best read alongside your ferritin."},
 {re:/^tibc/i,name:"TIBC",what:"Total iron-binding capacity: how much iron your blood is able to carry."},
 {re:/^transferrin sat/i,name:"Transferrin Saturation",what:"How much of your iron-carrying protein is actually carrying iron.",low:"A low saturation can mean low iron.",high:"A high saturation can mean too much iron."},
 {re:/^ferritin/i,name:"Ferritin (iron stores)",what:"Shows how much iron your body has stored.",low:"Low ferritin means your iron stores are low, a common cause of tiredness.",high:"High ferritin can be linked to inflammation, alcohol or iron overload."},
 {re:/oestradiol|estradiol/i,name:"Oestradiol",what:"The main form of oestrogen. In women, levels change through the monthly cycle.",low:"Low levels can be linked to menopause or low body weight.",high:"In men, raised levels can be linked to body fat or testosterone use."},
 {re:/^testosterone/i,name:"Testosterone",what:"The main male sex hormone, also present in women. It affects energy, mood, muscle and sex drive.",low:"A low testosterone can cause tiredness, low mood and low sex drive. Levels are highest in the morning, so your doctor may suggest a repeat test before 10am.",high:"A raised level is worth discussing with your doctor."},
 {re:/^haemoglobin/i,name:"Haemoglobin",what:"The protein in red blood cells that carries oxygen around your body.",low:"A low level can mean anaemia, which can cause tiredness and breathlessness.",high:"A high level can happen with dehydration, smoking or testosterone use."},
 {re:/^red cell count/i,name:"Red Cell Count",what:"The number of red blood cells, which carry oxygen."},
 {re:/^hct/i,name:"Haematocrit",what:"The proportion of your blood made up of red blood cells.",high:"A raised haematocrit can be linked to dehydration, smoking or testosterone use."},
 {re:/^mcv/i,name:"MCV (red cell size)",what:"The average size of your red blood cells.",low:"Small red cells can be a sign of low iron.",high:"Large red cells can be linked to low B12 or folate, or alcohol."},
 {re:/^mch$/i,name:"MCH",what:"The average amount of haemoglobin in each red blood cell."},
 {re:/^mchc/i,name:"MCHC",what:"How concentrated the haemoglobin is inside your red blood cells."},
 {re:/^rdw/i,name:"RDW",what:"How much your red blood cells vary in size."},
 {re:/^platelets/i,name:"Platelets",what:"Cells that help your blood to clot.",low:"Low platelets can make you bruise more easily.",high:"High platelets can follow infection, inflammation or low iron."},
 {re:/^mpv/i,name:"MPV (platelet size)",what:"The average size of your platelets."},
 {re:/^white cell count/i,name:"White Cell Count",what:"White blood cells fight infection.",low:"A low count can follow a recent viral infection and is often temporary.",high:"A raised count often means your body is fighting an infection or inflammation."},
 {re:/^neutrophils$/i,name:"Neutrophils",what:"The most common white blood cell, your first line of defence against bacteria.",low:"A mildly low neutrophil count is common after viral infections. It is also more common in people of African or Middle Eastern heritage, where it is usually harmless. Your doctor may repeat it.",high:"Raised neutrophils usually mean a bacterial infection or inflammation."},
 {re:/^lymphocytes$/i,name:"Lymphocytes",what:"White blood cells that fight viruses and make antibodies.",high:"Raised lymphocytes often follow a viral infection."},
 {re:/^monocytes$/i,name:"Monocytes",what:"White blood cells that clear up damaged cells and germs."},
 {re:/^eosinophils$/i,name:"Eosinophils",what:"White blood cells involved in allergies and fighting parasites.",high:"Raised eosinophils can be linked to allergies, asthma or eczema."},
 {re:/^basophils$/i,name:"Basophils",what:"A rare type of white blood cell involved in allergic reactions."},
 {re:/%$/,name:null,what:"The share of your white blood cells made up of this type. The actual count (above) is the more useful number."}
];
const SECTION_NAMES={"Biochemistry":"General Health","Urea & Electrolytes":"Kidney Health","Lipid Profile":"Heart Health (Cholesterol)","Thyroid Profile":"Thyroid","Vitamins":"Vitamins","Liver Function Test":"Liver Health","Iron Status Profile":"Iron Status","Sex Hormones":"Hormones","Haematology":"Full Blood Count","White Cell Differential":"White Blood Cells (Immunity)"};
function info(m){const L=LIB.find(l=>l.re.test(m.name))||{};return {name:L.name||m.name,what:L.what,low:L.low,high:L.high}}
function sectionName(s){return SECTION_NAMES[s]||s}

/* ============================================================
   INUVI PDF PARSER
   ============================================================ */
const SECTIONS=["Laboratory Information","Biochemistry","Urea & Electrolytes","Lipid Profile","Thyroid Profile","Vitamins","Liver Function Test","Iron Status Profile","Sex Hormones","Haematology","White Cell Differential","Bone Profile","Diabetes","Inflammation","Hormones","Kidney Function","Full Blood Count","Immunology","Serology","Prostate","Cardiac","Pancreas","Endocrinology","Tumour Markers"];
function inCommentLike(n){return /^(Please|Fasting|Male|Female|Follicular|Ovulation|Luteal|Post-meno)/i.test(n.trim())}
function parseInuvi(lines){
  const meta={},markers=[];let section="Other",inComment=false,last=null,started=false;
  const g=(re,s)=>{const m=s.match(re);return m?m[1].trim():null};
  const mrow=/^(.+?)\s+(?:([HL])\s+)?(\d+(?:\.\d+)?)\s*(?:([A-Za-zµ%\/\^0-9.]+(?:\/[0-9.a-z]+)?))?\s*(?:(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)|([<>])\s*(\d+(?:\.\d+)?))?\s*$/;
  const txtrow=/^(.+?)\s+([A-Z][A-Z ]{3,})$/;
  for(let raw of lines){
    const s=raw.replace(/\s+/g," ").trim(); if(!s||/^_+$/.test(s)) continue;
    let v;
    if(/Inuvi/i.test(s)) meta.lab="Inuvi Diagnostics";
    if((v=g(/Name:\s*(.+?)(?:\s+Specimen No:|$)/,s))&&!meta.name) meta.name=v;
    if((v=g(/Specimen No:\s*(\S+)/,s))&&!meta.specimen) meta.specimen=v;
    if((v=g(/DOB:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/,s))&&!meta.dob) meta.dob=v;
    if((v=g(/Collected:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/,s))&&!meta.collected) meta.collected=v;
    if((v=g(/Reported on:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/,s))&&!meta.reported) meta.reported=v;
    if((v=g(/Sex:\s*([MF])\b/,s))&&!meta.sex) meta.sex=v;
    if(/^Test\s+Result\s+Units/.test(s)){started=true;inComment=false;continue}
    if(!started) continue;
    if(/Authorised by|End of report/i.test(s)){started=false;inComment=false;continue}
    if(/^(FINAL REPORT|Page\(s\)|Key for report|#Referred|\*\*\*|Inuvi Diagnostics)/i.test(s)||/^Sample Specimen Type/i.test(s)) continue;
    const sec=SECTIONS.find(x=>x.toLowerCase()===s.toLowerCase());
    if(sec){if(sec!=="Laboratory Information")section=sec;inComment=false;last=null;continue}
    if(/^Comments\b/.test(s)){inComment=true;const rest=s.replace(/^Comments\s*/,"");if(rest&&last)(last.labNote=last.labNote||[]).push(rest);continue}
    const m=s.match(mrow);
    if(m && /[A-Za-z]{2}/.test(m[1]) && !/^[<>]/.test(m[1]) && !/:$/.test(m[1].trim()) && !inCommentLike(m[1])){
      const name=m[1].replace(/\*+/g,"").replace(/\s*\((?:g\/L|mmol\/mol)\)\s*$/i,"").replace(/\s+/g," ").trim();
      let min=null,max=null;
      if(m[5]!=null){min=+m[5];max=+m[6]} else if(m[7]==="<"){max=+m[8]} else if(m[7]===">"){min=+m[8]}
      last={name,value:+m[3],flag:m[2]||"",unit:m[4]||"",min,max,section};markers.push(last);inComment=false;continue;
    }
    const t=s.match(txtrow);
    if(t && !inComment && /^[A-Za-z]/.test(t[1])){last={name:t[1].replace(/\*+/g,"").trim(),value:null,text:t[2].trim(),unit:"",min:null,max:null,section};markers.push(last);continue}
    if(inComment&&last){(last.labNote=last.labNote||[]).push(s);continue}
    if(/^[A-Za-z][A-Za-z &\-\/]{2,40}$/.test(s)){section=s;last=null;continue}
  }
  return {meta,markers};
}
function itemsToLines(items){
  const its=items.filter(i=>i.s&&i.s.trim()).sort((a,b)=>b.y-a.y||a.x-b.x);
  const rows=[];
  for(const it of its){const r=rows.find(r=>Math.abs(r.y-it.y)<3);if(r)r.items.push(it);else rows.push({y:it.y,items:[it]})}
  rows.sort((a,b)=>b.y-a.y);
  return rows.map(r=>{const a=r.items.sort((p,q)=>p.x-q.x);let out="",end=null;
    for(const it of a){if(end!=null&&it.x-end>1)out+=" ";out+=it.s;end=it.x+(it.w||0)}return out.replace(/\s+/g," ").trim()});
}

/* ============================================================
   FILES: letters / PDFs and the in-portal viewer
   ============================================================ */
function b64ToBuf(b){const s=atob(b),u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u.buffer}
function fileKind(name){return /\.pdf$/i.test(name)?"pdf":/\.docx$/i.test(name)?"docx":/\.doc$/i.test(name)?"doc":"other"}
function sizeTxt(n){return n>1048576?(n/1048576).toFixed(1)+" MB":Math.max(1,Math.round(n/1024))+" KB"}
function fileIcon(name){const k=fileKind(name);return `<div class="file-ic ${k==="docx"||k==="doc"?"w":""}">${k==="pdf"?"PDF":k==="other"?"FILE":"DOC"}</div>`}
let FILES={},fileSeq=0;
function regFile(f){const id="F"+(++fileSeq);FILES[id]=f;return id}
async function readFileObj(f){return {name:f.name,size:f.size,buf:await f.arrayBuffer()}}
async function openViewer(id){
  const f=FILES[id]; if(!f) return toast("File not found.");
  const root=document.getElementById("modalRoot");
  root.innerHTML=`<div class="viewer-bg" onclick="if(event.target===this)closeModal()"><div class="viewer">
    <div class="viewer-head">${fileIcon(f.name)}<div><b>${esc(f.name)}</b><div class="small muted">${sizeTxt(f.size)}</div></div><div class="right row"><button class="btn ghost" onclick="downloadFile('${id}')">Download</button><button class="btn ghost" onclick="closeModal()">Close ✕</button></div></div>
    <div class="viewer-body" id="vbody"><p class="muted" style="text-align:center">Opening…</p></div></div></div>`;
  const B=document.getElementById("vbody"), k=fileKind(f.name);
  try{
    if(!f.buf){const {data,error}=await sb.storage.from(BUCKET).download(f.path);if(error)throw error;f.buf=await data.arrayBuffer();audit("opened_document",{patient_id:f.patientId,details:{name:f.name}})}
    if(k==="pdf"){
      if(!window.pdfjsLib) throw new Error("PDF viewer didn't load");
      pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      const pdf=await pdfjsLib.getDocument({data:f.buf.slice(0)}).promise; B.innerHTML="";
      for(let i=1;i<=pdf.numPages;i++){const pg=await pdf.getPage(i),vp=pg.getViewport({scale:1.6}),c=document.createElement("canvas");c.width=vp.width;c.height=vp.height;c.style.width=Math.min(vp.width/1.6*1.25,820)+"px";B.appendChild(c);await pg.render({canvasContext:c.getContext("2d"),viewport:vp}).promise}
    } else if(k==="docx"){
      if(!window.mammoth) throw new Error("Word viewer didn't load");
      const r=await mammoth.convertToHtml({arrayBuffer:f.buf.slice(0)});
      B.innerHTML=`<div class="docx-page">${r.value}</div>`;
    } else B.innerHTML=`<p class="muted" style="text-align:center">This file type can't be previewed here. Use the Download button above.</p>`;
  }catch(e){B.innerHTML=`<p class="muted" style="text-align:center">Sorry, this file couldn't be opened (${esc(e.message)}).</p>`}
}
function letterCard(r){if(!r.letter)return"";const f=FILES[r.letter];
  return `<div class="letter-card" onclick="event.stopPropagation()">${fileIcon(f.name)}<div><b>Letter from ${esc(r.doctor||"your doctor")}</b><div class="small muted">${esc(f.name)} · ${sizeTxt(f.size)}</div></div><button class="btn right" onclick="openViewer('${r.letter}')">Open letter</button></div>`}

/* ============================================================
   STATUS + RANGE LOGIC
   ============================================================ */
function statusOf(m){
  if(m.value==null||m.value===""||isNaN(+m.value)) return {key:"grey",label:m.text?"Not reported":"No value"};
  const v=+m.value, mn=m.min, mx=m.max;
  if(mn==null&&mx==null) return {key:"grey",label:"No range given"};
  if(mn!=null && v<mn) return {key:"red",label:"Low"};
  if(mx!=null && v>mx) return {key:"red",label:"High"};
  if(mn!=null && mx!=null){ const b=(mx-mn)*0.08; if(v<mn+b) return {key:"amber",label:"Low-normal",dir:"low"}; if(v>mx-b) return {key:"amber",label:"High-normal",dir:"high"}; }
  else if(mx!=null){ if(v>mx*0.92) return {key:"amber",label:"Near upper limit",dir:"high"}; }
  else if(mn!=null){ if(v<mn*1.08) return {key:"amber",label:"Near lower limit",dir:"low"}; }
  return {key:"green",label:"In range"};
}
function scale(m){
  const v=+m.value, mn=m.min, mx=m.max, clamp=x=>Math.max(1.5,Math.min(98.5,x));
  if(mn!=null && mx!=null){ const w=mx-mn||1, b=0.08;
    const pos = v<mn ? 20*Math.max(0,1-(mn-v)/(w*0.6)) : v>mx ? 80+20*Math.min(1,(v-mx)/(w*0.6)) : 20+60*(v-mn)/w;
    return {pos:clamp(pos),zones:[["red",20],["amber",60*b],["green",60*(1-2*b)],["amber",60*b],["red",20]],ticks:[[20,fmt(mn)],[80,fmt(mx)]]}; }
  if(mx!=null){ const pos = v<=mx ? 70*v/mx : 70+30*Math.min(1,(v-mx)/(mx*0.6));
    return {pos:clamp(pos),zones:[["green",70*0.92],["amber",70*0.08],["red",30]],ticks:[[70,"< "+fmt(mx)]]}; }
  if(mn!=null){ const pos = v<mn ? 30*v/mn : 30+70*Math.min(1,(v-mn)/(mn*1.5));
    return {pos:clamp(pos),zones:[["red",30],["amber",70*0.08],["green",70*0.92]],ticks:[[30,"> "+fmt(mn)]]}; }
  return null;
}
function fmt(n){return n==null?"":(+n).toString()}
const ZC={red:"#f2a8a3",amber:"#f5cf86",green:"#8fd6b0",grey:"#dde3ea"};
function rangeText(m){ if(m.min!=null&&m.max!=null) return `${m.min} – ${m.max}`; if(m.max!=null) return `below ${m.max}`; if(m.min!=null) return `above ${m.min}`; return "no range given"; }
function unitTxt(u){return (u||"").replace(/10\^9\/L/,"×10⁹/L").replace(/10\^12\/L/,"×10¹²/L").replace(/^ug\/L/,"µg/L").replace(/^umol\/L/,"µmol/L").replace("1.73m2","1.73m²").replace("mMol/Mol","mmol/mol")}
function barHTML(m){
  const st=statusOf(m); if(st.key==="grey") return `<div class="small muted">${m.text?esc(m.text.toLowerCase()):"No reference range on the lab report"}</div>`;
  const s=scale(m);
  return `<div class="bar-wrap"><div class="pin ${st.key==='red'?'out':''}" style="left:${s.pos}%"><b>${m.value}</b><i></i></div>
    <div class="bar">${s.zones.map(z=>`<span style="width:${z[1]}%;background:${ZC[z[0]]}"></span>`).join("")}</div>
    <div class="ticks">${s.ticks.map(t=>`<span style="left:${t[0]}%">${t[1]}</span>`).join("")}</div></div>`;
}
function counts(ms){const c={green:0,amber:0,red:0,grey:0};ms.forEach(m=>c[statusOf(m).key]++);return c}

const ICON={
  home:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  rep:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5M4 19h16M8 15l3-4 3 2 4-6"/></svg>',
  doc:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/></svg>',
  user:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
  up:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 16V4M6 10l6-6 6 6M4 20h16"/></svg>',
  users:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2.5.5 4 2.3 4 5.5"/></svg>',
  inbox:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h5l1 3h6l1-3h5"/></svg>'
};
/* ============================================================
   PATIENT VIEWS
   ============================================================ */
function released(p){return p.reports.filter(r=>r.status==="released").sort((a,b)=>b.date.localeCompare(a.date))}
function pDash(V){
  const reps=released(me), latest=reps[0];
  if(!latest){V.innerHTML=`<div class="top"><div><h1>Hello, ${esc(me.name.split(" ")[0])}</h1><p class="sub">Your results will appear here once your doctor has reviewed them.</p></div></div>`;return}
  const c=counts(latest.markers), flagged=latest.markers.filter(m=>["red","amber"].includes(statusOf(m).key)).sort((a,b)=>(statusOf(a).key==="red"?0:1)-(statusOf(b).key==="red"?0:1));
  V.innerHTML=`
  <div class="top"><div><h1>Hello, ${esc(me.name.split(" ")[0])}</h1><p class="sub">Your latest results are from <b>${dt(latest.date)}</b> and have been reviewed by ${esc(latest.doctor)}.</p></div>
    <button class="btn" onclick="go('report',{id:'${latest.id}',navParent:'reports'})">View full report</button></div>
  <div class="grid g4">
    <div class="card stat"><span class="k">Tests in latest report</span><span class="v">${latest.markers.length}</span></div>
    <div class="card stat green"><span class="k">In range</span><span class="v">${c.green}</span></div>
    <div class="card stat amber"><span class="k">Borderline</span><span class="v">${c.amber}</span></div>
    <div class="card stat red"><span class="k">Out of range</span><span class="v">${c.red}</span></div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h3>Results to look at</h3>
      ${flagged.length?flagged.map(m=>{const s=statusOf(m);return `<div class="flag-row">
        <div><b>${esc(info(m).name)}</b><div class="small muted">${m.value} ${unitTxt(m.unit)}</div></div>${barHTML(m)}<span class="chip ${s.key}">${s.label}</span></div>`}).join(""):`<p class="muted">Everything is within range.</p>`}
    </div>
    <div class="card"><h3>From your doctor</h3>
      <div class="doc-note"><div class="doc-av">${initials(latest.doctor)}</div><div style="flex:1"><b>${esc(latest.doctor)}</b><div class="small muted" style="margin-bottom:6px">${dt(latest.received)}</div>${latest.note?`<div style="font-size:14px">${esc(latest.note)}</div>`:""}${letterCard(latest)}</div></div>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><div class="row" style="margin-bottom:6px"><h3 style="margin:0">Your reports</h3><button class="btn ghost right" onclick="go('reports')">See all</button></div>${reps.map(repRow).join("")}</div>`;
}
function repRow(r){const c=counts(r.markers);return `<div class="rep-row" onclick="go('report',{id:'${r.id}',navParent:'reports'})">
  <div class="rep-ic">${ICON.rep}</div><div><div class="t">${esc(r.title)}</div><div class="small muted">${dt(r.date)} · ${r.markers.length} tests · Inuvi specimen ${esc(r.ref)}</div></div>
  <div class="chips"><span class="chip green">${c.green} in range</span>${c.amber?`<span class="chip amber">${c.amber} borderline</span>`:""}${c.red?`<span class="chip red">${c.red} out of range</span>`:""}</div></div>`}
function pReports(V){const reps=released(me);
  V.innerHTML=`<div class="top"><div><h1>My results</h1><p class="sub">All of your reports, newest first.</p></div></div><div class="card">${reps.length?reps.map(repRow).join(""):'<p class="muted">No reports yet.</p>'}</div>`;}
let filter="all";
function pReport(V){
  const r=me.reports.find(x=>x.id===ctx.id); if(!r) return go("reports"); logView(r);
  const c=counts(r.markers), ms=r.markers.filter(m=>filter==="all"||statusOf(m).key===filter), cats=[...new Set(ms.map(m=>m.section))];
  V.innerHTML=`<button class="back" onclick="go('reports')">← All results</button>
  <div class="top"><div><h1>${esc(r.title)}</h1><p class="sub">Sample taken ${dt(r.date)} · Inuvi Diagnostics specimen ${esc(r.ref)}${r.doctor?" · Reviewed by "+esc(r.doctor):""}</p></div>
    <button class="btn ghost" onclick="${r.labFile?`openViewer('${r.labFile}')`:`toast('In the live portal this opens the original Inuvi PDF.')`}">${ICON.doc} Original lab PDF</button></div>
  ${r.note||r.letter?`<div class="doc-note" style="margin-bottom:18px"><div class="doc-av">${initials(r.doctor)}</div><div style="flex:1"><b>From ${esc(r.doctor)}</b>${r.note?`<div style="font-size:14px;margin-top:4px">${esc(r.note)}</div>`:""}${letterCard(r)}</div></div>`:""}
  <div class="row" style="flex-wrap:wrap;gap:14px">
    <div class="filters">
      <button class="${filter==='all'?'on':''}" onclick="filter='all';render()">All (${r.markers.length})</button>
      <button class="${filter==='green'?'on':''}" onclick="filter='green';render()">In range (${c.green})</button>
      <button class="${filter==='amber'?'on':''}" onclick="filter='amber';render()">Borderline (${c.amber})</button>
      <button class="${filter==='red'?'on':''}" onclick="filter='red';render()">Out of range (${c.red})</button>
    </div>
    <div class="legend right"><span><i style="background:${ZC.green}"></i>Normal range</span><span><i style="background:${ZC.amber}"></i>Near the edge</span><span><i style="background:${ZC.red}"></i>Outside the range</span></div>
  </div>
  ${cats.map(cat=>`<div class="cat"><h4>${esc(sectionName(cat))}</h4>${ms.filter(m=>m.section===cat).map(m=>markerCard(m,me)).join("")}</div>`).join("")}
  <p class="small muted" style="margin-top:24px">Reference ranges come from Inuvi Diagnostics and can depend on your age and sex. A result outside the range isn't always a problem. Your doctor's comments explain what your results mean for you. Tap any result to see more.</p>`;
}
function markerCard(m,patient){
  const s=statusOf(m), I=info(m);
  const dir = s.label==="Low"||s.dir==="low" ? "low" : s.label==="High"||s.dir==="high" ? "high" : null;
  const msg = dir ? I[dir] : null;
  const hist = patient.reports.filter(x=>x.status==="released").sort((a,b)=>a.date.localeCompare(b.date)).map(x=>({d:x.date,m:x.markers.find(y=>y.name===m.name)})).filter(x=>x.m&&x.m.value!=null);
  return `<div class="marker" onclick="this.classList.toggle('open')">
    <div class="m-head">
      <div class="m-name">${esc(I.name)}<small>${I.name!==m.name?esc(m.name)+" · ":""}Range ${rangeText(m)} ${unitTxt(m.unit)}</small></div>
      <div class="m-val">${m.value!=null?m.value:"–"}<small>${unitTxt(m.unit)}</small></div>
      <div class="bar-cell">${barHTML(m)}</div>
      <div class="status-cell"><span class="chip ${s.key}">${s.label}</span></div>
    </div>
    <div class="m-detail">
      <div class="explain"><p><b>What is it?</b> ${esc(I.what||"A blood marker measured by the laboratory.")}</p>
        ${s.key==="green"?`<p><b>What does my result mean?</b> Your result is within the normal range.</p>`:msg?`<p><b>What does my result mean?</b> ${esc(msg)}</p>`:s.key==="grey"?"":`<p><b>What does my result mean?</b> Your result is ${s.label.toLowerCase()}. Please see your doctor's comments.</p>`}
        ${m.text?`<p><b>Lab note:</b> This test couldn't be reported (${esc(m.text.toLowerCase())}). Your clinic will let you know if it needs repeating.</p>`:""}
        ${m.labNote?`<p class="small"><b>Lab comment:</b> ${esc(m.labNote.join(" "))}</p>`:""}
        <p class="small muted">This is general information. Your doctor's comments are specific to you.</p></div>
      <div class="trend"><b class="small">Your trend</b>${trendSVG(hist,m)}</div>
    </div></div>`;
}
function trendSVG(hist,m){
  if(hist.length<2) return `<p class="small muted">A trend will show once you have more than one result for this test.</p>`;
  const vals=hist.map(h=>+h.m.value); const lo=Math.min(...vals,m.min??Infinity)*0.85, hi=Math.max(...vals,m.max??-Infinity)*1.1;
  const W=300,H=90,P=18, x=i=>P+i*(W-2*P)/(hist.length-1), y=v=>H-P-(v-lo)/((hi-lo)||1)*(H-2*P);
  const band=(m.min!=null||m.max!=null)?`<rect x="0" y="${y(m.max??hi)}" width="${W}" height="${Math.max(0,y(m.min??lo)-y(m.max??hi))}" fill="#e4f5ec"/>`:"";
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${band}
    <polyline fill="none" stroke="#0f2b46" stroke-width="2" points="${hist.map((h,i)=>x(i)+","+y(+h.m.value)).join(" ")}"/>
    ${hist.map((h,i)=>`<circle cx="${x(i)}" cy="${y(+h.m.value)}" r="4" fill="${{green:'#1f9d63',amber:'#d98a0b',red:'#d6453d'}[statusOf(h.m).key]||'#999'}"/><text x="${x(i)}" y="${y(+h.m.value)-8}" font-size="10" text-anchor="middle" fill="#334155">${h.m.value}</text><text x="${x(i)}" y="${H-3}" font-size="9" text-anchor="middle" fill="#64748b">${new Date(h.d).toLocaleDateString('en-GB',{month:'short',year:'2-digit'})}</text>`).join("")}
  </svg><div class="small muted">Green band = normal range</div>`;
}
function pDocs(V){
  V.innerHTML=`<div class="top"><div><h1>Documents</h1><p class="sub">Lab reports and letters from the clinic.</p></div></div>
  <div class="card">${me.docs.length?me.docs.map(d=>`<div class="doc-row">${fileIcon(d.name)}<div><b>${esc(d.name)}</b><div class="small muted">${dt(d.date)} · ${d.size} · Added by ${esc(d.by)}</div></div><button class="btn ghost right" onclick="openViewer('${d.file||""}')">Open</button></div>`).join(""):'<p class="muted">No documents yet.</p>'}</div>`;}
/* ============================================================
   CLINIC VIEWS
   ============================================================ */
function awaiting(){const out=[];db.patients.forEach(p=>p.reports.forEach(r=>{if(r.status==="awaiting")out.push({p,r})}));return out}
function flagChips(c){return `${c.red?`<span class="chip red">${c.red} out of range</span> `:""}${c.amber?`<span class="chip amber">${c.amber} borderline</span>`:""}${!c.red&&!c.amber?'<span class="chip green">All normal</span>':""}`}
function cHome(V){
  const q=awaiting(), recent=[];db.patients.forEach(p=>p.reports.filter(r=>r.status==="released").forEach(r=>recent.push({p,r})));recent.sort((a,b)=>b.r.received.localeCompare(a.r.received));
  V.innerHTML=`<div class="top"><div><h1>Review queue</h1><p class="sub">Reports read from Inuvi PDFs that a doctor needs to check before the patient can see them.</p></div>
    <button class="btn" onclick="go('upload')">${ICON.up} Upload lab report</button></div>
  <div class="grid g3">
    <div class="card stat amber"><span class="k">Awaiting doctor review</span><span class="v">${q.length}</span></div>
    <div class="card stat"><span class="k">Active patients</span><span class="v">${db.patients.length}</span></div>
    <div class="card stat green"><span class="k">Reports released</span><span class="v">${recent.length}</span></div></div>
  <div class="card" style="margin-top:16px"><h3>Awaiting review</h3>
  ${q.length?`<table><tr><th>Patient</th><th>Test</th><th>Received</th><th>Flags</th><th></th></tr>
   ${q.map(({p,r})=>`<tr class="click" onclick="go('review',{pid:'${p.id}',rid:'${r.id}',navParent:'clinic-home'})"><td><b>${esc(p.name)}</b><div class="small muted">${p.no} · DOB ${p.dob}</div></td><td>${esc(r.title)}<div class="small muted">Specimen ${esc(r.ref)}</div></td><td>${dt(r.received)}</td><td>${flagChips(counts(r.markers))}</td><td><button class="btn navy">Review</button></td></tr>`).join("")}</table>`:'<p class="muted">Nothing waiting. All caught up.</p>'}</div>
  <div class="card" style="margin-top:16px"><h3>Recently released</h3><table><tr><th>Patient</th><th>Test</th><th>Released</th><th>Reviewed by</th></tr>
  ${recent.slice(0,6).map(({p,r})=>`<tr class="click" onclick="go('patient',{pid:'${p.id}',navParent:'patients'})"><td><b>${esc(p.name)}</b></td><td>${esc(r.title)}</td><td>${dt(r.received)}</td><td>${esc(r.doctor)}</td></tr>`).join("")}</table></div>`;}
function cPatients(V){
  V.innerHTML=`<div class="top"><div><h1>Patients</h1><p class="sub">${db.patients.length} patients</p></div><button class="btn" onclick="newPatientModal()">+ New patient</button></div>
  <div class="card"><input class="inp" placeholder="Search by name, patient ID, email or date of birth…" style="margin-bottom:14px" oninput="const q=this.value.toLowerCase();document.querySelectorAll('.prow').forEach(r=>r.style.display=r.dataset.q.includes(q)?'':'none')"><table><tr><th>Name</th><th>Patient ID</th><th>Date of birth</th><th>Email</th><th>Reports</th></tr>
  ${db.patients.map(p=>`<tr class="click prow" data-q="${esc((p.name+" "+p.no+" "+p.email+" "+p.dob).toLowerCase())}" onclick="go('patient',{pid:'${p.id}',navParent:'patients'})"><td><b>${esc(p.name)}</b></td><td>${p.no}</td><td>${p.dob}</td><td>${esc(p.email)}</td><td>${p.reports.length}</td></tr>`).join("")}</table></div>`;}
let up={step:1,pid:null,file:null,markers:[],meta:{}};
function cUpload(V){
  const steps=["Upload Inuvi PDF","Read the report","Check & send to review"];
  V.innerHTML=`<div class="top"><div><h1>Upload lab report</h1><p class="sub">Drop in the PDF that Inuvi Diagnostics emailed you. The system reads every result, matches the patient and flags anything out of range, so nobody has to type results in.</p></div></div>
  <div class="steps">${steps.map((s,i)=>`<div class="step ${up.step===i+1?'on':up.step>i+1?'done':''}"><b>${up.step>i+1?'✓':i+1}</b>${s}</div>`).join("")}</div>
  <div class="card" id="upBody"></div>`;
  const B=document.getElementById("upBody");
  if(up.step===1){
    B.innerHTML=`<div class="drop" id="drop">
        <div style="font-size:34px">📄</div><p style="margin:6px 0 4px;font-weight:700">Drag the Inuvi PDF here</p><p class="small muted" style="margin:0 0 14px">or</p>
        <label class="btn navy">Choose PDF file<input type="file" accept="application/pdf" hidden onchange="pickFile(this.files[0])"></label>
        <p class="small muted" style="margin:18px auto 0;max-width:460px">Nothing is saved until you check the results and click <b>Send to doctor for review</b>.</p></div>`;
    const d=document.getElementById("drop");
    d.ondragover=e=>{e.preventDefault();d.classList.add("over")};d.ondragleave=()=>d.classList.remove("over");
    d.ondrop=e=>{e.preventDefault();d.classList.remove("over");pickFile(e.dataTransfer.files[0])};
  } else if(up.step===2){
    B.innerHTML=`<h3>Reading ${esc(up.file.name)}…</h3><div class="progress"><div id="prog"></div></div><div class="log" id="log"></div>`;
  } else renderUploadReview(B);
}
function pickFile(f){if(!f)return;if(f.type!=="application/pdf"&&!/\.pdf$/i.test(f.name))return toast("Please choose a PDF file.");up.file=f;up.step=2;render();readPdf(f)}
function logLine(t){const l=document.getElementById("log");if(l){l.textContent+=t+"\n";l.scrollTop=l.scrollHeight}}
function setProg(p){const e=document.getElementById("prog");if(e)e.style.width=p+"%"}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function readPdf(file){
  try{
    if(!window.pdfjsLib) throw new Error("the PDF reader didn't load");
    pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    logLine("Opening PDF…");setProg(8);
    up.buf=await file.arrayBuffer();
    const pdf=await pdfjsLib.getDocument({data:up.buf.slice(0)}).promise;
    logLine(`PDF has ${pdf.numPages} page(s)`);
    const lines=[];
    for(let i=1;i<=pdf.numPages;i++){
      const tc=await (await pdf.getPage(i)).getTextContent();
      lines.push(...itemsToLines(tc.items.map(it=>({s:it.str,x:it.transform[4],y:it.transform[5],w:it.width}))));
      setProg(8+40*i/pdf.numPages);
    }
    await runParse(lines,false);
  }catch(e){logLine("Sorry, this PDF couldn't be read ("+e.message+").");logLine("Please check it is the PDF Inuvi emailed you, then try again.");setProg(100);
    const B=document.getElementById("upBody");if(B)B.insertAdjacentHTML("beforeend",`<div class="row" style="margin-top:14px"><button class="btn ghost" onclick="up.step=1;render()">Back</button></div>`)}
}
function nameKey(n){return (n||"").toLowerCase().replace(/[^a-z ]/g,"").split(/\s+/).filter(Boolean).sort().join(" ")}
function normDob(d){const m=(d||"").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);return m?`${+m[1]}/${+m[2]}/${m[3].length===2?"19"+m[3]:m[3]}`:""}
async function runParse(lines,slow){
  const res=parseInuvi(lines); up.meta=res.meta; up.markers=res.markers;
  const say=async(t,p,ms)=>{logLine(t);if(p)setProg(p);if(slow)await wait(ms||300)};
  await say(res.meta.lab?"Recognised lab: Inuvi Diagnostics ✓":"Lab header not recognised. Reading results anyway…",55,400);
  if(res.meta.name) await say(`Patient on report: ${res.meta.name} · DOB ${res.meta.dob||"?"} · Sex ${res.meta.sex||"?"}`,60);
  if(res.meta.specimen) await say(`Specimen ${res.meta.specimen} · collected ${res.meta.collected||"?"} · reported ${res.meta.reported||"?"}`,65);
  const match=db.patients.find(p=>normDob(p.dob)===normDob(res.meta.dob)&&nameKey(p.name)===nameKey(res.meta.name));
  up.pid=match?match.id:(up.pid&&!res.meta.name?up.pid:null);
  await say(match?`Matched to existing patient ${match.name} (${match.id}) ✓`:"No existing patient with this name and date of birth. You can create one on the next screen.",70,450);
  await say("Reading results table…",72,250);
  for(const m of res.markers){logLine(`  ${statusOf(m).key==="red"?"⚑":"✓"} ${m.name}: ${m.value??m.text} ${m.unit}  (range ${rangeText(m)})`);if(slow)await wait(35)}
  const c=counts(res.markers);
  setProg(100);
  await say(res.markers.length?`Done: ${res.markers.length} results read. ${c.red} out of range, ${c.amber} borderline.`:"No results recognised in this PDF. Is it an Inuvi report?",100,900);
  if(!slow)await wait(900);
  if(res.markers.length){up.step=3;render()}
}
function renderUploadReview(B){
  const p=db.patients.find(x=>x.id===up.pid), c=counts(up.markers);
  B.innerHTML=`<div class="grid" style="grid-template-columns:1.2fr 1fr;gap:20px;margin-bottom:18px">
   <div><h3 style="margin:0 0 4px">Read from the PDF</h3>
    <p class="small muted" style="margin:0">Name on report: <b>${esc(up.meta.name||"–")}</b> · DOB <b>${esc(up.meta.dob||"–")}</b> · Sex ${esc(up.meta.sex||"–")}<br>Specimen ${esc(up.meta.specimen||"–")} · Collected ${esc(up.meta.collected||"–")} · Reported ${esc(up.meta.reported||"–")}</p>
    <div style="margin-top:10px">${flagChips(c)} <span class="chip grey">${up.markers.length} results</span></div></div>
   <div><div class="field" style="margin:0"><label>Patient record</label>
    <select class="inp" onchange="if(this.value==='__new')newPatientModal({name:titleName(up.meta.name),dob:up.meta.dob,fromUpload:true});else{up.pid=this.value;render()}">
     <option value="" ${!p?"selected":""} disabled>Choose patient…</option>
     ${db.patients.map(x=>`<option value="${x.id}" ${p&&p.id===x.id?"selected":""}>${esc(x.name)} · ${x.dob}</option>`).join("")}
     <option value="__new">+ Create new patient from this report</option></select></div>
    ${p?`<p class="small" style="color:var(--green);margin:6px 0 0">✓ Will be added to ${esc(p.name)}'s record</p>`:`<p class="small" style="color:#a86a05;margin:6px 0 0">No matching patient. Choose one or create a new one.</p>`}
    <div class="field" style="margin:12px 0 0"><label>Test / package name</label><input class="inp" id="upTitle" value="${esc(up.meta.title||guessTitle(up.markers))}" onchange="up.meta.title=this.value"></div></div></div>
  ${reviewTable(up.markers,"up")}
  <div class="row" style="margin-top:12px"><button class="btn ghost" onclick="up.markers.push({name:'',value:'',unit:'',min:null,max:null,section:'Other'});render()">+ Add a result</button></div>
  <div class="row" style="margin-top:22px;border-top:1px solid var(--line);padding-top:18px"><button class="btn ghost" onclick="up={step:1,pid:null,file:null,markers:[],meta:{}};render()">Start again</button>
  <button class="btn right" ${p?"":"disabled"} onclick="saveUpload()">Send to doctor for review →</button></div>`;
}
function titleName(n){if(!n)return"";const parts=n.split(/\s+/);const sur=parts.shift();return [...parts,sur].map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(" ")}
function guessTitle(ms){const secs=new Set(ms.map(m=>m.section));if(secs.size>=8)return"Advanced Health Check";if(secs.has("Sex Hormones"))return"Hormone Check";if(secs.has("Lipid Profile"))return"Cholesterol Check";return"Blood Test"}
function reviewTable(markers,src){
  let lastSec=null;
  return `<table><tr><th>Test (as on Inuvi report)</th><th>Result</th><th>Unit</th><th>Min</th><th>Max</th><th style="width:26%">Where it falls</th><th>Status</th><th></th></tr>
  ${markers.map((m,i)=>{const s=statusOf(m);const head=m.section!==lastSec?`<tr><td colspan="8" style="background:#f6f9fb;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)">${esc(m.section)}</td></tr>`:"";lastSec=m.section;
   return head+`<tr><td><input value="${esc(m.name)}" onchange="editM('${src}',${i},'name',this.value)">${m.labNote?`<div class="small muted" style="margin-top:3px">Lab comment attached</div>`:""}</td>
   <td><input class="num" value="${m.value??""}" placeholder="${m.text?esc(m.text):"–"}" onchange="editM('${src}',${i},'value',this.value)">${m.flag?`<div class="small" style="color:var(--red);font-weight:700">Lab flag: ${m.flag}</div>`:""}</td>
   <td style="white-space:nowrap" class="small">${unitTxt(m.unit)}</td>
   <td><input class="num" value="${m.min??''}" placeholder="–" onchange="editM('${src}',${i},'min',this.value)"></td>
   <td><input class="num" value="${m.max??''}" placeholder="–" onchange="editM('${src}',${i},'max',this.value)"></td>
   <td>${barHTML(m)}</td><td><span class="chip ${s.key}">${s.label}</span></td>
   <td><button class="back" style="margin:0;color:var(--red)" title="Remove" onclick="delM('${src}',${i})">✕</button></td></tr>`}).join("")}</table>`;
}
function listFor(src){if(src==="up")return up.markers;const p=db.patients.find(x=>x.id===ctx.pid);return p.reports.find(r=>r.id===ctx.rid).markers}
function editM(src,i,k,v){const m=listFor(src)[i];
  if(src!=="up"){const n=document.getElementById("docNote");if(n)ctx.draft=n.value}
  if(k==="name")m.name=v; else if(k==="value"){m.value=v===""?null:parseFloat(v);if(v!=="")delete m.text} else m[k]=v===""?null:parseFloat(v);
  m.flag="";render();}
function delM(src,i){if(src!=="up"){const n=document.getElementById("docNote");if(n)ctx.draft=n.value}listFor(src).splice(i,1);render()}/* =====================================================================
   PATIENT: profile + view logging
   ===================================================================== */
const viewed=new Set();
function logView(r){if(viewed.has(r.id))return;viewed.add(r.id);audit("viewed_report",{patient_id:me.id,report_id:r.id})}
function pProfile(V){
  V.innerHTML=`<div class="top"><div><h1>My details</h1><p class="sub">To change your name, date of birth or contact details, please contact the clinic.</p></div></div>
  <div class="grid g2"><div class="card">
    <div class="field"><label>Full name</label><input class="inp" value="${esc(me.name)}" disabled></div>
    <div class="field"><label>Patient ID</label><input class="inp" value="${esc(me.no)}" disabled></div>
    <div class="field"><label>Date of birth</label><input class="inp" value="${esc(me.dob)}" disabled></div>
    <div class="field"><label>Email</label><input class="inp" value="${esc(me.email)}" disabled></div>
    <div class="field" style="margin:0"><label>Mobile</label><input class="inp" value="${esc(me.phone||"–")}" disabled></div>
    <p class="small muted" style="margin:14px 0 0">Need to update something? Call <b>${CLINIC_PHONE}</b> or email <b>${CLINIC_EMAIL}</b>.</p></div>
  <div class="card"><h3>Password</h3><p class="small muted">Use at least 10 characters. Don't reuse a password from another site.</p>
    <button class="btn ghost" onclick="changePwModal()">Change password</button>
    <h3 style="margin-top:24px">${NB?"App settings":"Use the portal like an app"}</h3>${installHelp()}
    <h3 style="margin-top:24px">Your data</h3><p class="small muted">You can ask for a copy of your data at any time by emailing <b>${CLINIC_EMAIL}</b>.</p>
    <h3 style="margin-top:24px">Delete your portal account</h3><p class="small muted">This permanently deletes your login. Your clinical records are kept securely by the clinic for 8 years, as the law requires, and you can still get your results by contacting us.</p>
    <button class="btn ghost" style="color:var(--red);border-color:#f3c9c6" onclick="deleteAccountModal()">Delete my account</button></div></div>`;
}
function deleteAccountModal(){
  modal(`<h3>Delete your portal account?</h3><p class="small muted">You won't be able to sign in any more. Your results stay with the clinic, and you can create a new account later with the same email address.</p>
   <div class="field"><label>Type DELETE to confirm</label><input class="inp" id="delConfirm" autocomplete="off"></div>
   <div class="row"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn right" style="background:var(--red)" onclick="deleteAccount()">Delete my account</button></div>`);
}
async function deleteAccount(){
  if($("delConfirm").value.trim().toUpperCase()!=="DELETE") return toast("Please type DELETE to confirm.");
  await guard(async()=>{
    must(await sb.rpc("delete_my_account"),"Couldn't delete your account");
    closeModal(); try{await sb.auth.signOut()}catch(e){}
    role=null;me=null;showLogin();loginMsg("Your account has been deleted","Your portal login has been removed. If you need your results in future, please contact us on <b>"+CLINIC_PHONE+"</b>.");
  },"Deleting…");
}
function changePwModal(){
  modal(`<h3>Change password</h3><form onsubmit="event.preventDefault();savePw()">
   <div class="field"><label>New password</label><input class="inp" type="password" id="np1" autocomplete="new-password" minlength="10" required></div>
   <div class="field"><label>Confirm new password</label><input class="inp" type="password" id="np2" autocomplete="new-password" minlength="10" required></div>
   <div class="row"><button type="button" class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn right">Save password</button></div></form>`);
}
async function savePw(){
  const a=$("np1").value,b=$("np2").value; if(a.length<10)return toast("Please use at least 10 characters."); if(a!==b)return toast("The two passwords don't match.");
  await guard(async()=>{must(await sb.auth.updateUser({password:a}),"Couldn't change password");closeModal();toast("Password changed.")});
}

/* =====================================================================
   CLINIC: patient record
   ===================================================================== */
function cPatient(V){
  const p=db.patients.find(x=>x.id===ctx.pid); if(!p) return go("patients");
  V.innerHTML=`<button class="back" onclick="go('patients')">← Patients</button>
  <div class="top"><div><h1>${esc(p.name)}</h1><p class="sub">${p.no} · DOB ${p.dob}${p.sex?" · "+(p.sex==="F"?"Female":"Male"):""} · ${esc(p.email||"no email")} · ${esc(p.phone||"no mobile")}</p>
     <div style="margin-top:8px">${p.user_id?'<span class="chip green">Portal account active</span>':'<span class="chip amber">Not signed up to the portal yet</span>'}</div></div>
   <div class="row"><button class="btn ghost" onclick="editPatientModal('${p.id}')">Edit details</button>${p.user_id?"":`<button class="btn ghost" onclick="inviteModal('${p.id}')">Invite to portal</button>`}<button class="btn" onclick="up={step:1,pid:'${p.id}',file:null,markers:[],meta:{}};go('upload',{navParent:'upload'})">${ICON.up} Upload report</button></div></div>
  <div class="card"><h3>Reports</h3>${p.reports.length?`<table><tr><th>Test</th><th>Sample date</th><th>Status</th><th>Flags</th></tr>${p.reports.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(r=>`<tr class="click" onclick="go('review',{pid:'${p.id}',rid:'${r.id}',navParent:'patients'})"><td><b>${esc(r.title)}</b><div class="small muted">Specimen ${esc(r.ref||"–")}</div></td><td>${dt(r.date)}</td><td>${r.status==="released"?'<span class="chip green">Released to patient</span>':'<span class="chip amber">Awaiting review</span>'}</td><td>${flagChips(counts(r.markers))}</td></tr>`).join("")}</table>`:'<p class="muted">No reports yet. Upload an Inuvi PDF to add one.</p>'}</div>
  <div class="card" style="margin-top:18px"><h3>Documents</h3>${p.docs.length?p.docs.map(d=>`<div class="doc-row">${fileIcon(d.name)}<div><b>${esc(d.name)}</b><div class="small muted">${dt(d.date)} · ${d.size} · ${esc(d.by)}${d.kind==="lab_report"?" · Lab report":d.kind==="letter"?" · Doctor's letter":""}</div></div><div class="right row"><button class="btn ghost" onclick="openViewer('${d.file}')">Open</button>${d.kind==="other"?`<button class="btn ghost" style="color:var(--red)" onclick="removeDoc('${p.id}','${d.docId}')">Remove</button>`:""}</div></div>`).join(""):'<p class="muted">None.</p>'}
   <div style="margin-top:12px"><label class="btn ghost" style="display:inline-flex">+ Upload document for patient<input type="file" accept=".pdf,.docx" hidden onchange="addDoc('${p.id}',this)"></label>
   <span class="small muted" style="margin-left:8px">The patient can see documents you add here.</span></div></div>`;
}
async function addDoc(pid,inp){const f=inp.files[0];if(!f)return;
  await guard(async()=>{await uploadFile(pid,"docs",f,null,"other",null,true);await reloadPatient(pid);audit("uploaded_document",{patient_id:pid,details:{name:f.name}});toast("Document added to the patient's record.");render()},"Uploading…")}
async function removeDoc(pid,docId){
  if(!await confirmBox("Remove this document? The patient will no longer see it."))return;
  await guard(async()=>{await deleteDocument(docId);await reloadPatient(pid);audit("removed_document",{patient_id:pid});render()},"Removing…")}
function confirmBox(msg){return new Promise(res=>{window._cb=v=>{closeModal();res(v)};modal(`<h3>Are you sure?</h3><p>${esc(msg)}</p><div class="row"><button class="btn ghost" onclick="_cb(false)">Cancel</button><button class="btn right" onclick="_cb(true)">Yes, continue</button></div>`)})}
function inviteText(p){const url=SITE_URL;return `Hello ${p.name.split(" ")[0]}, your Prime Life Diagnostics results will be available in our secure patient portal.\n\n1. Go to ${url}\n2. Choose "Create account"\n3. Use this email address: ${p.email}\n4. Click the link in the confirmation email, then sign in.\n\nAny questions, call us on ${CLINIC_PHONE}.`}
function inviteModal(pid){const p=db.patients.find(x=>x.id===pid);
  if(!p.email) return toast("Add an email address for this patient first (Edit details).");
  modal(`<h3>Invite ${esc(p.name)} to the portal</h3><p class="small muted">Send this by text, WhatsApp or email. The patient must sign up with <b>${esc(p.email)}</b> so their account links to this record automatically.</p>
   <textarea class="inp" id="invTxt" rows="9" readonly>${esc(inviteText(p))}</textarea>
   <div class="row" style="margin-top:12px"><button class="btn ghost" onclick="closeModal()">Close</button><button class="btn right" onclick="navigator.clipboard.writeText($('invTxt').value).then(()=>toast('Copied.'),()=>toast('Select the text and copy it.'))">Copy message</button></div>`)}
function patientForm(p={}){return `
  <div class="field"><label>Full name</label><input class="inp" id="npName" value="${esc(p.name||"")}" placeholder="e.g. Emma Wilson"></div>
  <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px"><div class="field"><label>Date of birth</label><input class="inp" id="npDob" value="${esc(p.dob&&p.dob!=="–"?p.dob:"")}" placeholder="DD/MM/YYYY"></div>
   <div class="field"><label>Sex</label><select class="inp" id="npSex"><option value="">–</option><option value="F" ${p.sex==="F"?"selected":""}>Female</option><option value="M" ${p.sex==="M"?"selected":""}>Male</option></select></div></div>
  <div class="field"><label>Email (used for their portal login)</label><input class="inp" id="npEmail" type="email" value="${esc(p.email||"")}" placeholder="name@example.com"></div>
  <div class="field"><label>Mobile</label><input class="inp" id="npPhone" value="${esc(p.phone||"")}" placeholder="07…"></div>`}
function readPatientForm(){const name=$("npName").value.trim(),dobTxt=$("npDob").value.trim(),dob=isoFromUk(dobTxt);
  if(!name){toast("Please enter a name.");return null} if(dobTxt&&!dob){toast("Please enter the date of birth as DD/MM/YYYY.");return null}
  return {full_name:name,dob,sex:$("npSex").value||null,email:$("npEmail").value.trim().toLowerCase()||null,phone:$("npPhone").value.trim()||null}}
function newPatientModal(pref={}){
  modal(`<h3>New patient</h3>${patientForm({name:pref.name,dob:pref.dob,sex:pref.sex})}
  <div class="row"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn right" onclick="createPatient(${pref.fromUpload?"true":"false"})">Create patient</button></div>`)}
async function createPatient(fromUpload){const v=readPatientForm();if(!v)return;
  await guard(async()=>{
    const row=must(await sb.from("patients").insert(v).select().single(),"Couldn't create patient");
    await reloadPatient(row.id); audit("created_patient",{patient_id:row.id}); closeModal();
    toast(`${v.full_name} added.`);
    if(fromUpload){up.pid=row.id;render()} else go("patient",{pid:row.id,navParent:"patients"});
  })}
function editPatientModal(pid){const p=db.patients.find(x=>x.id===pid);
  modal(`<h3>Edit patient details</h3>${patientForm(p)}<div class="row"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn right" onclick="savePatient('${pid}')">Save</button></div>`)}
async function savePatient(pid){const v=readPatientForm();if(!v)return;
  await guard(async()=>{must(await sb.from("patients").update(v).eq("id",pid),"Couldn't save");await reloadPatient(pid);audit("edited_patient",{patient_id:pid});closeModal();toast("Saved.");render()})}

/* =====================================================================
   CLINIC: save an uploaded Inuvi report
   ===================================================================== */
async function saveUpload(){
  const p=db.patients.find(x=>x.id===up.pid); if(!p) return toast("Choose a patient first.");
  const valid=up.markers.filter(m=>m.name); if(!valid.length) return toast("Add at least one result first.");
  const title=($("upTitle")||{}).value||guessTitle(valid);
  await guard(async()=>{
    const rep=must(await sb.from("reports").insert({patient_id:p.id,title,specimen_no:up.meta.specimen||null,collected_on:isoFromUk(up.meta.collected),reported_on:isoFromUk(up.meta.reported),status:"awaiting"}).select().single(),"Couldn't save report");
    await saveResults(rep.id,valid);
    if(up.buf) await uploadFile(p.id,rep.id,{name:up.file.name,size:up.file.size,type:"application/pdf"},up.buf,"lab_report",rep.id,true);
    audit("uploaded_report",{patient_id:p.id,report_id:rep.id,details:{specimen:up.meta.specimen,results:valid.length}});
    await reloadPatient(p.id);
    up={step:1,pid:null,file:null,markers:[],meta:{}};
    toast("Report saved and added to the review queue.");
    go("review",{pid:p.id,rid:rep.id,navParent:"clinic-home"});
  },"Saving report…");
}

/* =====================================================================
   CLINIC: doctor review, letter and release
   ===================================================================== */
function doctorOptions(r){
  const docs=staffList.filter(s=>s.role==="doctor").map(s=>s.full_name);
  if(me.role==="doctor"&&!docs.includes(me.name))docs.unshift(me.name);
  if(r.doctor&&!docs.includes(r.doctor))docs.unshift(r.doctor);
  const sel=r.doctor||(me.role==="doctor"?me.name:docs[0]);
  return docs.map(n=>`<option ${n===sel?"selected":""}>${esc(n)}</option>`).join("")||`<option>${esc(me.name)}</option>`;
}
function cReview(V){
  const p=db.patients.find(x=>x.id===ctx.pid), r=p&&p.reports.find(x=>x.id===ctx.rid); if(!r) return go("clinic-home");
  const c=counts(r.markers), isRel=r.status==="released", L=r.letter?FILES[r.letter]:null;
  V.innerHTML=`<button class="back" onclick="go('clinic-home')">← Review queue</button>
  <div class="top"><div><h1>${esc(p.name)} · ${esc(r.title)}</h1><p class="sub">${p.no} · DOB ${p.dob} · Sample ${dt(r.date)} · Inuvi specimen ${esc(r.ref||"–")}</p></div>
   <div class="row">${r.labFile?`<button class="btn ghost" onclick="openViewer('${r.labFile}')">${ICON.doc} Lab PDF</button>`:""}${isRel?'<span class="chip green">Released to patient</span>':'<span class="chip amber">Awaiting doctor review</span>'}</div></div>
  <div class="grid g3" style="margin-bottom:18px">
   <div class="card stat green"><span class="k">In range</span><span class="v">${c.green}</span></div>
   <div class="card stat amber"><span class="k">Borderline</span><span class="v">${c.amber}</span></div>
   <div class="card stat red"><span class="k">Out of range</span><span class="v">${c.red}</span></div></div>
  <div class="card" style="margin-bottom:18px"><h3>Doctor's comments to the patient</h3>
   <div class="grid" style="grid-template-columns:1fr 1fr 220px;gap:16px">
    <div><label>Doctor's letter (Word or PDF)</label>
     ${L?`<div class="letter-card" style="margin-top:0">${fileIcon(L.name)}<div><b style="word-break:break-all">${esc(L.name)}</b><div class="small muted">${sizeTxt(L.size)}</div></div>
       <div class="row" style="gap:6px"><button class="btn ghost" onclick="openViewer('${r.letter}')">Preview</button><button class="btn ghost" style="color:var(--red)" onclick="removeLetter()">Remove</button></div></div>`
     :`<div class="letter-drop" id="letterDrop"><p style="margin:0 0 8px;font-weight:600">Drag the letter here</p>
       <label class="btn navy">Choose .docx or .pdf<input type="file" accept=".pdf,.docx" hidden onchange="attachLetter(this.files[0])"></label>
       <p class="small muted" style="margin:8px 0 0">The patient opens it straight from their report.</p></div>`}</div>
    <div><label>Short message (optional)</label>
     <textarea class="inp" id="docNote" rows="5" placeholder="e.g. Please read my letter for full details.">${esc(ctx.draft??r.note)}</textarea>
     <button class="btn ghost small" style="margin-top:8px" onclick="suggestNote()">Suggest a draft</button></div>
    <div><div class="field"><label>Reviewed by</label><select class="inp" id="docName">${doctorOptions(r)}</select></div></div></div>
   <div class="row" style="margin-top:18px"><button class="btn ghost" onclick="go('patient',{pid:'${p.id}',navParent:'patients'})">View patient record</button>
    <button class="btn ghost right" onclick="saveReview(false)">Save changes</button>
    <button class="btn" onclick="saveReview(true)">${isRel?'Update released report':'Approve &amp; release to patient'}</button></div></div>
  <div class="card"><h3>Results</h3><p class="small muted" style="margin-top:-8px">Edit any value or range if it was read incorrectly, then click Save changes.</p>${reviewTable(r.markers,"rev")}</div>`;
  wireLetterDrop();
}
function curReport(){const p=db.patients.find(x=>x.id===ctx.pid);return {p,r:p.reports.find(x=>x.id===ctx.rid)}}
function keepDraft(){const n=$("docNote");if(n)ctx.draft=n.value}
async function attachLetter(f){
  if(!f)return; const k=fileKind(f.name);
  if(k==="doc") return toast("Please save it as .docx (Word: File › Save As › Word Document) or as a PDF.");
  if(k!=="pdf"&&k!=="docx") return toast("Please choose a Word (.docx) or PDF file.");
  keepDraft(); const {p,r}=curReport();
  await guard(async()=>{
    if(r.letterDocId) await deleteDocument(r.letterDocId);
    await uploadFile(p.id,r.id,f,null,"letter",r.id,true);
    audit("attached_letter",{patient_id:p.id,report_id:r.id,details:{name:f.name}});
    await reloadPatient(p.id); toast("Letter attached."); render();
  },"Uploading letter…");
}
async function removeLetter(){keepDraft();const {p,r}=curReport();if(!r.letterDocId)return;
  await guard(async()=>{await deleteDocument(r.letterDocId);await reloadPatient(p.id);render()},"Removing…")}
function wireLetterDrop(){const d=$("letterDrop");if(!d)return;d.ondragover=e=>{e.preventDefault();d.classList.add("over")};d.ondragleave=()=>d.classList.remove("over");d.ondrop=e=>{e.preventDefault();d.classList.remove("over");attachLetter(e.dataTransfer.files[0])}}
function suggestNote(){
  const {p,r}=curReport();
  const out=r.markers.filter(m=>statusOf(m).key==="red"), bord=r.markers.filter(m=>statusOf(m).key==="amber"), nr=r.markers.filter(m=>m.text);
  let t=`Hello ${p.name.split(" ")[0]}, thank you for your blood test. `;
  if(!out.length&&!bord.length) t+="All of your results are within the normal range, which is reassuring. ";
  else{ if(out.length) t+=`These results are outside the normal range: ${out.map(m=>`${info(m).name} (${statusOf(m).label.toLowerCase()})`).join(", ")}. `;
    if(bord.length) t+=`These are within range but close to the limit: ${bord.map(m=>info(m).name).join(", ")}. `; }
  if(nr.length) t+=`The lab couldn't report ${nr.map(m=>m.name).join(", ")} on this sample. `;
  t+="[Add your advice and any next steps here.]";
  $("docNote").value=t; toast("Draft added. Please edit it before releasing.");
}
async function saveReview(releaseIt){
  const {p,r}=curReport();
  const note=$("docNote").value.trim(), doctor=$("docName").value;
  if(releaseIt){
    if(!note&&!r.letter) return toast("Please attach a letter or write a short message first.");
    if(/\[Add your advice/.test(note)) return toast("Please replace the [Add your advice…] placeholder first.");
    if(!r.markers.length) return toast("This report has no results.");
  }
  await guard(async()=>{
    await saveResults(r.id,r.markers);
    const upd={note:note||null,doctor_name:doctor};
    if(releaseIt&&r.status!=="released"){upd.status="released";upd.released_at=new Date().toISOString();upd.released_by=(await sb.auth.getUser()).data.user.id}
    must(await sb.from("reports").update(upd).eq("id",r.id),"Couldn't save report");
    audit(releaseIt?"released_report":"saved_review",{patient_id:p.id,report_id:r.id});
    delete ctx.draft; const fresh=await reloadPatient(p.id);
    if(releaseIt){
      modal(`<h3>Report released ✓</h3><p>${esc(p.name)} can now see this report${fresh.reports.find(x=>x.id===r.id)?.letter?" and your letter":""} when they sign in to the portal.</p>
       ${p.user_id?"":`<p class="small" style="color:#a86a05">${esc(p.name)} hasn't created a portal account yet. Use <b>Invite to portal</b> on their record to send them the sign-up steps.</p>`}
       <p class="small muted">Tip: let the patient know their results are ready (by text or email), without including any results in the message.</p>
       <div class="row"><button class="btn ghost" onclick="closeModal();go('clinic-home')">Back to queue</button><button class="btn right" onclick="closeModal();go('patient',{pid:'${p.id}',navParent:'patients'})">Open patient record</button></div>`);
    } else {toast("Changes saved.");render()}
  },releaseIt?"Releasing…":"Saving…");
}
/* =====================================================================
   PHONE APP EXTRAS (only active inside the iPhone / Android app)
   - push notifications ("Your results are ready")
   - Face ID / fingerprint unlock
   On the website none of this runs.
   ===================================================================== */
const BIO_KEY="plp_biometric_v1", TOKEN_KEY="plp_push_token_v1", LOCK_AFTER_MS=60*1000;
function lsGet(k){try{return localStorage.getItem(k)}catch(e){return null}}
function lsSet(k,v){try{v==null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch(e){}}
let bioAvailable=false, pausedAt=0, locked=false;

async function nativeInit(){
  if(!NB) return;
  document.documentElement.classList.add("in-app");
  const back=$("backLink"); if(back) back.classList.add("hidden");
  try{bioAvailable=await NB.biometryAvailable()}catch(e){bioAvailable=false}
  // tapping a notification opens that report
  NB.onPushTap(async data=>{
    if(role!=="patient"||!me) return;
    await refreshPatient();
    if(data&&data.report_id&&me.reports.find(r=>r.id===data.report_id)) go("report",{id:data.report_id,navParent:"reports"}); else go("dashboard");
  });
  NB.onTokenRefresh(t=>{if(role==="patient")saveDeviceToken(t)});
  // lock again after the app has been in the background for a while
  NB.onPause(()=>{pausedAt=Date.now()});
  NB.onResume(async()=>{
    if(!role) return;
    if(lsGet(BIO_KEY)==="1"&&bioAvailable&&pausedAt&&Date.now()-pausedAt>LOCK_AFTER_MS){
      if(!(await nativeUnlockGate())) return logout();
    }
    if(role==="patient"&&me){await refreshPatient();render()}
  });
  try{NB.hideSplash()}catch(e){}
}
async function refreshPatient(){
  try{const rows=must(await sb.from("patients").select(PATIENT_SELECT),"Refreshing");if(rows.length){FILES={};me=toPatient(rows[0])}}catch(e){}
}

/* ---------- Face ID / fingerprint ---------- */
async function nativeUnlockGate(){
  if(!NB||lsGet(BIO_KEY)!=="1"||!bioAvailable) return true;
  if(locked) return false; locked=true;
  try{
    showLogin(); loginMsg("Unlock Prime Life","Use Face ID, Touch ID or your fingerprint to open your results.",false);
    $("msgBody").insertAdjacentHTML("beforeend",`<div style="margin-top:18px"><button class="btn block" id="unlockBtn">Unlock</button><p style="text-align:center;margin:14px 0 0"><button class="linkbtn" id="unlockOut">Sign in with password instead</button></p></div>`);
    const ok=await new Promise(res=>{
      const tryIt=async()=>{if(await NB.biometricUnlock("Unlock your Prime Life results"))res(true)};
      $("unlockBtn").onclick=tryIt; $("unlockOut").onclick=()=>res(false); tryIt();
    });
    if(ok&&role) showApp();
    return ok;
  } finally { locked=false }
}
function biometricName(){return /iphone|ipad/i.test(navigator.userAgent)?"Face ID / Touch ID":"fingerprint or face unlock"}
function offerBiometrics(){
  if(!bioAvailable||lsGet(BIO_KEY)!=null) return;
  modal(`<h3>Unlock faster next time?</h3><p class="small muted">Use ${biometricName()} to open the app instead of typing your password. You can change this in My details.</p>
   <div class="row"><button class="btn ghost" onclick="lsSet(BIO_KEY,'0');closeModal()">Not now</button><button class="btn right" onclick="enableBiometrics()">Turn on</button></div>`);
}
async function enableBiometrics(){
  if(await NB.biometricUnlock("Confirm it's you")){lsSet(BIO_KEY,"1");closeModal();toast("Turned on.");if(page==="profile")render()}
  else toast("Couldn't confirm. Please try again.");
}
function disableBiometrics(){lsSet(BIO_KEY,"0");toast("Turned off.");render()}

/* ---------- push notifications ---------- */
async function saveDeviceToken(token){
  if(!token) return;
  try{must(await sb.rpc("register_device",{p_token:token,p_platform:NB.platform}),"Notifications");lsSet(TOKEN_KEY,token)}catch(e){console.warn(e)}
}
async function enableNotifications(fromButton){
  try{
    const token=await NB.pushToken();
    if(!token){ if(fromButton) toast("Notifications are switched off for this app in your phone's Settings."); return }
    await saveDeviceToken(token); if(fromButton){toast("Notifications turned on.");render()}
  }catch(e){ if(fromButton) toast("Couldn't turn on notifications.") }
}
async function nativeAfterPatientSignIn(){
  await enableNotifications(false);
  setTimeout(offerBiometrics,800);
}
async function nativeBeforeSignOut(){
  const t=lsGet(TOKEN_KEY);
  if(t){try{await sb.rpc("unregister_device",{p_token:t})}catch(e){} lsSet(TOKEN_KEY,null)}
  lsSet(BIO_KEY,null);
}
function nativeSettingsHtml(){
  const bioOn=lsGet(BIO_KEY)==="1", pushOn=!!lsGet(TOKEN_KEY);
  return `<p class="small muted" style="margin-bottom:10px"><b>Notifications:</b> ${pushOn?"on. We'll tell you when results are ready (never the results themselves).":"off."}</p>
   ${pushOn?"":`<button class="btn ghost" onclick="enableNotifications(true)">Turn on notifications</button>`}
   ${bioAvailable?`<p class="small muted" style="margin:16px 0 10px"><b>Unlock with ${biometricName()}:</b> ${bioOn?"on":"off"}</p>
   ${bioOn?`<button class="btn ghost" onclick="disableBiometrics()">Turn off</button>`:`<button class="btn ghost" onclick="enableBiometrics()">Turn on</button>`}`:""}`;
}
const nativeReady = NB ? nativeInit().catch(()=>{}) : Promise.resolve();
/* =====================================================================
   INSTALL AS AN APP (home-screen / PWA)
   ===================================================================== */
let installEvt=null;
addEventListener("beforeinstallprompt",e=>{e.preventDefault();installEvt=e;if(page==="profile")render()});
function isStandalone(){return matchMedia("(display-mode: standalone)").matches||navigator.standalone===true}
function installHelp(){
  if(NB) return nativeSettingsHtml();
  if(isStandalone()) return `<p class="small muted">You're using the Prime Life app. ✓</p>`;
  if(installEvt) return `<p class="small muted">Add the portal to your home screen so it opens like an app.</p><button class="btn navy" onclick="installEvt.prompt();installEvt.userChoice.finally(()=>{installEvt=null;render()})">Install the app</button>`;
  const ios=/iphone|ipad|ipod/i.test(navigator.userAgent);
  return `<div class="install-tip">${ios?"On iPhone or iPad: open this page in <b>Safari</b>, tap the <b>Share</b> button, then <b>Add to Home Screen</b>.":"On Android: open the browser menu (⋮) and tap <b>Install app</b> or <b>Add to Home screen</b>. On a computer, look for the install icon in the address bar."}</div>`;
}
if(!NB && "serviceWorker" in navigator) addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));

nativeReady.then(boot);
