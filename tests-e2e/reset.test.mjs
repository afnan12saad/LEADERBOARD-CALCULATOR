// Run from the repo root (needs @firebase/rules-unit-testing, firebase, esbuild installed):
//   node tests-e2e/build.mjs && npx firebase emulators:exec --only firestore --project demo-arena "node tests-e2e/reset.test.mjs"
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { updateDoc, increment, serverTimestamp, doc, getDoc, getDocs, collection, setDoc, writeBatch, Timestamp } from 'firebase/firestore';
import { archiveAndStartNewEvent, initializeEverythingToZeroWith15Teams, listEventArchives, getResetState, setDb } from './svc.mjs';
const env = await initializeTestEnvironment({ projectId: 'demo-arena', firestore: { rules: readFileSync('firestore.rules','utf8'), host: '127.0.0.1', port: 8085 } });
let pass=0,fail=0; const ok=(n,c)=>{console.log(c?'PASS':'FAIL',n);c?pass++:fail++;};
const cnt=async(db,c)=>(await getDocs(collection(db,c))).size;
const settings={eventName:'Demo Fest',collegeName:'C',tagline:'',venue:'',eventDate:'',customDomain:'',submissionsOpen:true,editingAllowed:false,resultsPublished:true,tieBreakerMode:'tie',currentTeamId:'',timerDurationSeconds:0,timerWarningSeconds:0,timerRemainingSeconds:0,timerRunning:false,timerStartedAtMs:0};
async function seed(nj,nt){
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c=>{const d=c.firestore();
    await setDoc(doc(d,'admins','adm'),{uid:'adm',email:'a@x.com',name:'A',createdAt:Timestamp.now()});
    await setDoc(doc(d,'settings','event'),{...settings,updatedAt:Timestamp.now()});
    for(let t=0;t<nt;t++) await setDoc(doc(d,'teams','t'+t),{id:'t'+t,name:'Team '+t,projectTitle:'P'+t,description:'',logoUrl:'',presentationStatus:'Completed',orderIndex:t+1,tieBreakerRank:t+1,submittedCount:nj,createdAt:Timestamp.now(),updatedAt:Timestamp.now()});
    let b=writeBatch(d),k=0;
    for(let j=0;j<nj;j++){ for(let t=0;t<nt;t++){ b.set(doc(d,'evaluations',`J${j}_t${t}`),{id:`J${j}_t${t}`,judgeId:'J'+j,judgeUid:'u'+j,teamId:'t'+t,rating:(t%5)+1,comment:'',createdAt:Timestamp.now(),updatedAt:Timestamp.now()}); if(++k===400){await b.commit();b=writeBatch(d);k=0;} } b.set(doc(d,'judges','J'+j),{id:'J'+j,uid:'u'+j,email:'j'+j+'@x.com'}); k++; if(k>=400){await b.commit();b=writeBatch(d);k=0;} }
    await b.commit();
  });
}
const ctx=(uid,email)=>env.authenticatedContext(uid,{email,email_verified:true,firebase:{sign_in_provider:'password'}}).firestore();
// 1. full flow
await seed(300,15); const adm=ctx('adm','afnan12saad@gmail.com'); setDb(adm);
const id=await archiveAndStartNewEvent(settings,'a@x.com');
const arch=await getDoc(doc(adm,'eventArchives',id));
ok('archive exists with 4500 ratings and 15 entries', arch.exists()&&arch.data().totalSubmissions===4500&&arch.data().entries.length===15&&arch.data().totalJudges===300);
ok('archive holds no emails/raw ratings', !JSON.stringify(arch.data()).includes('@x.com')||arch.data().archivedBy==='a@x.com' && !JSON.stringify(arch.data().entries).includes('@'));
ok('ratings cleared', await cnt(adm,'evaluations')===0); ok('judges cleared', await cnt(adm,'judges')===0);
ok('15 fresh teams with 0 submitted', (await getDocs(collection(adm,'teams'))).docs.every(d=>d.data().submittedCount===0)&&await cnt(adm,'teams')===15);
ok('admin account kept', (await getDoc(doc(adm,'admins','adm'))).exists());
const ev=(await getDoc(doc(adm,'settings','event'))).data();
ok('submissions reopened, results unpublished', ev.submissionsOpen===true&&ev.resultsPublished===false);
const list=await listEventArchives();
ok('admin UI list returns the archive', list.length===1&&list[0].id===id&&list[0].entries.length===15&&list[0].archivedAtMs>0);
setDb(env.authenticatedContext('u1').firestore());
let denied=false; try{await listEventArchives();}catch{denied=true}
ok('judge cannot list archives', denied);
// 2. non-admin cannot run it, nothing lost
await seed(20,15); setDb(env.authenticatedContext('u1').firestore());
let threw=false; try{await archiveAndStartNewEvent(settings,'x');}catch{threw=true}
ok('non-admin run fails', threw); ok('data intact after failed run', await cnt(adm,'evaluations')===300);
// 3. ratings changed after archive: reset refuses, nothing deleted
setDb(adm); threw=false; try{await initializeEverythingToZeroWith15Teams(settings,{expectedRatingCount:299});}catch(e){threw=/changed/.test(e.message)}
ok('reset aborts if rating count differs from archive', threw&&await cnt(adm,'evaluations')===300&&await cnt(adm,'judges')===20);
// 4. archive failure (101 teams exceeds archive rule): nothing reset, submissions reopened
await seed(2,101); setDb(adm); threw=false; try{await archiveAndStartNewEvent(settings,'a@x.com');}catch{threw=true}
const ev4=(await getDoc(doc(adm,'settings','event'))).data();
ok('archive failure aborts reset', threw&&await cnt(adm,'evaluations')===202&&await cnt(adm,'teams')===101&&await cnt(adm,'eventArchives')===0);
ok('submissions reopened after failed archive', ev4.submissionsOpen===true);
// 5. lock released after failed archive
ok('no reset marker left after failed archive', (await getResetState())===null);
// 6. normal rating works before closing; identical operation denied after closing (create and edit)
await seed(2,3);
await env.withSecurityRulesDisabled(async c=>{const d=c.firestore();
  await setDoc(doc(d,'settings','event'),{...settings,submissionsOpen:true,editingAllowed:true,updatedAt:Timestamp.now()});
  for(const u of ['u9','u8']){const J='J'+u.slice(1); await setDoc(doc(d,'judges',J),{id:J,judgeCode:J,name:'n',department:'',email:u+'@x.com',uid:u,active:true,createdAt:Timestamp.now(),updatedAt:Timestamp.now()}); await setDoc(doc(d,'judgeSessions',u),{uid:u,judgeId:J,accessCode:'SELF_AUTH',createdAt:Timestamp.now()});}});
