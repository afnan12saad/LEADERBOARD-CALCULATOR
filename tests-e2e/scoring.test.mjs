// node tests-e2e/build.mjs && npx firebase emulators:exec --only firestore --project demo-arena "node tests-e2e/scoring.test.mjs"
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { doc, getDoc, getDocs, collection, setDoc, Timestamp } from 'firebase/firestore';
import { archiveAndStartNewEvent, submitCriteriaScores, listEventArchives, setDb } from './svc.mjs';
const env = await initializeTestEnvironment({ projectId: 'demo-arena', firestore: { rules: readFileSync('firestore.rules','utf8'), host: '127.0.0.1', port: 8085 } });
let pass=0,fail=0; const ok=(n,c)=>{console.log(c?'PASS':'FAIL',n);c?pass++:fail++;};
const cnt=async(db,c)=>(await getDocs(collection(db,c))).size;
const settings={eventName:'Mixed Fest',collegeName:'C',tagline:'',venue:'',eventDate:'',customDomain:'',submissionsOpen:true,editingAllowed:false,resultsPublished:false,tieBreakerMode:'tie',currentTeamId:'',timerDurationSeconds:0,timerWarningSeconds:0,timerRemainingSeconds:0,timerRunning:false,timerStartedAtMs:0};
const now=()=>Timestamp.now();
const ev=(j,t,x)=>({id:`${j}_${t}`,judgeId:j,judgeUid:'u'+j,teamId:t,comment:'',createdAt:now(),updatedAt:now(),...x});
const v2=(j,t,c)=>ev(j,t,{scoreVersion:2,criteria:c,total:Object.values(c).reduce((a,b)=>a+b,0)});
const Z={c1:0,c2:0,c3:0,c4:0,c5:0}, F={c1:5,c2:5,c3:5,c4:5,c5:5}, M={c1:4,c2:3,c3:4,c4:3,c5:4};
async function seed(evals){
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c=>{const d=c.firestore();
    await setDoc(doc(d,'admins','adm'),{uid:'adm',email:'a@x.com',name:'A',createdAt:now()});
    await setDoc(doc(d,'settings','event'),{...settings,updatedAt:now()});
    for(const t of ['t1','t2','t3']) await setDoc(doc(d,'teams',t),{id:t,name:'Team '+t,projectTitle:'P'+t,description:'',logoUrl:'',presentationStatus:'Completed',orderIndex:+t[1],tieBreakerRank:+t[1],submittedCount:0,createdAt:now(),updatedAt:now()});
    for(const j of ['J1','J2','J3']) await setDoc(doc(d,'judges',j),{id:j,uid:'u'+j,email:j+'@x.com',name:j,active:true});
    for(const e of evals) await setDoc(doc(d,'evaluations',e.id),e);
  });
}
const adm=env.authenticatedContext('adm',{email:'afnan12saad@gmail.com',email_verified:true,firebase:{sign_in_provider:'password'}}).firestore(); setDb(adm);

// A. v2 only, incl. an all-zero team
await seed([v2('J1','t1',F),v2('J2','t1',M),v2('J1','t2',Z),v2('J2','t2',Z)]);
let id=await archiveAndStartNewEvent(settings,'a@x.com');
let a=(await getDoc(doc(adm,'eventArchives',id))).data();
const e1=a.entries.find(e=>e.teamName==='Team t1'), e2=a.entries.find(e=>e.teamName==='Team t2'), e3=a.entries.find(e=>e.teamName==='Team t3');
ok('v2 archive records scale /25 and no legacy', a.scoreMax===25&&a.legacyMax===5&&a.legacyRatings===0);
ok('v2 average of totals (25 and 18) = 21.50', e1.averageFormatted==='21.50'&&e1.submittedCount===2);
ok('all-zero team is scored 0.00 with 2 submissions, ranks above unscored team', e2.averageFormatted==='0.00'&&e2.submittedCount===2&&e2.rank<e3.rank&&e3.submittedCount===0);
ok('reset finished: ratings gone', await cnt(adm,'evaluations')===0);

// B. mixed legacy + v2 on the same team
await seed([ev('J1','t1',{rating:5}),ev('J2','t1',{rating:4}),v2('J3','t1',M),ev('J1','t2',{rating:3}),v2('J1','t3',F)]);
id=await archiveAndStartNewEvent(settings,'a@x.com');
a=(await getDoc(doc(adm,'eventArchives',id))).data();
const m1=a.entries.find(e=>e.teamName==='Team t1'), m2=a.entries.find(e=>e.teamName==='Team t2'), m3=a.entries.find(e=>e.teamName==='Team t3');
ok('mixed: archive says 3 old ratings and 5 total submissions', a.legacyRatings===3&&a.totalSubmissions===5);
ok('mixed: t1 /25 average counts only the v2 score (18.00), old 1-5 avg kept separately (4.50, 2 ratings)', m1.averageFormatted==='18.00'&&m1.submittedCount===1&&m1.legacyAverageFormatted==='4.50'&&m1.legacyCount===2);
ok('mixed: legacy-only team has 0 scored, old avg 3.00 kept, not labelled /25', m2.submittedCount===0&&m2.averageFormatted==='0.00'&&m2.legacyAverageFormatted==='3.00'&&m2.legacyCount===1);
ok('mixed: v2-only team has no legacy', m3.legacyCount===0&&m3.legacyAverageFormatted===''&&m3.averageFormatted==='25.00');
ok('mixed: nothing converted - listEventArchives returns the scale fields', (await listEventArchives()).some(x=>x.scoreMax===25&&x.legacyMax===5&&x.legacyRatings===3));
ok('mixed: old ratings were archived before deletion, then cleared by the reset (as designed)', await cnt(adm,'evaluations')===0);

// C. judge submits via the service: all zero, then max; rules accept
await seed([]);
await env.withSecurityRulesDisabled(async c=>{const d=c.firestore(); await setDoc(doc(d,'judgeSessions','uJ1'),{uid:'uJ1',judgeId:'J1',accessCode:'SELF_AUTH',createdAt:now()}); await setDoc(doc(d,'judges','J1'),{id:'J1',judgeCode:'J1',name:'n',department:'',email:'j1@x.com',uid:'uJ1',active:true,createdAt:now(),updatedAt:now()});});
const jdb=env.authenticatedContext('uJ1').firestore(); setDb(jdb);
let zOk=true; try{await submitCriteriaScores({judgeId:'J1',judgeUid:'uJ1',teamId:'t1',criteria:Z,comment:'',isEdit:false});}catch(e){zOk=false; console.log(e.message.slice(0,120));}
ok('judge can submit an all-zero scorecard via the service', zOk);
await env.withSecurityRulesDisabled(async c=>{const s=await getDoc(doc(c.firestore(),'evaluations','J1_t1')); ok('stored: scoreVersion 2, total 0, five zero criteria', s.data().scoreVersion===2&&s.data().total===0&&Object.values(s.data().criteria).every(v=>v===0)&&s.data().rating===undefined);});
let badOk=false; try{await submitCriteriaScores({judgeId:'J1',judgeUid:'uJ1',teamId:'t2',criteria:{...F,c3:6},comment:'',isEdit:false}); badOk=true;}catch{}
ok('service rejects an out-of-range score (6)', !badOk);
let partial=false; try{await submitCriteriaScores({judgeId:'J1',judgeUid:'uJ1',teamId:'t2',criteria:{c1:3,c2:3},comment:'',isEdit:false}); partial=true;}catch{}
ok('service rejects a scorecard with missing criteria', !partial);
console.log(`${pass} passed, ${fail} failed`); await env.cleanup(); process.exit(fail?1:0);
