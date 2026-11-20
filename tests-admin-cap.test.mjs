import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { collection, getDocs, doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore';
const env = await initializeTestEnvironment({ projectId: 'demo-arena', firestore: { rules: readFileSync('firestore.rules','utf8'), host: '127.0.0.1', port: 8085 } });
let pass=0,fail=0; const ok=(n,c)=>{console.log(c?'PASS':'FAIL',n);c?pass++:fail++;};
const ctx=(uid,email)=>env.authenticatedContext(uid,{email,email_verified:true,firebase:{sign_in_provider:'password'}}).firestore();
const adm=(uid,slot)=>({uid,email:uid+'@x.com',name:uid,createdAt:serverTimestamp(),...(slot?{slot}:{})});
const T=Timestamp.now();
async function seed(n,{reconciled=true,legacy=0}={}){
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c=>{const d=c.firestore();
    await setDoc(doc(d,'publicStats','adminQuota'),{count:n+legacy,updatedAt:T});
    for(let i=1;i<=n;i++){await setDoc(doc(d,'admins','a'+i),{uid:'a'+i,email:'a'+i+'@x.com',name:'a'+i,createdAt:T,slot:'s'+i});await setDoc(doc(d,'adminSlots','s'+i),{uid:'a'+i,createdAt:T});}
    for(let i=1;i<=legacy;i++)await setDoc(doc(d,'admins','L'+i),{uid:'L'+i,email:'L'+i+'@x.com',name:'L'+i,createdAt:T});
    if(reconciled)await setDoc(doc(d,'adminSlots','reconciled'),{at:T});
    await setDoc(doc(d,'adminRequests','n1'),{id:'n1',uid:'n1',email:'n1@x.com',name:'n1',verificationCode:'123456',status:'approved',firstAdminEmail:'a1@x.com',firstAdminUid:'a1',requestedAt:T,updatedAt:T});
    await setDoc(doc(d,'adminRequests','n2'),{id:'n2',uid:'n2',email:'n2@x.com',name:'n2',verificationCode:'123456',status:'approved',firstAdminEmail:'a1@x.com',firstAdminUid:'a1',requestedAt:T,updatedAt:T});
  });
}
const addBatch=(db,uid,slot)=>{const b=writeBatch(db);b.set(doc(db,'admins',uid),adm(uid,slot));b.set(doc(db,'adminSlots',slot),{uid,createdAt:serverTimestamp()});return b.commit();};
const good=async(p,n)=>{try{await p;ok(n,true)}catch(e){ok(n+' :: '+e.message.slice(0,80),false)}};
const bad=async(p,n)=>{try{await p;ok(n+' (was allowed!)',false)}catch(e){ok(n,true)}};
// 1 four admins, fifth via approved self-registration
await seed(4); await good(addBatch(ctx('n1','n1@x.com'),'n1','s5'),'fifth admin via approved request succeeds');
// 2 sixth denied on each path
await seed(5);
await bad(addBatch(ctx('n1','n1@x.com'),'n1','s1'),'sixth via approved request, reusing taken slot s1 denied');
await bad(addBatch(ctx('a1','a1@x.com'),'z9','s2'),'sixth by existing admin reusing taken slot denied');
await bad(setDoc(doc(ctx('a1','a1@x.com'),'admins','z9'),adm('z9')),'existing admin creating slotless admin denied');
await bad(setDoc(doc(ctx('n1','n1@x.com'),'admins','n1'),adm('n1')),'approved requester creating slotless admin denied');
await bad(setDoc(doc(ctx('n1','n1@x.com'),'admins','n1'),adm('n1','s6')),'invalid slot name denied');
// 3 owner email gets no bypass
await seed(5); await bad(addBatch(ctx('own','afnan12saad@gmail.com'),'own','s1'),'owner email cannot add itself as sixth (slot taken)');
await bad(setDoc(doc(ctx('own','afnan12saad@gmail.com'),'admins','own'),adm('own')),'owner email cannot add itself slotless');
// 4 forged counter does not matter
await seed(5); await env.withSecurityRulesDisabled(async c=>{await setDoc(doc(c.firestore(),'publicStats','adminQuota'),{count:0,updatedAt:T});});
await bad(addBatch(ctx('n1','n1@x.com'),'n1','s1'),'forged count=0 does not open a sixth slot');
// 5 race: two admins both approved, one free slot s5
await seed(4);
const r=await Promise.allSettled([addBatch(ctx('n1','n1@x.com'),'n1','s5'),addBatch(ctx('n2','n2@x.com'),'n2','s5')]);
ok('race for the last slot: exactly one wins ('+r.map(x=>x.status).join(',')+')', r.filter(x=>x.status==='fulfilled').length===1);
// 6 batch cannot back two new admins with one slot
await seed(4); { const db=ctx('a1','a1@x.com'); const b=writeBatch(db); b.set(doc(db,'admins','p'),adm('p','s5')); b.set(doc(db,'admins','q'),adm('q','s5')); b.set(doc(db,'adminSlots','s5'),{uid:'p',createdAt:serverTimestamp()}); await bad(b.commit(),'one slot cannot back two new admins in a batch'); }
{ const db=ctx('a1','a1@x.com'); const b=writeBatch(db); b.set(doc(db,'admins','p'),adm('p','s5')); b.set(doc(db,'admins','q'),adm('q','s4')); b.set(doc(db,'adminSlots','s5'),{uid:'p',createdAt:serverTimestamp()}); await bad(b.commit(),'second new admin claiming an occupied slot in same batch denied'); }
// 7 removal frees only own slot
await seed(5);
await bad(deleteDoc(doc(ctx('a1','a1@x.com'),'admins','a2')),'delete admin without freeing slot denied');
{ const db=ctx('a1','a1@x.com'); const b=writeBatch(db); b.delete(doc(db,'admins','a2')); b.delete(doc(db,'adminSlots','s3')); await bad(b.commit(),'removing admin cannot free another admin slot'); }
{ const db=ctx('a1','a1@x.com'); const b=writeBatch(db); b.delete(doc(db,'adminSlots','s3')); await bad(b.commit(),'slot cannot be freed alone'); }
{ const db=ctx('a1','a1@x.com'); const b=writeBatch(db); b.delete(doc(db,'admins','a2')); b.delete(doc(db,'adminSlots','s2')); await good(b.commit(),'delete admin + its own slot succeeds'); }
await good(addBatch(ctx('n1','n1@x.com'),'n1','s2'),'freed slot can be reused by a new admin');
// 8 slot cannot be overwritten/edited
await seed(5); await bad(setDoc(doc(ctx('a1','a1@x.com'),'adminSlots','s2'),{uid:'a1',createdAt:serverTimestamp()}),'slot cannot be reassigned');
await bad(updateDoc(doc(ctx('a1','a1@x.com'),'admins','a2'),{slot:'s4'}),'admin slot cannot be moved');
// 9 grandfathering: legacy unslotted admins keep access; additions blocked until reconciled
await seed(3,{reconciled:false,legacy:3});
await good(getDoc(doc(ctx('L1','L1@x.com'),'adminSlots','s1')),'legacy admin still reads (keeps access)');
await good(getDocs(collection(ctx('L1','L1@x.com'),'admins')),'legacy admin still has admin list access');
await bad(addBatch(ctx('n1','n1@x.com'),'n1','s4'),'unreconciled: approved requester cannot be added');
await bad(addBatch(ctx('a1','a1@x.com'),'z9','s4'),'unreconciled: admin cannot add');
// 10 reconciliation: legacy admin claims slot, then marker, then additions work
{ const db=ctx('a1','a1@x.com'); const b=writeBatch(db); b.update(doc(db,'admins','L1'),{slot:'s4'}); b.set(doc(db,'adminSlots','s4'),{uid:'L1',createdAt:serverTimestamp()}); await good(b.commit(),'admin can reconcile a legacy admin into a slot'); }
{ const db=ctx('a1','a1@x.com'); const b=writeBatch(db); b.update(doc(db,'admins','L2'),{slot:'s5'}); b.set(doc(db,'adminSlots','s5'),{uid:'L2',createdAt:serverTimestamp()}); await good(b.commit(),'second legacy admin slotted'); }
await good(setDoc(doc(ctx('a1','a1@x.com'),'adminSlots','reconciled'),{at:serverTimestamp()}),'reconciled marker set');
await bad(addBatch(ctx('n1','n1@x.com'),'n1','s1'),'after reconcile with 5 full: sixth still denied');
// 11 fresh project bootstrap
await env.clearFirestore();
{ const db=ctx('b1','afnan12saad@gmail.com'); const b=writeBatch(db); b.set(doc(db,'admins','b1'),{uid:'b1',email:'afnan12saad@gmail.com',name:'F',isFirstAdmin:true,slot:'s1',createdAt:serverTimestamp()}); b.set(doc(db,'adminSlots','s1'),{uid:'b1',createdAt:serverTimestamp()}); b.set(doc(db,'adminSlots','reconciled'),{at:serverTimestamp()}); b.set(doc(db,'publicStats','adminQuota'),{count:1,firstAdminEmail:'afnan12saad@gmail.com',firstAdminUid:'b1',updatedAt:serverTimestamp()}); await good(b.commit(),'fresh project first-admin bootstrap works'); }
await bad(addBatch(ctx('x','x@x.com'),'x','s2'),'stranger cannot register as admin after bootstrap');
console.log(`\n${pass} passed, ${fail} failed`); await env.cleanup(); process.exit(fail?1:0);
