'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');
// Replace only Apps Script integration functions; no Google account is needed.
const isolatedCode = code
  .replace('function readGrid_(fileId) {', 'function originalReadGrid_(fileId) {')
  .replace('function readColourMap_() {', 'function originalReadColourMap_() {')
  .replace('function logUnknownColours_(unknown) {', 'function originalLogUnknownColours_(unknown) {');
assert.notEqual(code, isolatedCode);

const text = Array.from({length: 20}, () => Array(45).fill(''));
const bg = Array.from({length: 20}, () => Array(45).fill('#ffffff'));
function header(day, date, begin) {
  for (let room = 1; room <= 12; room++) {
    const col = begin + room - 1;
    text[1][col] = String(date);
    text[2][col] = day;
    text[3][col] = String(room);
  }
}
header('MON', 16, 1);
header('TUE', 17, 15);
header('WED', 18, 30);
text[4][0] = '19:00';
text[16][0] = 'MON';
function block(col, from, to, label, colour) {
  text[from][col] = label;
  for (let row = from; row <= to; row++) bg[row][col] = colour;
}
block(3, 5, 6, '121 III', '#aa22ff');
block(3, 7, 9, '125 YYY', '#aa22ff');
block(5, 5, 6, '126 NEW', '#cc2299');
block(4, 5, 6, 'B3 17', '#22ccaa');
text[6][4] = 'XYZ 18';
block(6, 5, 6, 'B2 25', '#445566');
block(27, 5, 7, 'IBC NNN', '#aa22ff');
text[2][42] = 'WED';
block(42, 5, 7, 'IBC 38', '#aa22ff');
// Artefact lilac applies only in rooms 1 and 3. Artefact grey applies everywhere.
block(1, 5, 6, 'A1 LILAC ARTIFACT', '#e5d8f6');
block(3, 10, 11, 'B2 LILAC ARTIFACT', '#d9d2e9');
block(7, 5, 6, 'C1 GREY ARTIFACT', '#b7b7b7');
// Real classes in other rooms must still work with these two lilac colours.
block(2, 5, 6, 'A2 REAL', '#e5d8f6');
block(9, 5, 6, 'C2 REAL', '#d9d2e9');
const sheet = {text, bg};
const names = {'#aa22ff': 'Teacher A', '#cc2299': 'Teacher B',
  '#22ccaa': 'Teacher C', '#e5d8f6': 'Teacher D', '#d9d2e9': 'Teacher E'};
const api = vm.runInNewContext(isolatedCode +
  '\n({parseWeek_,isClassCode_,looksLikeUnknownClassCode_,validateWeek_,isDecorativeCell_});', {
  readGrid_: () => sheet, readColourMap_: () => names, logUnknownColours_: () => {}
});
const week = api.parseWeek_('fixture');
const match = (day, code) => week.classes.find(c => c.day === day && c.code === code);
for (const [code, start, end] of [
  ['121 III', '19:00', '20:00'],
  ['125 YYY', '20:00', '21:30'],
  ['126 NEW', '19:00', '20:00']
]) {
  const c = match('MON', code);
  assert.ok(c, 'Missing lesson ' + code);
  assert.equal(c.start, start);
  assert.equal(c.end, end);
}
assert.equal(week.classes.filter(c => c.room === '3').length, 2);
for (const label of ['A1 LILAC ARTIFACT', 'B2 LILAC ARTIFACT', 'C1 GREY ARTIFACT']) {
  assert.equal(match('MON', label), undefined, label + ' must be ignored');
}
assert.equal(match('MON', 'A2 REAL').room, '2');
assert.equal(match('MON', 'C2 REAL').room, '9');
assert.equal(api.isDecorativeCell_('1', '#E5D8F6'), true);
assert.equal(api.isDecorativeCell_('3', '#D9D2E9'), true);
assert.equal(api.isDecorativeCell_('2', '#e5d8f6'), false);
assert.equal(api.isDecorativeCell_('9', '#d9d2e9'), false);
assert.equal(api.isDecorativeCell_('12', '#B7B7B7'), true);
assert.equal(api.isDecorativeCell_('Offsite', '#b7b7b7'), true);
assert.equal(api.isClassCode_('127 TEST'), true);
assert.equal(api.isClassCode_('C1+ 66'), true);
assert.equal(api.isClassCode_('1234'), false);
assert.equal(api.isClassCode_('NO CLASE'), false);
assert.equal(api.looksLikeUnknownClassCode_('XYZ 18'), true);
assert.equal(api.looksLikeUnknownClassCode_('SEM 16/11'), false);
assert.equal(match('TUE', 'IBC NNN').offsite, true);
assert.equal(match('WED', 'IBC 38').offsite, true);
assert.equal(match('WED', 'IBC 38').room, '');
assert.equal((week.rooms.TUE || []).length, 12);
assert.equal((week.rooms.WED || []).length, 12);

const checks = api.validateWeek_(week);
assert.ok(checks.issues.some(x => x.kind === 'possible-class'));
assert.ok(checks.issues.some(x => x.kind === 'unrecognised-code'));
assert.ok(checks.issues.some(x => x.kind === 'unassigned-colour'));
assert.equal(checks.stats.offsite, 2);

const conflicts = api.validateWeek_({
  parserWarnings: [],
  classes: [
    {day: 'MON', code: 'B1', teacher: 'Ann', room: '3',
     start: '9:00', end: '10:00', colour: '#111'},
    {day: 'MON', code: 'B2', teacher: 'Bob', room: '3',
     start: '9:30', end: '10:30', colour: '#222'},
    {day: 'MON', code: 'A1', teacher: 'Ann', room: '4',
     start: '9:15', end: '10:15', colour: '#111'},
    {day: 'MON', code: 'IBC', teacher: 'Bob', room: '', offsite: true,
     start: '12:00', end: '13:00', colour: '#222'}
  ]
});
assert.ok(conflicts.issues.some(x => x.kind === 'room-overlap'));
assert.ok(conflicts.issues.some(x => x.kind === 'teacher-overlap'));
assert.equal(conflicts.issues.some(x => x.kind === 'missing-room'), false);

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
assert.ok(scripts.length >= 2);
for (const script of scripts) new vm.Script(script[1]);
assert.match(html, /data-view="checks"/);
assert.match(html, /function renderDayOverview/);
assert.match(html, /function renderChecks/);
console.log('PASS: class codes, offsite, decorative colours, warnings, conflicts and frontend syntax.');
