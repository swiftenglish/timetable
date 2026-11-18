'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code=fs.readFileSync(path.join(__dirname,'..','Code.gs'),'utf8');
const entries=new Map();
const properties={
  getProperty:k=>entries.get(k)||null,
  setProperty:(k,v)=>{entries.set(k,String(v));return properties;},
  setProperties:values=>{for(const [k,v] of Object.entries(values))entries.set(k,String(v));return properties;},
  deleteProperty:k=>{entries.delete(k);return properties;},
  getKeys:()=>[...entries.keys()]
};
const lock={locked:0,released:0,tryLock(){this.locked++;return true;},
  releaseLock(){this.released++;}};
class FixedDate extends Date {
  constructor(...args){super(...(args.length?args:['2026-11-19T12:00:00Z']));}
  static now(){return new Date('2026-11-19T12:00:00Z').getTime();}
}
const api=vm.runInNewContext(code+
  '\n({attachSharedChanges_,readChangeHistory_,writeChangeHistory_,historyIdentity_,'+
  'provenTeacherLessons_,diffTeacherLessons_});',{
  PropertiesService:{getScriptProperties:()=>properties},
  LockService:{getScriptLock:()=>lock},
  Date:FixedDate,console
});
const iso='2026-11-16T00:00:00.000Z';
const week=(classes)=>({found:true,mondayIso:iso,mondayLabel:'16 Nov 2026',classes});
const bob={
  day:'TUE',start:'09:00',end:'10:00',room:'4',online:false,offsite:false,
  code:'C1 27',notes:'',teacher:'Bob',status:'confirmed',colour:'#aa22ff'
};
const alice={
  day:'WED',start:'18:00',end:'19:00',room:'3',online:false,offsite:false,
  code:'B2 65',notes:'',teacher:'Alice',status:'confirmed',colour:'#ddaaff'
};
const green={...alice,colour:'#d9ead3',teacher:null,status:'uncertain'};
const next={found:false,mondayIso:'2026-11-23T00:00:00.000Z',classes:[]};
let old=week([alice,bob]);
api.attachSharedChanges_([old,next]);
assert.equal(old.changeEvents.length,0,'initial server baseline is not a change');
assert.equal(properties.getKeys().some(k=>k.startsWith('teacherChangeHistory_v1_')),true);
assert.ok(api.readChangeHistory_(properties,iso),'baseline is durable');

let updated=week([{...green},bob]);
api.attachSharedChanges_([updated,next]);
assert.equal(updated.classes[0].teacher,null,'green is not a confirmed teacher assignment');
assert.equal(updated.classes[0].previousTeacher,'Alice','server recognises original teacher');
assert.equal(updated.changeEvents.length,1);
assert.equal(updated.changeEvents[0].teacher,'Alice');
assert.equal(updated.changeEvents[0].kind,'Cancelled / to confirm');
assert.equal(updated.changeEvents[0].current.status,'uncertain');
const stableId=updated.changeEvents[0].id;
assert.ok(stableId&&stableId.startsWith('2026-11-16:'));

// Refresh without change reuses event IDs without duplicating notifications.
let same=week([{...green},bob]);
api.attachSharedChanges_([same,next]);
assert.equal(same.changeEvents.length,1);
assert.equal(same.changeEvents[0].id,stableId);
assert.equal(same.classes[0].previousTeacher,'Alice');

// Confirmation is detected as a status transition; earlier alerts remain
// available when the teacher opens another browser or phone.
let restored=week([{...alice},bob]);
api.attachSharedChanges_([restored,next]);
assert.deepEqual(Array.from(restored.changeEvents,e=>e.kind),
  ['Cancelled / to confirm','Confirmed again']);
assert.equal(restored.changeEvents[1].teacher,'Alice');
assert.notEqual(restored.changeEvents[1].id,stableId);

let changed=week([{...alice,start:'18:30',end:'19:30'},bob]);
api.attachSharedChanges_([changed,next]);
assert.equal(changed.changeEvents.at(-1).kind,'Changed');
assert.equal(changed.changeEvents.at(-1).previous.start,'18:00');

// New and removed lessons are logged. One teacher must never inherit another
// teacher's lessons based on a course code alone.
let removed=week([bob]);
api.attachSharedChanges_([removed,next]);
assert.equal(removed.changeEvents.at(-1).kind,'Removed');
assert.equal(removed.changeEvents.at(-1).teacher,'Alice');
let newLesson=week([alice,bob]);
api.attachSharedChanges_([newLesson,next]);
assert.equal(newLesson.changeEvents.at(-1).kind,'New');

// Duplicate prior owners make the green lesson ambiguous; never guess.
const ambig=[api.provenTeacherLessons_([
  {...alice,teacher:'Alice'},{...alice,teacher:'Bob'}
],[])][0];
const unknown=week([{...green}]);
const owned=api.provenTeacherLessons_(unknown.classes,ambig);
assert.equal(owned.length,0);
assert.equal(unknown.classes[0].previousTeacher,undefined);

// Only one of two exact duplicate green blocks may not be assigned either.
const double=week([{...green},{...green}]);
const current=api.provenTeacherLessons_(double.classes,[
  {...alice,teacher:'Alice'}
]);
assert.equal(current.length,0);
assert.equal(double.classes[0].previousTeacher,undefined);

// Missing source should not clear the last valid history record.
const stateBefore=properties.getKeys().filter(k=>k.startsWith('teacherChangeHistory_v1_')).length;
api.attachSharedChanges_([{found:false,mondayIso:iso},next]);
assert.equal(properties.getKeys().filter(k=>k.startsWith('teacherChangeHistory_v1_')).length,stateBefore);
assert.ok(api.readChangeHistory_(properties,iso));

// Large records must use multiple script-property chunks.
const largeState={last:Array.from({length:250},(_,i)=>({
  ...alice,code:'B2 '+i,teacher:'Alice',notes:'memo'+i
})),events:[],nextId:1};
api.writeChangeHistory_(properties,iso,largeState);
const prefix='teacherChangeHistory_v1_2026-11-16';
assert.ok(Number(properties.getProperty(prefix))>1);
assert.equal(api.readChangeHistory_(properties,iso).last.length,250);
assert.ok(properties.getProperty(prefix+'_0').length<=5000);
assert.equal(lock.locked,lock.released);

console.log('PASS: shared history, green attribution, old/new/change/restore, persistence, and ambiguity.');
