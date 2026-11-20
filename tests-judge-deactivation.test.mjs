import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { doc, setDoc, updateDoc, Timestamp, serverTimestamp } from 'firebase/firestore';
const env = await initializeTestEnvironment({ projectId: 'demo-arena', firestore: { rules: readFileSync('firestore.rules','utf8'), host: '127.0.0.1', port: 8085 } });
let pass=0,fail=0; const ok=(n,c)=>{console.log(c?'PASS':'FAIL',n);c?pass++:fail++;};
const T=Timestamp.now();
const settings={eventName:'D',collegeName:'C',tagline:'',venue:'',eventDate:'',customDomain:'',submissionsOpen:true,editingAllowed:true,resultsPublished:false,tieBreakerMode:'tie',currentTeamId:'',timerDurationSeconds:0,timerWarningSeconds:0,timerRemainingSeconds:0,timerRunning:false,timerStartedAtMs:0,updatedAt:T};
async function seed(active){
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c=>{const d=c.firestore();
    await setDoc(doc(d,'settings','event'),settings);
    await setDoc(doc(d,'judges','J1'),{id:'J1',uid:'u1',email:'j@x.com',name:'J',active,createdAt:T,updatedAt:T});
    await setDoc(doc(d,'judgeSessions','u1'),{uid:'u1',judgeId:'J1',createdAt:T});
    await setDoc(doc(d,'teams','t1'),{id:'t1',name:'T',projectTitle:'P',description:'',logoUrl:'',presentationStatus:'Completed',orderIndex:1,tieBreakerRank:1,submittedCount:1,createdAt:T,updatedAt:T});
    await setDoc(doc(d,'evaluations','J1_t1'),{id:'J1_t1',judgeId:'J1',judgeUid:'u1',teamId:'t1',scoreVersion:2,criteria:{c1:3,c2:3,c3:3,c4:3,c5:3},total:15,comment:'',createdAt:T,updatedAt:T});
  });
}
const j=env.authenticatedContext('u1',{firebase:{sign_in_provider:'anonymous'}}).firestore();
const edit=()=>updateDoc(doc(j,'evaluations','J1_t1'),{criteria:{c1:5,c2:5,c3:5,c4:5,c5:5},total:25,updatedAt:serverTimestamp()});
await seed(true);  try{await edit();ok('active judge can edit while editing is allowed',true)}catch(e){ok('active judge can edit while editing is allowed :: '+e.message.slice(0,60),false)}
await seed(false); try{await edit();ok('DEACTIVATED judge cannot edit an existing rating',false)}catch(e){ok('DEACTIVATED judge cannot edit an existing rating',true)}
console.log(`\n${pass} passed, ${fail} failed`); await env.cleanup(); process.exit(fail?1:0);