const rate=async(u,team,rating)=>{const db=env.authenticatedContext(u).firestore(); const J='J'+u.slice(1); const b=writeBatch(db);
  b.set(doc(db,'evaluations',`${J}_${team}`),{id:`${J}_${team}`,judgeId:J,judgeUid:u,teamId:team,rating,comment:'',createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
  b.update(doc(db,'teams',team),{submittedCount:increment(1),updatedAt:serverTimestamp()}); await b.commit();};
const edit=(u,team,rating)=>{const db=env.authenticatedContext(u).firestore(); const J='J'+u.slice(1); return updateDoc(doc(db,'evaluations',`${J}_${team}`),{rating,updatedAt:serverTimestamp()});};
let okc=true; try{await rate('u9','t0',4);}catch(e){okc=false;}
ok('judge rating create succeeds while open', okc);
okc=true; try{await edit('u9','t0',5);}catch(e){okc=false;}
ok('judge rating edit succeeds while open and editing allowed', okc);
await env.withSecurityRulesDisabled(async c=>updateDoc(doc(c.firestore(),'settings','event'),{submissionsOpen:false,updatedAt:Timestamp.now()}));
let d1=false; try{await rate('u8','t0',4);}catch{d1=true}
ok('identical create denied after closing', d1);
let d2=false; try{await edit('u9','t0',1);}catch{d2=true}
ok('edit denied after closing', d2);
// 7. resume: crash after deleting began. Original archive reused, no second archive, completes, reopens.
await seed(5,15); setDb(adm);
const archId=await (async()=>{ // make a real archive of this event via the service archiver path
  const {archiveCurrentEventResults}=await import('./svc.mjs'); return archiveCurrentEventResults(settings,'a@x.com');})();
await env.withSecurityRulesDisabled(async c=>{const d=c.firestore();
  await setDoc(doc(d,'eventResets','current'),{status:'deleting',archiveId:archId,expectedRatingCount:75,startedBy:'a@x.com',updatedAtMs:Date.now()-10*60*1000});
  await setDoc(doc(d,'settings','event'),{...settings,submissionsOpen:false,updatedAt:Timestamp.now()});
  const ev=await getDocs(collection(d,'evaluations')); const b=writeBatch(d); ev.docs.slice(0,40).forEach(x=>b.delete(x.ref)); await b.commit();}); // partial deletion
const rs=await getResetState(); ok('reset-in-progress state is visible to admin', rs&&rs.status==='deleting'&&rs.archiveId===archId);
const idr=await archiveAndStartNewEvent({...settings,submissionsOpen:false},'a@x.com');
ok('resume reuses the original archive', idr===archId&&await cnt(adm,'eventArchives')===1);
const a1=(await getDoc(doc(adm,'eventArchives',archId))).data();
ok('original archive still holds the full 75 ratings (not partial)', a1.totalSubmissions===75);
ok('resume finished: ratings/judges gone, marker removed, submissions open', await cnt(adm,'evaluations')===0&&await cnt(adm,'judges')===0&&(await getResetState())===null&&(await getDoc(doc(adm,'settings','event'))).data().submissionsOpen===true);
// 8. concurrent attempt blocked by a fresh marker; data untouched
await seed(5,15); await env.withSecurityRulesDisabled(async c=>setDoc(doc(c.firestore(),'eventResets','current'),{status:'archiving',archiveId:'',expectedRatingCount:0,startedBy:'other@x.com',updatedAtMs:Date.now()}));
let blk=false; try{await archiveAndStartNewEvent(settings,'a@x.com');}catch(e){blk=/already running/.test(e.message)}
ok('second concurrent reset is refused', blk&&await cnt(adm,'evaluations')===75&&await cnt(adm,'eventArchives')===0);
// 9. two simultaneous starts: exactly one proceeds
await seed(5,15);
const pA=archiveAndStartNewEvent(settings,'a@x.com'); await new Promise(r=>setTimeout(r,150)); const pB=archiveAndStartNewEvent(settings,'b@x.com'); const rr=await Promise.allSettled([pA,pB])
ok('second reset started while the first is running is refused', rr.filter(r=>r.status==='fulfilled').length===1);
ok('and exactly one archive exists', await cnt(adm,'eventArchives')===1);
// 11. judge registration is blocked while a reset marker exists, allowed otherwise
await seed(1,3);
const reg=(uid)=>{const db=env.authenticatedContext(uid).firestore(); const id='J_'+uid.toUpperCase(); const b=writeBatch(db);
  b.set(doc(db,'judges',id),{id,judgeCode:id,name:'N',department:'',email:uid+'@x.com',uid,active:true,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
  b.set(doc(db,'judgeSessions',uid),{uid,judgeId:id,accessCode:'SELF_AUTH',createdAt:serverTimestamp()});
  b.set(doc(db,'publicStats','summary'),{totalJudges:increment(1),updatedAt:serverTimestamp()},{merge:true}); return b.commit();};
let r1=true; try{await reg('nj1');}catch{r1=false}
ok('judge can register when no reset is running', r1);
await env.withSecurityRulesDisabled(async c=>setDoc(doc(c.firestore(),'eventResets','current'),{status:'deleting',archiveId:'x',expectedRatingCount:0,startedBy:'a',owner:'o',updatedAtMs:Date.now()}));
let r2=false; try{await reg('nj2');}catch{r2=true}
ok('judge registration blocked while a reset is running', r2);
// 12. takeover: the original run stops before its next delete once its marker owner changed
await seed(300,15); setDb(adm);
const run=archiveAndStartNewEvent(settings,'a@x.com').then(()=>'done',e=>e.message);
for(let k=0;k<400;k++){ const n=await cnt(adm,'evaluations'); if(n<4500&&n>0) break; await new Promise(r=>setTimeout(r,25)); }
await env.withSecurityRulesDisabled(async c=>updateDoc(doc(c.firestore(),'eventResets','current'),{owner:'someone-else'}));
const outcome=await run; const left=await cnt(adm,'evaluations');
ok('original run stops after another session takes over ('+outcome.slice(0,40)+', '+left+' ratings left)', /taken over/.test(outcome)&&left>0);
// 10. non-admin cannot touch the marker
const nb=env.authenticatedContext('u1').firestore(); let nd=false; try{await getDoc(doc(nb,'eventResets','current'));}catch{nd=true}
ok('non-admin cannot read reset marker', nd);
console.log(`${pass} passed, ${fail} failed`); await env.cleanup(); process.exit(fail?1:0);
