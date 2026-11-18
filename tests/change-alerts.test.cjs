'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const js = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).join('\n');
const monday = '2026-11-16T00:00:00';
const previousClass = {
  day: 'WED', start: '18:00', end: '19:00', room: '3',
  online: false, offsite: false, code: 'B2 65', notes: '', status: 'confirmed'
};
const greenClass = {
  ...previousClass, colour: '#d9ead3', status: 'uncertain', teacher: null
};
const confirmedClass = {
  ...previousClass, colour: '#ffaabb', status: 'confirmed', teacher: 'Alice'
};

class MockElement {
  constructor(id) {
    this.id = id;
    this.value = ''; this.textContent = ''; this.innerHTML = '';
    this.options = []; this.listeners = {}; this.attrs = {}; this.dataset = {};
    this.hidden = false; this.disabled = false;
    this.classList = { toggle() {} };
  }
  addEventListener(event, fn) { this.listeners[event] = fn; }
  setAttribute(attr, value) { this.attrs[attr] = value; }
  add(option) { this.options.push(option); }
  remove(i) { this.options.splice(i, 1); }
  showModal() {}
  get selectedOptions() { return this.options.filter(o => o.value === this.value); }
}
function start({previous = [previousClass], current = [greenClass], otherPrevious = null} = {}) {
  const storage = new Map([['tipHome', 'done'], ['teacher', 'Alice']]);
  if (previous !== null) storage.set('seen:Alice:' + monday, JSON.stringify(previous));
  if (otherPrevious) storage.set('seen:Bob:' + monday, JSON.stringify(otherPrevious));
  const week = {
    found: true, mondayIso: monday, mondayLabel: '16 Nov 2026',
    teachers: ['Alice', 'Bob'],
    rooms: {MON: ['3'], TUE: ['3'], WED: ['3'], THU: ['3'], FRI: ['3']},
    slots: ['17:30', '18:00', '18:30', '19:00', '19:30'],
    classes: current
  };
  const response = {weeks: [week, {...week, mondayIso: '2026-11-23T00:00:00', classes: []}]};
  const ids = ['teacher', 'out', 'rDay', 'rTime', 'rDuration', 'syncStatus',
    'syncBar', 'refreshBtn', 'calBtn', 'calPanel', 'tip', 'tipOk', 'title',
    'sub', 'weeks', 'roomPick', 'weekDisplay', 'lessonDialog', 'lessonTitle',
    'lessonWhen', 'lessonPlace', 'lessonStatus', 'lessonNotes'];
  const elements = new Map(ids.map(id => [id, new MockElement(id)]));
  elements.get('teacher').options = [{value: ''}];
  elements.get('rDuration').value = '30';
  const views = ['week', 'today', 'rooms', 'checks'].map(view => {
    const e = new MockElement('view-' + view);
    e.dataset.view = view;
    return e;
  });
  const weekButtons = [0, 1].map(n => {
    const e = new MockElement('week-' + n); e.dataset.week = String(n); return e;
  });
  const modes = ['list', 'calendar'].map(mode => {
    const e = new MockElement('mode-' + mode); e.dataset.weekMode = mode; return e;
  });
  const document = {
    hidden: false,
    getElementById: id => elements.get(id),
    querySelectorAll(selector) {
      return selector === '[data-view]' ? views :
        selector === '[data-week]' ? weekButtons :
          selector === '[data-week-mode]' ? modes : [];
    },
    querySelector(selector) {
      if (selector === '.wrap') return {classList: {toggle() {}}};
      if (/^\[data-week="[01]"\] small$/.test(selector)) return {textContent: ''};
      return null;
    },
    addEventListener() {}
  };
  const ActualDate = Date;
  class FixedDate extends ActualDate {
    constructor(...args) { super(...(args.length ? args : ['2026-11-18T17:30:00'])); }
    static now() { return new ActualDate('2026-11-18T17:30:00').valueOf(); }
  }
  const ctx = vm.createContext({
    document, window: {addEventListener() {}}, navigator: {onLine: true},
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value))
    },
    fetch: async () => ({ok: true, json: async () => response}),
    setInterval() {}, Option: function(label, value) {
      this.textContent = label; this.value = value;
    },
    Date: FixedDate
  });
  vm.runInContext(js, ctx);
  const helper = vm.runInContext('({render,teacherLessons,changesFor})', ctx);
  return {elements, views, week, response, storage, helper,
    async settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); },
    acknowledge() {
      const listener = elements.get('out').listeners.click;
      assert.equal(typeof listener, 'function');
      listener({target: {closest: selector =>
        selector === '[data-action="ack"]' ? {} : null}});
    },
    async refresh() {
      await elements.get('refreshBtn').onclick();
      await this.settle();
    }
  };
}

