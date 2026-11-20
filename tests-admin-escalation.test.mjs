import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { doc, getDoc, setDoc, updateDoc, writeBatch, increment, serverTimestamp, Timestamp } from 'firebase/firestore';
const env = await initializeTestEnvironment({ projectId: 'demo-arena', firestore: { rules: readFileSync('firestore.rules','utf8'), host: '127.0.0.1', port: 8085 } });
let pass=0,fail=0; const ok=(n,c)=>{console.log(c?'PASS':'FAIL',n);c?pass++:fail++;};
await env.clearFirestore();
await env.withSecurityRulesDisabled(async c=>{const d=c.firestore();
 await setDoc(doc(d,'publicStats','adminQuota'),{count:1,firstAdminEmail:'afnan12saad@gmail.com',firstAdminUid:'first',updatedAt:Timestamp.now()});
 await setDoc(doc(d,'admins','first'),{uid:'first',email:'afnan12saad@gmail.com',name:'F',createdAt:Timestamp.now(),isFirstAdmin:true});
 await setDoc(doc(d,'settings','event'),{resultsPublished:false});
 await setDoc(doc(d,'publicResults','leaderboard'),{published:true,totalJudges:1,totalTeams:1,totalSubmissions:1,entries:[],updatedAt:Timestamp.now()});});
const att=env.authenticatedContext('evil',{email:'evil@x.com',email_verified:true,firebase:{sign_in_provider:'password'}}).firestore();
const reqData={id:'evil',uid:'evil',email:'evil@x.com',name:'Evil',verificationCode:'1234',status:'pending',firstAdminEmail:'afnan12saad@gmail.com',firstAdminUid:'first',requestedAt:serverTimestamp(),updatedAt:serverTimestamp()};
await assertSucceeds(setDoc(doc(att,'adminRequests','evil'),reqData)); ok('candidate can create own pending request',true);
let escalated=false;
try{ await updateDoc(doc(att,'adminRequests','evil'),{status:'approved',approvedAt:serverTimestamp(),approvedBy:'self',updatedAt:serverTimestamp()});
 await setDoc(doc(att,'admins','evil'),{uid:'evil',email:'evil@x.com',name:'Evil',isFirstAdmin:false,createdAt:serverTimestamp()}); escalated=true;}catch(e){console.log('blocked at',e.message.slice(0,60));}
ok('SECURITY: unapproved verified user can NOT self-approve into admins (escalated='+escalated+')', !escalated);
let lb=true; try{await getDoc(doc(att,'publicResults','leaderboard'));}catch(e){lb=false;}
ok('SECURITY: that user can NOT read leaderboard (read='+lb+')', !lb);
// legit path: existing admin approves the request, then the candidate is an admin
const adm=env.authenticatedContext('first',{email:'afnan12saad@gmail.com',email_verified:true,firebase:{sign_in_provider:'password'}}).firestore();
await env.withSecurityRulesDisabled(async c=>{ await setDoc(doc(c.firestore(),'adminRequests','good'),{...reqData,id:'good',uid:'good',email:'good@x.com',name:'Good',requestedAt:Timestamp.now(),updatedAt:Timestamp.now()}); });
const ab=writeBatch(adm);
ab.update(doc(adm,'adminRequests','good'),{status:'approved',approvedAt:serverTimestamp(),approvedBy:'afnan12saad@gmail.com',updatedAt:serverTimestamp()});
ab.set(doc(adm,'admins','good'),{uid:'good',email:'good@x.com',name:'Good',isFirstAdmin:false,createdAt:serverTimestamp()});
ab.set(doc(adm,'publicStats','adminQuota'),{count:increment(1),updatedAt:serverTimestamp()},{merge:true});
await assertSucceeds(ab.commit()).then(()=>ok('existing admin can approve a request (no lockout)',true)).catch(e=>ok('existing admin can approve a request :: '+e.message.slice(0,90),false));
const good=env.authenticatedContext('good',{email:'good@x.com',email_verified:true,firebase:{sign_in_provider:'password'}}).firestore();
await assertSucceeds(getDoc(doc(good,'publicResults','leaderboard'))).then(()=>ok('approved admin can read leaderboard',true)).catch(()=>ok('approved admin can read leaderboard',false));
// unverified email cannot create a request or act as admin
const unv=env.authenticatedContext('unv',{email:'u@x.com',email_verified:false,firebase:{sign_in_provider:'password'}}).firestore();
await assertFails(setDoc(doc(unv,'adminRequests','unv'),{...reqData,id:'unv',uid:'unv',email:'u@x.com'})).then(()=>ok('unverified email cannot file an admin request',true)).catch(()=>ok('unverified email cannot file an admin request',false));
// first-admin bootstrap on a fresh project (no quota doc)
await env.clearFirestore();
const boot=env.authenticatedContext('b1',{email:'afnan12saad@gmail.com',email_verified:true,firebase:{sign_in_provider:'password'}}).firestore();
const bb=writeBatch(boot);
bb.set(doc(boot,'admins','b1'),{uid:'b1',email:'afnan12saad@gmail.com',name:'F',isFirstAdmin:true,createdAt:serverTimestamp()});
bb.set(doc(boot,'publicStats','adminQuota'),{count:1,firstAdminEmail:'afnan12saad@gmail.com',firstAdminUid:'b1',updatedAt:serverTimestamp()},{merge:true});
await assertSucceeds(bb.commit()).then(()=>ok('first-admin bootstrap on a fresh project still works',true)).catch(e=>ok('first-admin bootstrap :: '+e.message.slice(0,90),false));
console.log(`${pass} passed, ${fail} failed`); await env.cleanup(); process.exit(fail?1:0);
