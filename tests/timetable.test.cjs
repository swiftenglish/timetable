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
// Monday's offsite candidate contains ONLY a black lesson, so detection must
// not rely on any other coloured class in the column.
block(13, 5, 6, 'IBC BLACK', '#000000');
// IBC lessons remain offsite even when entered in numbered classroom columns.
block(1, 8, 9, 'IBC 45', '#22ccaa');       // Room 1 column
block(3, 12, 13, 'ibc NNN', '#aa22ff');   // Room 3 column, lower-case code
block(11, 11, 12, 'IBCR 2', '#cc2299');   // Not IBC: still Room 11
// Artefact lilac applies only in rooms 1 and 3; grey applies only offsite.
block(1, 5, 6, 'A1 LILAC ARTIFACT', '#e5d8f6');
block(3, 10, 11, 'B2 LILAC ARTIFACT', '#d9d2e9');
block(7, 5, 6, 'C1 GREY CLASS', '#b7b7b7');
block(27, 10, 11, 'GREY OFFSITE ARTIFACT', '#b7b7b7');
block(42, 10, 11, 'GREY OFFSITE WED', '#b7b7b7');
// Real classes in other rooms must still work with these two lilac colours.
block(2, 5, 6, 'A2 REAL', '#e5d8f6');
block(9, 5, 6, 'C2 REAL', '#d9d2e9');
// Pale green means cancelled OR awaiting confirmation, never confirmed teaching.
block(10, 5, 7, 'C1 STATUS UNKNOWN', '#d9ead3');
const sheet = {text, bg};
const names = {'#aa22ff': 'Teacher A', '#cc2299': 'Teacher B',
  '#22ccaa': 'Teacher C', '#e5d8f6': 'IGNORE', '#d9d2e9': 'IGNORE',
  '#b7b7b7': 'IGNORE', '#000000': 'Tom Cocker'};
