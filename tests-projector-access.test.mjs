// Run: npx firebase emulators:exec --only firestore --project demo-arena "node tests-projector-access.test.mjs"
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { doc, getDoc, getDocs, collection, setDoc, query, where, Timestamp } from 'firebase/firestore';
const env = await initializeTestEnvironment({ projectId: 'demo-arena', firestore: { rules: readFileSync('firestore.rules','utf8'), host: '127.0.0.1', port: 8085 } });
let pass=0,fail=0; const t=async(n,p,expectOk)=>{let ok;try{await p;ok=expectOk}catch{ok=!expectOk}console.log(ok?'PASS':'FAIL',n);ok?pass++:fail++;};
await env.clearFirestore();
await env.withSecurityRulesDisabled(async c=>{const d=c.firestore();
 await setDoc(doc(d,'admins','adm'),{uid:'adm',email:'a@x.com',name:'A',createdAt:Timestamp.now()});
 await setDoc(doc(d,'settings','event'),{resultsPublished:true,submissionsOpen:true});
 await setDoc(doc(d,'teams','t1'),{id:'t1',name:'T',projectTitle:'P',description:'',logoUrl:'',presentationStatus:'Waiting',orderIndex:1,tieBreakerRank:1,submittedCount:1,createdAt:Timestamp.now(),updatedAt:Timestamp.now()});
 await setDoc(doc(d,'evaluations','J1_t1'),{id:'J1_t1',judgeId:'J1',judgeUid:'u1',teamId:'t1',rating:5,comment:'',createdAt:Timestamp.now(),updatedAt:Timestamp.now()});
 await setDoc(doc(d,'judges','J1'),{id:'J1',uid:'u1',email:'j@x.com'});
 await setDoc(doc(d,'publicResults','leaderboard'),{published:true,totalJudges:1,totalTeams:1,totalSubmissions:1,entries:[],updatedAt:Timestamp.now()});});
const who={ 'signed-out':env.unauthenticatedContext().firestore(), 'judge':env.authenticatedContext('u1').firestore(), 'verified non-admin':env.authenticatedContext('s',{email:'s@x.com',email_verified:true,firebase:{sign_in_provider:'password'}}).firestore() };
const admin=env.authenticatedContext('adm',{email:'afnan12saad@gmail.com',email_verified:true,firebase:{sign_in_provider:'password'}}).firestore();
for(const [n,db] of Object.entries(who)){
 await t(n+': cannot list all ratings (the leaderboard source)', getDocs(collection(db,'evaluations')), false);
 await t(n+': cannot list judges', getDocs(collection(db,'judges')), false);
 await t(n+': cannot read published leaderboard', getDoc(doc(db,'publicResults','leaderboard')), false);
}
await t('judge: cannot query ratings of other judges', getDocs(query(collection(who.judge,'evaluations'),where('judgeUid','==','someone'))), false);
await t('admin: can list ratings', getDocs(collection(admin,'evaluations')), true);
await t('admin: can list judges', getDocs(collection(admin,'judges')), true);
await t('admin: can read leaderboard doc', getDoc(doc(admin,'publicResults','leaderboard')), true);
console.log(`${pass} passed, ${fail} failed`); await env.cleanup(); process.exit(fail?1:0);
