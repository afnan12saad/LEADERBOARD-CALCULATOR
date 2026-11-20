// node tests-e2e/build.mjs && npx firebase emulators:exec --only firestore --project demo-arena "node tests-e2e/admincap.test.mjs"
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { doc, getDoc, getDocs, collection, setDoc, Timestamp } from 'firebase/firestore';
import { approveAdminJoinRequest, removeAdminAccount, reconcileAdminSlots, getAdminSlotUsage, setDb } from './svc.mjs';
const env = await initializeTestEnvironment({ projectId: 'demo-arena', firestore: { rules: readFileSync('firestore.rules','utf8'), host: '127.0.0.1', port: 8085 } });
let pass=0,fail=0; const ok=(n,c)=>{console.log(c?'PASS':'FAIL',n);c?pass++:fail++;};
const now=()=>Timestamp.now();
const reqDoc=u=>({id:u,uid:u,email:u+'@x.com',name:u,verificationCode:'123456',status:'pending',firstAdminEmail:'a1@x.com',firstAdminUid:'a1',requestedAt:now(),updatedAt:now()});
async function seed(slotted,legacy,reconciled){
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c=>{const d=c.firestore();
    for(let i=1;i<=slotted;i++){await setDoc(doc(d,'admins','a'+i),{uid:'a'+i,email:'a'+i+'@x.com',name:'a'+i,createdAt:now(),slot:'s'+i});await setDoc(doc(d,'adminSlots','s'+i),{uid:'a'+i,createdAt:now()});}
    for(let i=1;i<=legacy;i++)await setDoc(doc(d,'admins','L'+i),{uid:'L'+i,email:'L'+i+'@x.com',name:'L'+i,createdAt:now()});
    if(reconciled)await setDoc(doc(d,'adminSlots','reconciled'),{at:now()});
    await setDoc(doc(d,'publicStats','adminQuota'),{count:slotted+legacy,updatedAt:now()});
    for(const u of ['n1','n2','n3']) await setDoc(doc(d,'adminRequests',u),reqDoc(u));
  });
}
const as=(uid,email)=>env.authenticatedContext(uid,{email,email_verified:true,firebase:{sign_in_provider:'password'}}).firestore();
const R=u=>({...reqDoc(u)});
const adminCount=async db=>(await getDocs(collection(db,'admins'))).size;
// A: 4 slotted, two concurrent approvals, one slot left
await seed(4,0,true); let db=as('a1','a1@x.com'); setDb(db);
let r=await Promise.allSettled([approveAdminJoinRequest(R('n1'),'a1@x.com'),approveAdminJoinRequest(R('n2'),'a1@x.com')]);
ok('concurrent approvals for last slot: exactly one succeeds ('+r.map(x=>x.status).join(',')+')', r.filter(x=>x.status==='fulfilled').length===1);
ok('exactly five admins after race', await adminCount(db)===5);
let u=await getAdminSlotUsage(); ok('usage shows 5 of 5, none free', u.used===5&&u.free.length===0&&u.reconciled);
let msg=''; try{await approveAdminJoinRequest(R('n3'),'a1@x.com')}catch(e){msg=e.message}
ok('sixth approval refused with clear message', /maximum of 5/i.test(msg));
ok('still five admins', await adminCount(db)===5);
// B: remove frees the slot, then add works
await removeAdminAccount('a2'); u=await getAdminSlotUsage(); ok('removal frees exactly one slot', u.free.length===1&&await adminCount(db)===4);
await approveAdminJoinRequest(R('n3'),'a1@x.com'); ok('freed slot reused by new admin', await adminCount(db)===5);
// C: legacy unslotted admins, unreconciled blocks add; reconcile unblocks; over cap refused
await seed(2,3,false); db=as('a1','a1@x.com'); setDb(db);
msg=''; try{await approveAdminJoinRequest(R('n1'),'a1@x.com')}catch(e){msg=e.message}
ok('unreconciled: adding blocked', msg.length>0&&await adminCount(db)===5);
const rr=await reconcileAdminSlots(); u=await getAdminSlotUsage();
ok('assign step slots 3 legacy admins, nobody removed, still NOT marked reconciled', rr.slotted===3&&!u.reconciled&&u.used===5&&await adminCount(db)===5);
msg=''; try{await approveAdminJoinRequest(R('n1'),'a1@x.com')}catch(e){msg=e.message}
ok('still blocked until the trusted marker exists', msg.length>0);
await env.withSecurityRulesDisabled(async c=>{await setDoc(doc(c.firestore(),'adminSlots','reconciled'),{at:now()});});
msg=''; try{await approveAdminJoinRequest(R('n1'),'a1@x.com')}catch(e){msg=e.message}
ok('after reconcile at 5: add refused', msg.length>0&&await adminCount(db)===5);
// D: already above cap (6 legacy): reconcile refuses, nothing changes
await seed(0,6,false); db=as('L1','L1@x.com'); setDb(db);
msg=''; try{await reconcileAdminSlots()}catch(e){msg=e.message}
u=await getAdminSlotUsage();
ok('over cap: assign refuses, nothing changed, all six keep access', /above the limit/.test(msg)&&!u.reconciled&&u.used===0&&await adminCount(db)===6);
console.log(`\n${pass} passed, ${fail} failed`); await env.cleanup(); process.exit(fail?1:0);
