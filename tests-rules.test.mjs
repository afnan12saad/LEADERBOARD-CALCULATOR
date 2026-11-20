import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { doc, getDoc, setDoc, writeBatch, increment, serverTimestamp, Timestamp } from 'firebase/firestore';
const env = await initializeTestEnvironment({ projectId: 'demo-arena', firestore: { rules: readFileSync('firestore.rules','utf8'), host: '127.0.0.1', port: 8085 } });
let pass=0, fail=0;
const ok=(n,c)=>{ console.log(c?'PASS':'FAIL',n); c?pass++:fail++; };
async function seed(total){ await env.clearFirestore(); await env.withSecurityRulesDisabled(async c=>{ const d=c.firestore();
  if(total!==null) await setDoc(doc(d,'publicStats','summary'),{totalJudges:total,updatedAt:Timestamp.now()});
  await setDoc(doc(d,'settings','event'),{resultsPublished:true,submissionsOpen:true});
  await setDoc(doc(d,'publicResults','leaderboard'),{published:true,totalJudges:1,totalTeams:1,totalSubmissions:1,entries:[],updatedAt:Timestamp.now()}); }); }
const register=(uid,mode,readVal)=>{ const db=env.authenticatedContext(uid).firestore(); const id='J_'+uid.toUpperCase(); const b=writeBatch(db);
  b.set(doc(db,'judges',id),{id,judgeCode:id,name:'N',department:'',email:uid+'@x.com',uid,active:true,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
  b.set(doc(db,'judgeSessions',uid),{uid,judgeId:id,accessCode:'SELF_AUTH',createdAt:serverTimestamp()});
  if(mode==='old') b.set(doc(db,'publicStats','summary'),{totalJudges:readVal+1,updatedAt:serverTimestamp()}); else b.set(doc(db,'publicStats','summary'),{totalJudges:increment(1),updatedAt:serverTimestamp()},{merge:true});
  return b.commit(); };
// 1 old behaviour: two judges read the same count (0) then write 1
await seed(0);
const r=await Promise.allSettled([register('a1','old',0)]); await register; 
const r2=await Promise.allSettled([register('a2','old',0)]);
ok('OLD read+1: first signup ok', r[0].status==='fulfilled');
ok('OLD read+1: second signup with stale count is DENIED (bug reproduced)', r2[0].status==='rejected');
// 2 new behaviour: 40 simultaneous signups
await seed(0);
const res=await Promise.allSettled(Array.from({length:40},(_,i)=>register('u'+i,'new')));
ok('FIXED set+merge increment: all 40 concurrent signups succeed ('+res.filter(x=>x.status==='fulfilled').length+'/40)', res.every(x=>x.status==='fulfilled'));
await env.withSecurityRulesDisabled(async c=>{ const s=await getDoc(doc(c.firestore(),'publicStats','summary')); ok('FIXED set+merge increment: counter == 40 (got '+s.data().totalJudges+')', s.data().totalJudges===40); });
// 2b first-ever signup when summary doc missing
await seed(null); await assertSucceeds(register('first','new')).then(()=>ok('FIXED set+merge increment: first signup creates summary=1',true)).catch(e=>ok('FIXED set+merge increment: first signup creates summary=1 :: '+e.message.slice(0,80),false));
// 3 leaderboard access (resultsPublished = true)
await seed(0);
const lb=(db)=>getDoc(doc(db,'publicResults','leaderboard'));
await assertFails(lb(env.unauthenticatedContext().firestore())).then(()=>ok('anonymous visitor cannot read published leaderboard',true)).catch(()=>ok('anonymous visitor cannot read published leaderboard',false));
await assertFails(lb(env.authenticatedContext('judgeX').firestore())).then(()=>ok('signed-in judge cannot read published leaderboard (even with resultsPublished=true)',true)).catch(()=>ok('signed-in judge cannot read published leaderboard',false));
await assertFails(lb(env.authenticatedContext('stranger',{email:'x@y.com',email_verified:true}).firestore())).then(()=>ok('verified non-admin cannot read leaderboard',true)).catch(()=>ok('verified non-admin cannot read leaderboard',false));
await assertSucceeds(lb(env.authenticatedContext('adm',{email:'afnan12saad@gmail.com',email_verified:true}).firestore())).then(()=>ok('admin can read leaderboard',true)).catch(e=>ok('admin can read leaderboard :: '+e.message.slice(0,80),false));
// evaluations still not readable by others
await env.withSecurityRulesDisabled(async c=>{ await setDoc(doc(c.firestore(),'evaluations','J1_t1'),{id:'J1_t1',judgeId:'J1',judgeUid:'owner',teamId:'t1',rating:5,comment:'',createdAt:Timestamp.now(),updatedAt:Timestamp.now()}); });
await assertFails(getDoc(doc(env.authenticatedContext('other').firestore(),'evaluations','J1_t1'))).then(()=>ok('judge cannot read another judge evaluation',true)).catch(()=>ok('judge cannot read another judge evaluation',false));
console.log(`\n${pass} passed, ${fail} failed`); await env.cleanup(); process.exit(fail?1:0);
