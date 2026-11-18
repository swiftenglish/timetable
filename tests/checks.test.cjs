'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const match = html.match(/  function renderChecks\(res\) \{[\s\S]*?\n  \}\n\n  function resetRoomPickers\(preserve\) \{/);
assert.ok(match, 'Checks renderer must exist');
const functionSource = match[0].replace(/\n\n  function resetRoomPickers\(preserve\) \{$/, '');
const DAYS = [['MON','Monday'],['TUE','Tuesday'],['WED','Wednesday'],
  ['THU','Thursday'],['FRI','Friday']];
const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const isUncertain = c=>c.status==='uncertain'||String(c.colour||'').toLowerCase()==='#d9ead3';
const classPlace = c=>c.offsite?'Offsite':c.online?'Online':c.room?'Room '+c.room:'';
const green = (id)=>({
  day: DAYS[id%5][0], start:'17:30', end:'18:00',
  room:String((id%12)+1), code:'121 '+id, teacher:null,
  status:'uncertain', colour:'#d9ead3'
});
const statusIssue = c=>({
  severity:'warning',kind:'uncertain-class',
  day:c.day,time:c.start,room:c.room,
  message:'The green block "'+c.code+'" may be cancelled or awaiting confirmation.'
});
function render(data) {
  const out={innerHTML:''};
  const elements={title:{textContent:''},sub:{textContent:''}};
  const context={out,$:key=>elements[key],DAYS,isUncertain,classPlace,esc,window:{}};
  vm.runInNewContext(functionSource+'\nrenderChecks(__input);',
    {...context,__input:data});
  return {html:out.innerHTML, title:elements.title.textContent};
}
function week(classes, issues=[], counts={}) {
  return {
    mondayLabel:'16 Nov 2026', classes,
    validation:{
      stats:{total:classes.length,teachers:1,unassigned:0,
        offsite:0,uncertain:classes.filter(isUncertain).length},
      errors:counts.errors??0, warnings:counts.warnings??issues.length,
      total:counts.total??issues.length, issues
    }
  };
}
const fourteen=Array.from({length:14},(_,i)=>green(i));
let output=render(week(fourteen));
assert.match(output.html,/14 lessons — Cancelled \/ to confirm · View details/);
assert.match(output.html,/<details class="check-uncertain">/);
assert.doesNotMatch(output.html,/<details class="check-uncertain" open/);
assert.match(output.html,/No other issues detected/);
assert.match(output.html,/<strong>0<\/strong><span>Warnings<\/span>/);
assert.equal((output.html.match(/<li><strong>121 /g)||[]).length,14,
  'all green classes remain available inside the collapsible section');
assert.doesNotMatch(output.html,/<article class="check-item warning">/);
assert.match(output.html,/No other validation issues/);
assert.match(output.html,/rooms remain provisionally occupied/);

// A real missing-colour warning must remain prominent and count correctly.
const realWarning={severity:'warning',kind:'unassigned-colour',
  message:'Unassigned colour #00ff00',day:'MON',time:'18:00',room:'3'};
output=render(week(fourteen,[realWarning]));
assert.match(output.html,/Review recommended/);
assert.match(output.html,/<strong>1<\/strong><span>Warnings<\/span>/);
assert.match(output.html,/Unassigned colour #00ff00/);
assert.equal((output.html.match(/<article class="check-item warning">/g)||[]).length,1);

// Old Apps Script snapshots can still include 14 legacy green warnings.
output=render(week(fourteen,[realWarning,...fourteen.map(statusIssue)],{
  warnings:15,total:15
}));
assert.match(output.html,/<strong>1<\/strong><span>Warnings<\/span>/);
assert.equal((output.html.match(/<article class="check-item warning">/g)||[]).length,1);
assert.doesNotMatch(output.html,/<p>The green block/);

// No arbitrary 100-item limit on the green details; the backend issue list can be bounded.
const many=Array.from({length:123},(_,i)=>green(i));
output=render(week(many));
assert.match(output.html,/123 lessons — Cancelled \/ to confirm/);
assert.equal((output.html.match(/<li><strong>121 /g)||[]).length,123);

// Render timetable text safely as text, not executable HTML.
const malicious=green(1);
malicious.code='<img src=x onerror=alert(1)>';
output=render(week([malicious]));
assert.doesNotMatch(output.html,/<img src=x onerror/);
assert.match(output.html,/&lt;img src=x onerror=alert\(1\)&gt;/);

// The green lessons are only a grouped status: real overlap errors remain errors.
const collision={severity:'error',kind:'room-overlap',
  message:'Two confirmed classes use Room 3',day:'MON',time:'18:00',room:'3'};
output=render(week(fourteen,[collision],{errors:1,warnings:0,total:1}));
assert.match(output.html,/Problems need attention/);
assert.match(output.html,/<article class="check-item error">/);
assert.match(output.html,/14 lessons — Cancelled \/ to confirm/);

assert.match(html,/\.check-uncertain summary:focus-visible/);
console.log('PASS: grouped green details, actionable warnings, backwards compatibility, full list, and escaping.');