(async () => {
  // Exact previous class -> green block is matched to Alice.
  const app = start();
  await app.settle();
  const htmlBefore = app.elements.get('out').innerHTML;
  assert.match(htmlBefore, /B2 65/);
  assert.match(htmlBefore, /Cancelled \/ to confirm/);
  assert.match(htmlBefore, /Previously confirmed\. Please check with the coordinator/);
  assert.doesNotMatch(htmlBefore, /<b>Removed<\/b>/);
  assert.equal(app.helper.teacherLessons(app.week, 'Alice').length, 1);
  assert.equal(app.helper.teacherLessons(app.week, 'Alice')[0].matchedFromPrevious, true);
  assert.equal(app.helper.teacherLessons(app.week, 'Bob').length, 0);

  // Acknowledge removes only the change alert, not the green lesson.
  app.acknowledge();
  const afterAck = app.elements.get('out').innerHTML;
  assert.doesNotMatch(afterAck, /<h2>1 timetable change/);
  assert.match(afterAck, /Cancelled \/ to confirm/);
  const saved = JSON.parse(app.storage.get('seen:Alice:' + monday));
  assert.equal(saved[0].status, 'uncertain');
  assert.equal(app.helper.teacherLessons(app.week, 'Alice').length, 1);
  await app.refresh();
  assert.match(app.elements.get('out').innerHTML, /Cancelled \/ to confirm/);

  // Once confirmed again, report a status change back, not an unrelated new class.
  app.week.classes = [confirmedClass];
  await app.refresh();
  const restored = app.elements.get('out').innerHTML;
  assert.match(restored, /Confirmed again/);
  assert.match(restored, /Previously cancelled \/ to confirm/);
  assert.doesNotMatch(restored, /<b>Removed<\/b>/);

  // Today displays the matched green status, but excludes it from confirmed hours.
  const today = start(); await today.settle();
  today.views.find(v => v.dataset.view === 'today').onclick();
  const daily = today.elements.get('out').innerHTML;
  assert.match(daily, /Cancelled \/ to confirm/);
  assert.match(daily, /No confirmed classes today/);
  assert.doesNotMatch(daily, /Teaching now/);

  // No saved previous timetable -> never guess the teacher.
  const firstTime = start({previous: null}); await firstTime.settle();
  assert.equal(firstTime.helper.teacherLessons(firstTime.week, 'Alice').length, 0);
  assert.doesNotMatch(firstTime.elements.get('out').innerHTML, /Cancelled \/ to confirm/);

  // Time or room mismatch must not attribute the green block to the teacher.
  for (const mismatch of [
    {...greenClass, start: '18:30', end: '19:30'},
    {...greenClass, room: '4'},
    {...greenClass, code: 'B2 66'}
  ]) {
    const noMatch = start({current: [mismatch]}); await noMatch.settle();
    assert.equal(noMatch.helper.teacherLessons(noMatch.week, 'Alice').length, 0);
    assert.match(noMatch.elements.get('out').innerHTML, /<b>Removed<\/b>/);
    assert.doesNotMatch(noMatch.elements.get('out').innerHTML, /Previously confirmed\. Please check/);
  }
  // Duplicate green cells or competing teacher baselines are ambiguous.
  const duplicates = start({current: [greenClass, {...greenClass}]});
  await duplicates.settle();
  assert.equal(duplicates.helper.teacherLessons(duplicates.week, 'Alice').length, 0);
  const shared = start({otherPrevious: [previousClass]});
  await shared.settle();
  assert.equal(shared.helper.teacherLessons(shared.week, 'Alice').length, 0);

  console.log('PASS: green status matching, acknowledgement, recovery, Today, and ambiguity safeguards.');
})().catch(err => { console.error(err); process.exitCode = 1; });
