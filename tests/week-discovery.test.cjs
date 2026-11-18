'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const props = new Map();
const files = [];
function file(id, heading, dayNum, created, modified, title = heading) {
  const info = {id, heading, dayNum, created:new Date(created), modified:new Date(modified), title};
  files.push(info);
  return info;
}
function sampleHeader(f) {
  const rows = Array.from({length:15}, ()=>Array(40).fill(''));
  rows[1][4] = f.heading;
  rows[5][2] = String(f.dayNum);
  rows[6][2] = 'MON';
  return rows;
}
const context = {
  PropertiesService:{getScriptProperties:()=>({
    getProperty:k=>props.get(k)||null,
    setProperty:(k,v)=>props.set(k,v)
  })},
  SpreadsheetApp:{openById:id=>{
    const f = files.find(x=>x.id===id);
    assert.ok(f,'source id must exist');
    return {getSheetByName:name=>{
      assert.equal(name,'TT');
      return {getLastColumn:()=>40,getRange:()=>({getDisplayValues:()=>sampleHeader(f)})};
    }};
  }},
  DriveApp:{searchFiles:()=>{
    const unordered = files.slice().reverse();
    let index=0;
    return {hasNext:()=>index<unordered.length,next:()=>unordered[index++]};
  }},
  console
};
const api = vm.runInNewContext(code+'\n({mondayFromHeading_,mondayFromFile_,listWeeks_});',context);
const iso = d=>d?.toISOString().slice(0,10)||null;
for(const [heading,day,expected] of [
  ['16 al 20 de noviembre 2026',16,'2026-11-16'],
  ['9 A13 de noviembre 2026',9,'2026-11-09'],
  ['2 al 6 de noviembre 2026',2,'2026-11-02'],
  ['26 al 30 octubre 2026',26,'2026-10-26'],
  ['30 al 4 diciembre 2026',30,'2026-11-30'],
  ['28/09 a 2 octubre 2026',28,'2026-09-28'],
  ['28 septiembre a 2 octubre 2026',28,'2026-09-28'],
  ['28/12 a 1 enero 2027',28,'2026-12-28'],
  ['29 al 2 enero 2027',29,'2026-12-29'] // Tuesday => invalid date
]) {
  const result = api.mondayFromHeading_(day,heading);
  assert.equal(iso(result), expected==='2026-12-29'?null:expected, heading);
}
assert.equal(api.mondayFromHeading_(16,'no valid year'),null);
assert.equal(api.mondayFromHeading_(16,'16 to 20 November 2025'),null,
  'invalid weekday/year combination must be rejected');

file('old-copy','16 al 20 noviembre 2026',16,
  '2026-11-17T08:00:00Z','2026-11-17T11:00:00Z');
const latest=file('correct-week','16 al 20 noviembre 2026',16,
  '2026-09-02T08:00:00Z','2026-11-18T22:00:00Z');
const next=file('next-week','23 al 27 noviembre 2026',23,
  '2026-10-01T08:00:00Z','2026-11-18T21:00:00Z');
file('old-week-updated','2 al 6 noviembre 2026',2,
  '2026-11-18T08:00:00Z','2026-11-18T23:00:00Z');
file('october','26 al 30 octubre 2026',26,
  '2026-11-18T08:00:00Z','2026-11-18T19:00:00Z');
// Twelve unrelated newer-created timetable candidates would have displaced
// the right file with the old "newest six created files" algorithm.
for(let i=0;i<12;i++) file('unrelated-'+i,'12 al 16 octubre 2026',12,
  '2026-11-18T13:00:00Z',new Date(Date.UTC(2026,10,18,10,i)).toISOString());
// Old memoized mappings are strings and must NOT override live printed headers.
props.set('weeks',JSON.stringify({'correct-week':'2026-11-23T00:00:00.000Z'}));
let weeks=api.listWeeks_();
assert.ok(weeks.length>=4);
const current=weeks.find(x=>iso(x.monday)==='2026-11-16');
assert.equal(current?.id,'correct-week',
  'use correct source from dated header, not newer creation or stale memoization');
assert.equal(weeks.find(x=>iso(x.monday)==='2026-11-23')?.id,'next-week');
assert.equal(weeks.filter(x=>iso(x.monday)==='2026-11-16').length,1,
  'duplicate copies must not create multiple current weeks');
assert.equal(weeks.find(x=>iso(x.monday)==='2026-11-02')?.id,'old-week-updated');
let cache=JSON.parse(props.get('weeks'));
assert.equal(cache['correct-week'].modified,latest.modified.getTime());
assert.ok(cache['correct-week'].mondayIso.startsWith('2026-11-16'));

// Cached week mappings remain valid while source modification time is equal.
weeks=api.listWeeks_();
assert.equal(weeks.find(x=>iso(x.monday)==='2026-11-16')?.id,'correct-week');

// A timetable reused/edited for a different date must be re-read and
// reassigned to the new week rather than keeping the former cached date.
latest.heading='23 al 27 noviembre 2026';
latest.dayNum=23;
latest.modified=new Date('2026-11-19T10:00:00Z');
weeks=api.listWeeks_();
assert.equal(weeks.find(x=>iso(x.monday)==='2026-11-16')?.id,'old-copy');
assert.equal(weeks.find(x=>iso(x.monday)==='2026-11-23')?.id,'correct-week');
cache=JSON.parse(props.get('weeks'));
assert.ok(cache['correct-week'].mondayIso.startsWith('2026-11-23'));

// Files with no reliable date must not be guessed as the current week.
const bad=file('unreadable','Unknown week',26,
  '2025-01-01T10:00:00Z','2026-11-18T23:00:00Z');
assert.equal(api.mondayFromFile_({
  getId:()=>bad.id,getName:()=>bad.title,
  getLastUpdated:()=>bad.modified,getDateCreated:()=>bad.created
}),null);
console.log('PASS: printed Spanish week headings, duplicates, old copies, cached changes, and guarded dates.');
