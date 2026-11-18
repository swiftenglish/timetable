'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const monday = '2026-11-16T00:00:00.000Z';
const nextMonday = '2026-11-23T00:00:00.000Z';
const ann = {colour:'#f4cccc',teacher:'Ann Mee',code:'B2 65',
  day:'MON',start:'09:00',room:'4',status:'confirmed'};
const green = {colour:'#d9ead3',teacher:null,code:'121 U',
  day:'MON',start:'15:30',room:'2',status:'uncertain'};
const pau = {colour:'#ffe599',teacher:null,code:'PAU',
  day:'FRI',start:'18:00',room:'11',status:'confirmed'};
const ignored = {colour:'#f3f3f3',teacher:null,ignored:true,code:'Reserved',
  day:'FRI',start:'10:00',room:'11',status:'confirmed'};
const week = (iso, classes, found = true) => ({
  found, mondayIso:iso, mondayLabel:iso===monday?'16 Nov 2026':'23 Nov 2026',classes
});
const sources = [
  {id:'current-file',monday:new Date(monday)},
  {id:'next-file',monday:new Date(nextMonday)}
];

class FakeSheet {
  constructor(name) { this.name=name; this.cells=new Map(); this.swatches=new Map(); this.widths=new Map(); }
  key(r,c) { return String(r)+':'+String(c); }
  read(r,c) { return this.cells.get(this.key(r,c))??''; }
  getLastRow() { return Math.max(0,...[...this.cells.keys()].map(k=>Number(k.split(':')[0]))); }
  getRange(...args) {
    let r,c,height,width;
    if (typeof args[0]==='string') {
      const m=/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(args[0]);
      assert.ok(m,'A1 range '+args[0]);
      const col=s=>[...s].reduce((n,ch)=>26*n+ch.charCodeAt(0)-64,0);
      r=Number(m[2]);c=col(m[1]);
      height=(m[4]?Number(m[4]):r)-r+1;
      width=(m[3]?col(m[3]):c)-c+1;
    } else [r,c,height,width]=args;
    assert.ok(r>=1 && c>=1 && height>=1 && width>=1);
    const place=(values)=> {
      assert.equal(values.length,height);
      values.forEach((line,i)=>{
        assert.equal(line.length,width);
        line.forEach((v,j)=>this.cells.set(this.key(r+i,c+j),v));
      });
      return range;
    };
    const range={
      setValues:place,
      setValue:v=>place([[v]]),
      clearContent:()=>{
        for(let i=0;i<height;i++)for(let j=0;j<width;j++)
          this.cells.delete(this.key(r+i,c+j));
        return range;
      },
      setBackgrounds:colors=>{
        assert.equal(colors.length,height);
        colors.forEach((line,i)=>line.forEach((v,j)=>this.swatches.set(this.key(r+i,c+j),v)));
        return range;
      },
      setBackground:v=>{
        for(let i=0;i<height;i++)for(let j=0;j<width;j++)
          this.swatches.set(this.key(r+i,c+j),v);
        return range;
      },
      setNumberFormat:()=>range,setFontWeight:()=>range
    };
    return range;
  }
  setFrozenRows(n) { this.frozen=n; }
  setColumnWidth(c,w) { this.widths.set(c,w); }
}
function create() {
  const sheets=new Map();
  const properties=new Map();
  const spreadsheet={
    getSheetByName:n=>sheets.get(n)||null,
    insertSheet:n=>{const s=new FakeSheet(n);sheets.set(n,s);return s;}
  };
  const lock={locked:0,released:0,tryLock(){this.locked++;return true;},
    releaseLock(){this.released++;}};
  const ctx=vm.createContext({
    SpreadsheetApp:{getActive:()=>spreadsheet},
    PropertiesService:{getScriptProperties:()=>({
      getProperty:k=>properties.get(k)||null,
      setProperty:(k,v)=>properties.set(k,v)
    })},
    LockService:{getScriptLock:()=>lock},
    console
  });
  const functions=vm.runInContext(code+
    '\n({activeColourRows_,syncActiveColours_});',ctx);
  return {sheets,properties,lock,...functions};
}
const getColors=s=>[...s.cells.entries()].filter(([k,v])=>/^#(?:[0-9a-f]{6})$/.test(v) && k.endsWith(':1'))
  .map(([,v])=>v);

const app=create();
const first=[week(monday,[ann,green,ignored]),week(nextMonday,[pau,ann])];
const calculated=app.activeColourRows_(first);
assert.equal(calculated.length,4);
assert.equal(calculated.find(row=>row[0]==='#f4cccc')[3],2);
assert.equal(calculated.find(row=>row[0]==='#d9ead3')[2],'Cancelled / to confirm');
assert.equal(calculated.find(row=>row[0]==='#f3f3f3')[2],'Ignored');
assert.equal(calculated.find(row=>row[0]==='#ffe599')[2],'Unassigned');
assert.ok(app.syncActiveColours_(first,sources),'initial refresh should succeed');
const sheet=app.sheets.get('Active Colours');
assert.ok(sheet,'must create the tab when needed');
assert.equal(sheet.read(1,1),'Colour');
assert.equal(sheet.read(1,9),'Last refreshed');
assert.equal(sheet.read(3,10),'Up to date');
assert.ok(getColors(sheet).includes('#ffe599'));
assert.equal(sheet.swatches.get('2:7')?.startsWith('#'),true);
assert.equal(app.lock.locked,1);
assert.equal(app.lock.released,1);

// A temporarily missing source that was previously included must not erase data.
const disappeared=[week(monday,[ann]),week(nextMonday,[],false)];
assert.equal(app.syncActiveColours_(disappeared,sources),false);
assert.ok(getColors(sheet).includes('#ffe599'));
assert.match(sheet.read(3,10),/Paused.*previously available following week/);

// When the next source is accessible again but PAU was deleted, remove only
// PAU from the live view. The permanent Colours mapping is never edited.
const updated=[week(monday,[ann,green,ignored]),week(nextMonday,[ann])];
assert.ok(app.syncActiveColours_(updated,sources));
assert.ok(!getColors(sheet).includes('#ffe599'),'old PAU colour should disappear');
assert.equal(getColors(sheet).filter(x=>x==='#f4cccc').length,1);
assert.equal(sheet.swatches.get('5:7')??null,null);
assert.equal(sheet.read(3,10),'Up to date');

// An unavailable current week cannot overwrite the last good result.
assert.equal(app.syncActiveColours_([week(monday,[],false),updated[1]],sources),false);
assert.equal(getColors(sheet).length,3);

// The next week may simply not have been uploaded yet.
const oneWeek=create();
assert.ok(oneWeek.syncActiveColours_([week(monday,[ann]),week(nextMonday,[],false)],sources));
const oneSheet=oneWeek.sheets.get('Active Colours');
assert.deepEqual(getColors(oneSheet),['#f4cccc']);
assert.match(oneSheet.read(3,10),/Current week only/);
assert.equal(oneWeek.properties.get('activeColourSourceWeeks_v1').includes('next-file'),false);

// An empty or invalid extracted timetable never clears the last good list.
assert.equal(oneWeek.syncActiveColours_([week(monday,[]),week(nextMonday,[],false)],sources),false);
assert.deepEqual(getColors(oneSheet),['#f4cccc']);

// Colour email alerts are restricted to genuinely active, unassigned blocks.
assert.match(code,/const currentlyUnassigned = new Set\(\)/);
assert.match(code,/currentlyUnassigned\.has\(String\(hex\)\.trim\(\)\.toLowerCase\(\)\)/);
console.log('PASS: live active colours, deleted colours, missing week safeguards, and scoped alerts.');
