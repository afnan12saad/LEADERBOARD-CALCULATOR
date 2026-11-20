import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { doc, getDoc, getDocs, collection, setDoc, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore';
const env = await initializeTestEnvironment({ projectId: 'demo-arena', firestore: { rules: readFileSync('firestore.rules','utf8'), host: '127.0.0.1', port: 8085 } });
let pass=0,fail=0; const ok=(n,c)=>{console.log(c?'PASS':'FAIL',n);c?pass++:fail++;};
const N_JUDGES=300, N_TEAMS=15; // 4500 ratings, far beyond one 500-write batch
await env.clearFirestore();
await env.withSecurityRulesDisabled(async c=>{const d=c.firestore();
  await setDoc(doc(d,'admins','adm'),{uid:'adm',email:'a@x.com',name:'A',createdAt:Timestamp.now()});
  await setDoc(doc(d,'settings','event'),{resultsPublished:true});
  for(let t=0;t<N_TEAMS;t++) await setDoc(doc(d,'teams','t'+t),{id:'t'+t,name:'Team '+t,projectTitle:'P',description:'',logoUrl:'',presentationStatus:'Completed',orderIndex:t+1,tieBreakerRank:t+1,submittedCount:N_JUDGES,createdAt:Timestamp.now(),updatedAt:Timestamp.now()});
  let b=writeBatch(d),k=0;
  for(let j=0;j<N_JUDGES;j++){ for(let t=0;t<N_TEAMS;t++){ b.set(doc(d,'evaluations',`J${j}_t${t}`),{id:`J${j}_t${t}`,judgeId:'J'+j,judgeUid:'u'+j,teamId:'t'+t,rating:4,comment:'',createdAt:Timestamp.now(),updatedAt:Timestamp.now()}); if(++k===400){await b.commit();b=writeBatch(d);k=0;} } b.set(doc(d,'judges','J'+j),{id:'J'+j,uid:'u'+j}); k++; }
  await b.commit();
});
const ctx=(uid,email,v=true)=>env.authenticatedContext(uid,{email,email_verified:v,firebase:{sign_in_provider:'password'}}).firestore();
const adm=ctx('adm','afnan12saad@gmail.com'); // bootstrapped admin email, also has admins doc
const evs=await getDocs(collection(adm,'evaluations'));
ok(`admin can list all ratings (${evs.size})`, evs.size===N_JUDGES*N_TEAMS);
// archive write by admin
const archive=(db,id,over={})=>setDoc(doc(db,'eventArchives',id),{eventName:'Demo',archivedAt:serverTimestamp(),archivedBy:'a@x.com',totalJudges:N_JUDGES,totalTeams:N_TEAMS,totalSubmissions:evs.size,entries:[{rank:1,teamName:'Team 0',averageFormatted:'4.00'}],...over});
await assertSucceeds(archive(adm,'ev_1')).then(()=>ok('admin can write an archive',true)).catch(e=>ok('admin can write an archive :: '+e.message.slice(0,80),false));
ok('archive reads back', (await getDoc(doc(adm,'eventArchives','ev_1'))).exists());
await assertFails(archive(adm,'ev_2',{extra:'x'})).then(()=>ok('archive with unexpected field rejected',true)).catch(()=>ok('archive with unexpected field rejected',false));
await assertFails(setDoc(doc(adm,'eventArchives','ev_1'),{eventName:'tamper'})).then(()=>ok('archive cannot be edited',true)).catch(()=>ok('archive cannot be edited',false));
const {deleteDoc}=await import('firebase/firestore');
await assertFails(deleteDoc(doc(adm,'eventArchives','ev_1'))).then(()=>ok('archive cannot be deleted',true)).catch(()=>ok('archive cannot be deleted',false));
const judge=env.authenticatedContext('u1').firestore(); const stranger=ctx('s','s@x.com');
for(const [n,db] of [['anonymous judge',judge],['verified non-admin',stranger],['visitor',env.unauthenticatedContext().firestore()]]){
  await assertFails(getDoc(doc(db,'eventArchives','ev_1'))).then(()=>ok(n+' cannot read archives',true)).catch(()=>ok(n+' cannot read archives',false));
  await assertFails(archive(db,'ev_x')).then(()=>ok(n+' cannot create archives',true)).catch(()=>ok(n+' cannot create archives',false));
}
// chunked reset as the service does it: 400 deletes per batch, then one small final batch
const all=[...(await getDocs(collection(adm,'evaluations'))).docs,...(await getDocs(collection(adm,'judges'))).docs,...(await getDocs(collection(adm,'teams'))).docs].map(d=>d.ref);
let chunks=0; try{ for(let i=0;i<all.length;i+=400){const c=writeBatch(adm); all.slice(i,i+400).forEach(r=>c.delete(r)); await c.commit(); chunks++;} ok(`chunked delete of ${all.length} docs in ${chunks} batches succeeds`, true);}catch(e){ok('chunked delete :: '+e.message.slice(0,90),false);}
const left=(await getDocs(collection(adm,'evaluations'))).size+(await getDocs(collection(adm,'judges'))).size+(await getDocs(collection(adm,'teams'))).size;
ok('ratings, judges and teams are gone after the reset (left='+left+')', left===0);
const fb=writeBatch(adm);
for(let t=1;t<=15;t++) fb.set(doc(adm,'teams','team-'+t),{id:'team-'+t,name:'Team '+String(t).padStart(2,'0'),projectTitle:'Project '+t,description:'',logoUrl:'',presentationStatus:'Waiting',orderIndex:t,tieBreakerRank:t,submittedCount:0,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
fb.set(doc(adm,'settings','event'),{eventName:'E',collegeName:'C',tagline:'',venue:'',eventDate:'',customDomain:'',submissionsOpen:true,editingAllowed:false,resultsPublished:false,tieBreakerMode:'tie',currentTeamId:'',timerDurationSeconds:0,timerWarningSeconds:0,timerRemainingSeconds:0,timerRunning:false,timerStartedAtMs:0,updatedAt:serverTimestamp()});
fb.set(doc(adm,'publicStats','summary'),{totalJudges:0,updatedAt:serverTimestamp()});
fb.set(doc(adm,'publicResults','leaderboard'),{published:false,totalJudges:0,totalTeams:15,totalSubmissions:0,entries:[],updatedAt:serverTimestamp()});
await assertSucceeds(fb.commit()).then(()=>ok('final batch (15 fresh teams, settings, counters) accepted by the rules',true)).catch(e=>ok('final batch :: '+e.message.slice(0,90),false));
ok('admin account still exists after the reset', (await getDoc(doc(adm,'admins','adm'))).exists());
ok('archive survives the reset', (await getDoc(doc(adm,'eventArchives','ev_1'))).exists());
console.log(`${pass} passed, ${fail} failed`); await env.cleanup(); process.exit(fail?1:0);