let loggedUnknown = {};
const api = vm.runInNewContext(isolatedCode +
  '\n({parseWeek_,isClassCode_,looksLikeUnknownClassCode_,validateWeek_,isDecorativeCell_,isUncertainClass_,isIbcClassCode_,resolveTeacherColour_});', {
  readGrid_: () => sheet, readColourMap_: () => names,
  logUnknownColours_: value => { loggedUnknown = value; }
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
for (const label of ['A1 LILAC ARTIFACT', 'B2 LILAC ARTIFACT',
  'GREY OFFSITE ARTIFACT', 'GREY OFFSITE WED']) {
  assert.equal(match('MON', label), undefined, label + ' must be ignored');
}
assert.equal(match('MON', 'A2 REAL').room, '2');
assert.equal(match('MON', 'C2 REAL').room, '9');
assert.equal(match('MON', 'C1 GREY CLASS').room, '7');
// IGNORE in the Colours sheet must not globally hide lessons outside its
// restricted location: all three are still visible and require review.
for (const code of ['A2 REAL', 'C2 REAL', 'C1 GREY CLASS']) {
  const lesson = match('MON', code);
  assert.ok(lesson);
  assert.equal(lesson.ignored, false, code + ' must not inherit global IGNORE');
  assert.equal(lesson.teacher, null, code + ' must not be assigned a made-up teacher');
}
assert.equal(api.resolveTeacherColour_('#e5d8f6', {room:'1',offsite:false},
  {'#e5d8f6':'IGNORE'}), 'IGNORE');
assert.equal(api.resolveTeacherColour_('#e5d8f6', {room:'9',offsite:false},
  {'#e5d8f6':'IGNORE'}), null);
assert.equal(api.resolveTeacherColour_('#b7b7b7', {room:'7',offsite:false},
  {'#b7b7b7':'IGNORE'}), null);
assert.equal(api.resolveTeacherColour_('#f3f3f3', {room:'7',offsite:false},
  {'#f3f3f3':'IGNORE'}), 'IGNORE');
const black = match('MON', 'IBC BLACK');
assert.ok(black, 'black-only offsite column must be discovered');
assert.equal(black.teacher, 'Tom Cocker');
assert.equal(black.offsite, true);
assert.equal(black.room, '');
const uncertain = match('MON', 'C1 STATUS UNKNOWN');
assert.ok(uncertain, 'green block should remain visible for review');
assert.equal(uncertain.status, 'uncertain');
assert.equal(uncertain.teacher, null);
assert.equal(api.isUncertainClass_('#D9EAD3'), true);
assert.equal(api.isUncertainClass_('#d9ead2'), false);
assert.ok(!Object.hasOwn(loggedUnknown, '#d9ead3'),
  'green status must not be treated as a newly unassigned teacher colour');
assert.equal(api.isDecorativeCell_('1', '#E5D8F6'), true);
assert.equal(api.isDecorativeCell_('3', '#D9D2E9'), true);
assert.equal(api.isDecorativeCell_('2', '#e5d8f6'), false);
assert.equal(api.isDecorativeCell_('9', '#d9d2e9'), false);
assert.equal(api.isDecorativeCell_('12', '#B7B7B7', false), false);
assert.equal(api.isDecorativeCell_('1', '#b7b7b7', false), false);
assert.equal(api.isDecorativeCell_('', '#B7B7B7', true), true);
assert.equal(api.isDecorativeCell_('', '#e5d8f6', true), false);
assert.equal(api.isClassCode_('127 TEST'), true);
assert.equal(api.isClassCode_('C1+ 66'), true);
assert.equal(api.isClassCode_('1234'), false);
assert.equal(api.isClassCode_('NO CLASE'), false);
assert.equal(api.looksLikeUnknownClassCode_('XYZ 18'), true);
assert.equal(api.looksLikeUnknownClassCode_('SEM 16/11'), false);
assert.equal(match('TUE', 'IBC NNN').offsite, true);
assert.equal(match('WED', 'IBC 38').offsite, true);
assert.equal(match('WED', 'IBC 38').room, '');
for (const [code, teacher] of [['IBC 45', 'Teacher C'], ['ibc NNN', 'Teacher A']]) {
  const c = match('MON', code);
  assert.ok(c, code + ' should be parsed as a lesson');
  assert.equal(c.offsite, true, code + ' should always be offsite');
  assert.equal(c.room, '', code + ' must not occupy its sheet column room');
  assert.equal(c.teacher, teacher);
}
assert.equal(match('MON', 'IBCR 2').offsite, false);
assert.equal(match('MON', 'IBCR 2').room, '11');
assert.equal(api.isIbcClassCode_('IBC'), true);
assert.equal(api.isIbcClassCode_('IBC. 42'), true);
assert.equal(api.isIbcClassCode_('IBCR 42'), false);
assert.equal(api.isIbcClassCode_('XIBC 42'), false);
assert.equal((week.rooms.MON || []).length, 12);
assert.equal((week.rooms.TUE || []).length, 12);
assert.equal((week.rooms.WED || []).length, 12);

const checks = api.validateWeek_(week);
assert.ok(checks.issues.some(x => x.kind === 'possible-class'));
assert.ok(checks.issues.some(x => x.kind === 'unrecognised-code'));
assert.ok(checks.issues.some(x => x.kind === 'unassigned-colour'));
for(const hex of ['#e5d8f6', '#d9d2e9', '#b7b7b7'])
  assert.ok(checks.issues.some(x => x.kind === 'unassigned-colour' &&
    x.message.includes(hex)), 'scoped colour should be reviewable outside scope: '+hex);
assert.ok(!checks.issues.some(x => x.kind === 'uncertain-class'),
  'green blocks must not generate individual validation warnings');
assert.ok(!checks.issues.some(x => x.kind === 'unassigned-colour' && x.message.includes('#d9ead3')));
assert.equal(checks.stats.uncertain, 1);
assert.equal(checks.total, checks.errors + checks.warnings,
  'warning totals must exclude tracked green statuses');
assert.equal(checks.stats.offsite, 5);
assert.ok(!checks.issues.some(x => x.kind === 'missing-room' && x.message.includes('IBC')),
  'IBC lessons must not be diagnosed as missing a room');

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
const possible = api.validateWeek_({
  parserWarnings: [], classes: [
    {day: 'MON', code: 'B2', teacher: 'Ann', room: '3',
     start: '9:00', end: '10:00', colour: '#aaa', status: 'confirmed'},
    {day: 'MON', code: 'Cancelled or maybe', teacher: null, room: '3',
     start: '9:30', end: '10:30', colour: '#d9ead3', status: 'uncertain'}
  ]
});
assert.ok(possible.issues.some(x => x.kind === 'possible-overlap'));
assert.ok(!possible.issues.some(x => x.kind === 'room-overlap'));
assert.equal(possible.errors, 0);
assert.equal(possible.stats.unassigned, 0);
assert.equal(possible.warnings, 1, 'overlap warning still counts even with green blocks');
const greenOnly = api.validateWeek_({
  parserWarnings: [], classes: Array.from({length: 140}, (_, i) => ({
    day: 'MON', code: 'GREEN ' + i, room: String(i + 1),
    start: '09:00', end: '09:30', teacher: null, ignored: false,
    status: 'uncertain', colour: '#d9ead3'
  }))
});
assert.equal(greenOnly.stats.uncertain, 140);
assert.equal(greenOnly.warnings, 0);
assert.equal(greenOnly.errors, 0);
assert.equal(greenOnly.total, 0);
assert.equal(greenOnly.issues.length, 0);
assert.match(code, /c\.teacher === teacher && c\.status !== 'uncertain'/);
assert.ok(!code.includes("colour !== '#000000'"), 'black must not be excluded from offsite candidate detection');
assert.match(code, /c\.offsite \? 'Offsite' : c\.online \? 'Online'/);

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
assert.ok(scripts.length >= 2);
for (const script of scripts) new vm.Script(script[1]);
assert.match(html, /data-view="checks"/);
assert.match(html, /function renderDayOverview/);
assert.match(html, /function renderChecks/);
assert.match(html, /function classPlace\(c\) \{ return c\.offsite \? 'Offsite'/);
assert.match(html, /c\.day === day && !c\.offsite/);
assert.match(html, /Cancelled \/ to confirm/);
assert.match(html, /confirmed = list\.filter\(c => !isUncertain\(c\)\)/);
console.log('PASS: black offsite classes, scoped IGNORE colours, class parsing, warnings, conflicts, and frontend syntax.');
