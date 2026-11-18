/**
 * Staff timetable — Apps Script web app
 *
 * Reads the head of studies' weekly timetable spreadsheets (shared with this
 * account) and shows each teacher their own week.
 *
 * Setup: see the reply in chat. In short —
 *   1. Create a new Google Sheet ("Timetable app"), Extensions > Apps Script.
 *   2. Paste this file as Code.gs and Index.html as an HTML file named Index.
 *   3. Run setup() once, then Deploy > New deployment > Web app.
 */

// ---------- Settings ----------
// Everyone who may create the weekly timetable files. Add an address here if
// someone new starts making them.
const SOURCE_OWNERS = [
  'patriciaswiftzgz@gmail.com',
  'susanaswift1@gmail.com',
];
const GRID_TAB = 'TT';                             // tab name in each weekly file
// Extra people to receive warnings (you always get them), e.g. the head of studies.
const ALERT_ALSO = [];
const COLOURS_TAB = 'Colours';                     // tab in THIS sheet: colour -> teacher
const IGNORE = 'IGNORE';                           // not a teacher: hidden, but the room still counts as in use
// Lilac artefacts apply only to Rooms 1 and 3; grey applies only to offsite columns.
// A matching colour in any other place may represent a real class.
// Unlike the IGNORE teacher, artefacts do NOT occupy a classroom or count as lessons.
const ROOM_DECORATIVE_COLOURS = ['#e5d8f6', '#d9d2e9'];
const OFFSITE_DECORATIVE_COLOURS = ['#b7b7b7'];
// This green colour covers lessons that are cancelled OR awaiting confirmation.
// The colour alone cannot distinguish which. Never report it as confirmed.
const UNCERTAIN_CLASS_COLOUR = '#d9ead3';
function isUncertainClass_(colour) {
  return String(colour || '').trim().toLowerCase() === UNCERTAIN_CLASS_COLOUR;
}
function isDecorativeCell_(room, colour, offsite) {
  const hex = String(colour || '').trim().toLowerCase();
  if (offsite && OFFSITE_DECORATIVE_COLOURS.includes(hex)) return true;
  return !offsite && (String(room).trim() === '1' || String(room).trim() === '3') &&
    ROOM_DECORATIVE_COLOURS.includes(hex);
}

// Explicit course families, supplemented by flexible numbered-code recognition.
// Ambiguous unfamiliar codes are flagged for review rather than split blindly.
const CLASS_PREFIXES = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', '121', '122', '123', '124', '125',
  'IBC', 'DOM', 'KET', 'PET', 'FCE', 'CAE', 'CPE', 'IELTS', 'TOEFL', 'K1', 'K2', 'K3',
  'K4', 'K5', 'MOVERS', 'STARTERS', 'FLYERS'];

// ---------- Web app ----------
// Speed: a background trigger (refreshScheduled, every 10 minutes) reads this
// week's and next week's files and keeps the result ready in the cache. The page
// arrives with that data already inside it, so opening the app doesn't wait on
// Drive or the timetable sheets.
const SNAPSHOT_KEY = 'snapshot_v15';
const CACHE_SECONDS = 6 * 60 * 60;   // the longest Apps Script allows

function doGet(e) {
  // ...?ics=Teacher%20Name gives that teacher's calendar feed instead of the page.
  if (e && e.parameter && e.parameter.ics) return icsFeed_(e.parameter.ics);
  // ...?api=weeks gives this week's and next week's data as JSON, for the page on GitHub Pages.
  if (e && e.parameter && e.parameter.api === 'weeks') {
    let body;
    try {
      const snap = getSnapshot_() || refreshSnapshot();
      body = { weeks: snap.weeks, appUrl: ScriptApp.getService().getUrl() };
    } catch (err) {
      body = { error: String(err.message || err) };
    }
    return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
  }

  const t = HtmlService.createTemplateFromFile('Index');
  const snap = getSnapshot_();       // null if not ready: the page then asks getWeek()
  t.boot = JSON.stringify(snap).replace(/</g, '\\u003c');
  t.appUrl = JSON.stringify(ScriptApp.getService().getUrl());
  return t.evaluate()
    .setTitle('My timetable')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Called from the page when the data didn't arrive with it. 0 = this week, 1 = next week. */
function getWeek(weekOffset) {
  const snap = getSnapshot_() || refreshSnapshot();
  return snap.weeks[weekOffset || 0];
}

/** Trigger target. Skips the night; the 6:00 run rebuilds everything before staff look. */
function refreshScheduled() {
  if (new Date().getHours() < 6) return;
  refreshSnapshot();
}

function refreshSnapshot() {
  const weeks = listWeeks_();
  const map = readColourMap_();
  const teachers = [...new Set(Object.values(map).filter(n => n !== IGNORE))].sort();
  // Parsed weeks are reused until the file or the Colours tab changes.
  const mapKey = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(map))).slice(0, 10);
  const snap = {
    thisMonday: mondayOf_(new Date()).toISOString(),
    weeks: [0, 1].map(o => buildWeek_(o, weeks, teachers, mapKey)),
  };
  putBig_(SNAPSHOT_KEY, JSON.stringify(snap), CACHE_SECONDS);
  return snap;
}

function getSnapshot_() {
  const raw = getBig_(SNAPSHOT_KEY);
  if (!raw) return null;
  const snap = JSON.parse(raw);
  // Built before the week rolled over (e.g. last Friday's snapshot on Monday): rebuild.
  return snap.thisMonday === mondayOf_(new Date()).toISOString() ? snap : null;
}

function buildWeek_(offset, weeks, teachers, mapKey) {
  const target = mondayOf_(new Date());
  target.setDate(target.getDate() + 7 * offset);
  const week = weeks.find(w => sameDay_(w.monday, target));
  if (!week) {
    return {
      found: false, mondayIso: target.toISOString(), mondayLabel: fmtDate_(target), teachers: teachers,
      validation: { errors: offset === 0 ? 1 : 0, warnings: offset === 0 ? 0 : 1, total: 1,
        stats: { total: 0, teachers: 0, unassigned: 0, offsite: 0 },
        issues: [{ severity: offset === 0 ? 'error' : 'warning', kind: 'missing-week',
          message: 'No timetable file found for the week of ' + fmtDate_(target) + '.',
          day: '', time: '', room: '' }] }
    };
  }
  const key = 'parse9_' + week.id + '_' + week.modified + '_' + mapKey;
  const hit = getBig_(key);
  let parsed = hit ? JSON.parse(hit) : null;
  if (!parsed) {
    parsed = parseWeek_(week.id);
    putBig_(key, JSON.stringify(parsed), CACHE_SECONDS);
  }
  return {
    found: true,
    mondayIso: week.monday.toISOString(),
    mondayLabel: fmtDate_(week.monday),
    title: week.title,
    teachers: teachers,
    ...parsed,                       // classes, rooms, slots
    validation: validateWeek_(parsed),
  };
}

/** Editing the Colours tab clears the ready-made data, so the change shows on the next load. */
function onEdit(e) {
  if (e && e.range && e.range.getSheet().getName() === COLOURS_TAB) {
    CacheService.getScriptCache().remove(SNAPSHOT_KEY);
  }
}

// Cache entries are limited to 100 KB, so larger values are split into parts.
function putBig_(key, str, seconds) {
  const size = 40000, parts = {}, n = Math.ceil(str.length / size) || 1;
  for (let i = 0; i < n; i++) parts[key + '_' + i] = str.substr(i * size, size);
  parts[key] = String(n);
  try { CacheService.getScriptCache().putAll(parts, seconds); } catch (e) { /* too big: skip caching */ }
}
function getBig_(key) {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get(key) || 0);
  if (!n) return null;
  const keys = Array.from({ length: n }, (_, i) => key + '_' + i);
  const got = cache.getAll(keys);
  return keys.every(k => got[k] != null) ? keys.map(k => got[k]).join('') : null;
}

// ---------- Finding the weekly files ----------
/**
 * Titles are typed by hand and vary ("1O AL 14 AGOSTO", "28/09 a 2 octubre"),
 * so the week is worked out from the sheet itself: the Monday date number in
 * the header row, placed on the first Monday on or after the file was created.
 */
function listWeeks_() {
  const props = PropertiesService.getScriptProperties();
  const known = JSON.parse(props.getProperty('weeks') || '{}'); // id -> monday ISO

  const owners = SOURCE_OWNERS.map(o => "'" + o + "' in owners").join(' or ');
  const since = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 19);
  const q = "mimeType = 'application/vnd.google-apps.spreadsheet' and (" +
            owners + ") and trashed = false and modifiedDate > '" + since + "'";
  const files = [];
  const it = DriveApp.searchFiles(q);
  while (it.hasNext()) files.push(it.next());
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated());

  const weeks = [];
  files.slice(0, 6).forEach(f => {
    const id = f.getId();
    let mondayIso = known[id];
    if (!mondayIso) {
      const monday = mondayFromFile_(f);
      if (!monday) return;
      mondayIso = monday.toISOString();
      known[id] = mondayIso;
    }
    weeks.push({
      id: id,
      title: f.getName().trim(),
      modified: f.getLastUpdated().getTime(),
      monday: new Date(mondayIso),
    });
  });
  props.setProperty('weeks', JSON.stringify(known));
  return weeks;
}

function mondayFromFile_(file) {
  const sheet = gridSheet_(SpreadsheetApp.openById(file.getId()));
  const top = sheet.getRange(1, 1, 15, Math.min(sheet.getLastColumn(), 40)).getDisplayValues();
  const dayRow = top.findIndex(r => r.includes('MON'));
  if (dayRow < 1) return null;
  const col = top[dayRow].indexOf('MON');
  const dayNum = parseInt(top[dayRow - 1][col], 10);
  if (!dayNum) return null;

  const d = mondayOf_(file.getDateCreated());
  for (let i = 0; i < 10; i++) {       // look up to 10 weeks ahead
    if (d.getDate() === dayNum) return d;
    d.setDate(d.getDate() + 7);
  }
  return null;
}

// ---------- Parsing one week ----------
function parseWeek_(fileId) {
  const { text, bg } = readGrid_(fileId);
  const lastRow = text.length, lastCol = text[0].length;

  const dayRow = text.findIndex(r => r.includes('MON'));
  if (dayRow < 1) throw new Error('Could not find the MON/TUE header row.');
  const dateRow = dayRow - 1, roomRow = dayRow + 1;
  const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

  // Columns that belong to a day: day label AND a date number above it.
  // (Some weeks have extra labelled columns without a date; those are skipped.)
  const cols = [];
  for (let c = 0; c < lastCol; c++) {
    const day = text[dayRow][c].trim();
    if (DAYS.includes(day) && /^\d+$/.test(text[dateRow][c].trim())) {
      cols.push({ c: c, day: day, room: text[roomRow][c].trim() });
    }
  }

  // Time rows: every row between the top room-number row and the repeated
  // header at the bottom is one half hour. A time label sits on the row ABOVE
  // the line where that time starts, so the first row (labelled 8:00) is the
  // half hour before 8:00, and the row under it starts at 8:00.
  // (The ":00"/":30" labels are typed by hand and often missing, so they're not used.)
  const firstRow = roomRow + 1;
  const startHour = parseInt(text[firstRow][0], 10) || 8;
  const monCols = cols.filter(c => c.day === 'MON').map(c => c.c);
  const isHeader = row => row.includes('MON') ||
    monCols.filter(c => row[c] !== '' && row[c] === text[roomRow][c]).length >= Math.min(5, monCols.length);
  const times = [];
  for (let r = firstRow; r < lastRow && times.length < 40; r++) {
    if (isHeader(text[r])) break;                                    // repeated header at the bottom
    times.push({ r: r, mins: startHour * 60 - 30 + 30 * (r - firstRow) });
  }

  // A school's offsite lessons sit in the unnumbered column immediately
  // after Room 12. Some days repeat the day name there without a date;
  // other days leave both header cells blank. These columns were previously
  // skipped because they are not numbered classrooms.
  // Only include a candidate if it actually contains coloured lesson text,
  // so separator/decoration columns never become timetable entries.
  cols.filter(col => col.room === '12').forEach(room12 => {
    const c = room12.c + 1;
    if (c >= lastCol || cols.some(col => col.c === c)) return;
    const dayLabel = (text[dayRow][c] || '').trim();
    const roomLabel = (text[roomRow][c] || '').trim();
    if (dayLabel && dayLabel !== room12.day && !/^off[ -]?site$/i.test(dayLabel)) return;
    if (/^\d+$/.test(roomLabel)) return; // another numbered room, not offsite
    const hasLesson = times.some(t => {
      const label = (text[t.r][c] || '').trim();
      const colour = ((bg[t.r] || [])[c] || '#ffffff').toLowerCase();
      return label && colour !== '#ffffff' && colour !== '#000000' &&
        !isDecorativeCell_('', colour, true) && !/^\d{1,2}:\d{2}$/.test(label);
    });
    if (hasLesson) cols.push({ c: c, day: room12.day, room: '', offsite: true });
  });

  const colourMap = readColourMap_();
  const unknown = {};
  const classes = [];
  const parserWarnings = [];

  cols.forEach(col => {
    let cur = null;
    const close = () => {
      if (!cur) return;
      // A single unlabelled half hour is decoration, not a class: some weeks fill
      // empty cells with a striped pattern (e.g. to mark a day off).
      const keep = cur.code || cur.notes.length || cur.end - cur.start > 30;
      if (keep) {
        classes.push(cur);
        if (!cur.teacher && !isUncertainClass_(cur.colour) && !unknown[cur.colour]) {
          unknown[cur.colour] = cur.day + ' ' + fmtMins_(cur.start) +
            (cur.offsite ? ' offsite' : ' room ' + cur.room) +
            (cur.code ? ' "' + cur.code + '"' : '');
        }
      }
      cur = null;
    };
    times.forEach(t => {
      const colour = (bg[t.r][col.c] || '#ffffff').toLowerCase();
      const cell = text[t.r][col.c].replace(/\s+/g, ' ').trim();
      // Treat these formatting-only cells exactly like empty space, so they
      // neither extend a lesson nor create one or block the Free Rooms finder.
      if (colour === '#ffffff' || isDecorativeCell_(col.room, colour, !!col.offsite)) {
        close();
        return;
      }
      // Same colour continues the class, unless the cell holds a new class code
      // (a teacher's back-to-back classes in one room share a colour).
      if (cur && cur.colour === colour && !(cell && isClassCode_(cell))) {
        cur.end = t.mins + 30;
        if (cell) {
          // A plausible unfamiliar course label in the middle of a same-colour
          // block might be a missed new lesson: surface it rather than guessing.
          if (looksLikeUnknownClassCode_(cell)) parserWarnings.push({
            day: col.day, time: fmtMins_(t.mins), room: cur.offsite ? 'Offsite' : cur.room,
            message: 'Possible new class code "' + cell + '" inside "' +
              (cur.code || 'unlabelled block') + '". Check whether this starts another lesson.'
          });
          cur.notes.push(cell);
        }
        return;
      }
      close();
      const teacher = colourMap[colour];
      // IBC lessons are always offsite, regardless of the spreadsheet column.
      const offsite = !!col.offsite || isIbcClassCode_(cell);
      cur = {
        day: col.day, room: offsite ? '' : col.room, offsite: offsite,
        start: t.mins, end: t.mins + 30,
        code: cell, notes: [], colour: colour, teacher: teacher || null,
        status: isUncertainClass_(colour) ? 'uncertain' : 'confirmed',
      };
    });
    close();
  });

  logUnknownColours_(unknown);
  // Rooms per day, for the free-room finder (not every day has every room).
  const rooms = {};
  cols.forEach(col => { if (!col.offsite && col.room) (rooms[col.day] = rooms[col.day] || []).push(col.room); });

  return {
    // Every coloured block is returned, so free rooms can be worked out;
    // only blocks with a real teacher appear in anyone's timetable.
    classes: classes.map(k => {
      // "o.l." (or "OL", "online") anywhere in the block means an online class.
      const isOL = t => /^(o\.?\s?l\.?|online)$/i.test(t.trim());
      const online = isOL(k.code || '') || k.notes.some(isOL);
      return {
        day: k.day, room: k.room, offsite: !!k.offsite,
        start: fmtMins_(k.start), end: fmtMins_(k.end),
        code: isOL(k.code || '') ? 'Online class' : (k.code || '(no label)'),
        notes: k.notes.filter(n => !isOL(n)).join(' / '),
        online: online,
        colour: k.colour, teacher: k.teacher === IGNORE ? null : k.teacher,
        ignored: k.teacher === IGNORE, status: k.status || 'confirmed',
      };
    }),
    rooms: rooms,
    slots: times.map(t => fmtMins_(t.mins)),
    parserWarnings: parserWarnings,
  };
}

// ---------- Colour -> teacher table ----------
function readColourMap_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(COLOURS_TAB);
  const map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(([hex, name]) => {
    if (hex && name) map[String(hex).toLowerCase().trim()] = String(name).trim();
  });
  return map;
}

function listTeachers_() {
  const names = Object.values(readColourMap_()).filter(n => n !== IGNORE);
  return [...new Set(names)].sort();
}

/** New colours go to the bottom of the Colours tab with an example, teacher left blank. */
function logUnknownColours_(unknown) {
  const hexes = Object.keys(unknown);
  if (!hexes.length) return;
  const sh = coloursSheet_();
  const existing = sh.getLastRow() > 1
    ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0]).toLowerCase())
    : [];
  hexes.filter(h => !existing.includes(h)).forEach(h => {
    sh.appendRow([h, '', 'NEW — first seen ' + unknown[h]]);
    sh.getRange(sh.getLastRow(), 4).setBackground(h);
  });
}

function coloursSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(COLOURS_TAB);
  if (!sh) {
    sh = ss.insertSheet(COLOURS_TAB);
    sh.appendRow(['Colour', 'Teacher', 'Where it came from', 'Swatch']);
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * Run once from the editor. Seeds the Colours tab from the legend in the most
 * recent weekly file (the TEACHER column). Legend rows with no name are skipped.
 */
function setup() {
  const weeks = listWeeks_();
  if (!weeks.length) throw new Error('No timetable files from ' + SOURCE_OWNERS.join(', ') + ' found.');
  const { text, bg } = readGrid_(weeks[0].id);

  let hr = -1, hc = -1;
  text.some((row, r) => { const c = row.indexOf('TEACHER'); if (c > -1) { hr = r; hc = c; return true; } });
  if (hr < 0) throw new Error('Could not find the TEACHER legend.');

  const sh = coloursSheet_();
  const have = readColourMap_();
  for (let r = hr + 1; r < Math.min(hr + 30, text.length); r++) {
    const name = text[r][hc].trim(), hex = bg[r][hc].toLowerCase();
    if (!text[r][hc - 1].trim() && !name) break;          // end of legend
    if (!name || hex === '#ffffff' || have[hex]) continue;
    sh.appendRow([hex, titleCase_(name), 'Legend in ' + weeks[0].title]);
    sh.getRange(sh.getLastRow(), 4).setBackground(hex);
  }
  parseWeek_(weeks[0].id); // also logs grid colours that don't match the legend
}

// ---------- Helpers ----------
function isIbcClassCode_(cell) {
  return /^IBC(?=$|[\s+.-])/i.test(String(cell || '').trim());
}
function isClassCode_(cell) {
  const s = String(cell || '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!s) return false;
  // New three-digit course codes (126, 127, etc.) do not require a code release.
  // Do not accept a year, a date, or a four-digit student number.
  if (/^[1-9]\d{2}(?=$|[\s+.-])/.test(s)) return true;
  // CEFR-family and young learner levels; K4/K5 can be followed by a suffix.
  if (/^(?:[ABC][12]|K\d{1,2})\+?(?=$|[\s.-])/.test(s)) return true;
  return CLASS_PREFIXES.some(prefix =>
    s === prefix || (s.startsWith(prefix) && /^[\s+.-]/.test(s.slice(prefix.length))));
}

/** Only strong unknown-label candidates are flagged, never automatically split. */
function looksLikeUnknownClassCode_(cell) {
  const s = String(cell || '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!s || isClassCode_(s) || /^(?:O\.?\s?L\.?|ONLINE|NO CLASE|SEM\b)/.test(s)) return false;
  // e.g. B3 25, XYZ 14. Names, dates and simple class notes are not warnings.
  return /^(?:[A-Z]{1,6}\d{1,2}\+?|[A-Z]{1,6}\+?)\s+\d{1,3}[A-Z]?$/.test(s);
}

function validateWeek_(parsed) {
  const all = [];
  const push = (severity, kind, message, c) => all.push({
    severity: severity, kind: kind, message: message,
    day: (c && c.day) || '', time: (c && c.start) || (c && c.time) || '',
    room: (c && (c.offsite ? 'Offsite' : c.room)) || ''
  });
  (parsed.parserWarnings || []).forEach(w =>
    push('warning', 'possible-class', w.message, { day: w.day, time: w.time, room: w.room }));
  const classes = parsed.classes || [];
  const location = c => c.offsite ? 'Offsite' : c.online ? 'Online' : c.room ? 'Room ' + c.room : 'no room';
  const mins = t => { const p = String(t || '').split(':').map(Number); return p[0] * 60 + p[1]; };
  const unknown = {};
  classes.forEach(c => {
    if (c.status === 'uncertain') {
      push('warning', 'uncertain-class',
        'The green block "' + c.code + '" may be cancelled or awaiting confirmation. ' +
        'The colour alone cannot tell which; confirm with the original timetable.', c);
    }
    if (!c.ignored && c.status !== 'uncertain' && !c.teacher && !unknown[c.colour || 'unknown']) {
      unknown[c.colour || 'unknown'] = true;
      push('warning', 'unassigned-colour',
        'Unassigned timetable colour ' + (c.colour || '(missing)') + ': lessons using it are hidden from teachers.',
        c);
    }
    if (c.code === '(no label)' || !String(c.code || '').trim()) {
      push('warning', 'missing-label', 'Occupied block has no class label (' + location(c) + ').', c);
    } else if (looksLikeUnknownClassCode_(c.code)) {
      push('warning', 'unrecognised-code',
        'Check unfamiliar class label "' + c.code + '" (' + location(c) + ').', c);
    }
    if (!c.offsite && !c.online && !c.room) {
      push('warning', 'missing-room', '"' + c.code + '" has no classroom or offsite designation.', c);
    }
    if (!Number.isFinite(mins(c.start)) || !Number.isFinite(mins(c.end)) ||
      mins(c.start) >= mins(c.end)) {
      push('error', 'invalid-time', '"' + c.code + '" has an invalid time range.', c);
    }
  });
  if (!classes.length) push('error', 'empty-timetable', 'No lesson blocks were detected in this timetable.');
  const days = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
  days.forEach(day => {
    const dayClasses = classes.filter(c => c.day === day && Number.isFinite(mins(c.start)) &&
      Number.isFinite(mins(c.end)) && mins(c.start) < mins(c.end));
    for (let i = 0; i < dayClasses.length; i++) {
      const a = dayClasses[i];
      for (let j = i + 1; j < dayClasses.length; j++) {
        const b = dayClasses[j];
        if (mins(a.start) >= mins(b.end) || mins(b.start) >= mins(a.end)) continue;
        const interval = [a.start, b.start].sort((x, y) => mins(x) - mins(y))[1] +
          '–' + [a.end, b.end].sort((x, y) => mins(x) - mins(y))[0];
        // An uncertain block is not a confirmed clash; flag possible overlap only.
        if (a.status === 'uncertain' || b.status === 'uncertain') {
          if ((a.teacher && a.teacher === b.teacher) ||
              (!a.offsite && !b.offsite && !a.online && !b.online && a.room && a.room === b.room)) {
            push('warning', 'possible-overlap',
              'A cancelled/to-confirm block "' + a.code + '" or "' + b.code +
              '" overlaps another block (' + interval + '). Confirm before using the room.', a);
          }
          continue;
        }
        // Same teacher in two classes at once: a conflict even if rooms differ.
        if (a.teacher && a.teacher === b.teacher) {
          push('error', 'teacher-overlap',
            a.teacher + ' has overlapping lessons "' + a.code + '" and "' + b.code +
            '" (' + interval + ').', a);
        }
        // Two bookings for one physical classroom; online/offsite do not count.
        if (!a.offsite && !b.offsite && !a.online && !b.online && a.room && a.room === b.room) {
          push('error', 'room-overlap',
            'Room ' + a.room + ' has overlapping lessons "' + a.code + '" and "' + b.code +
            '" (' + interval + ').', a);
        }
      }
    }
  });
  return {
    errors: all.filter(i => i.severity === 'error').length,
    warnings: all.filter(i => i.severity === 'warning').length,
    total: all.length,
    // Keep the response bounded if a badly formatted sheet creates hundreds of warnings.
    issues: all.slice(0, 100),
    stats: {
      total: classes.length,
      teachers: [...new Set(classes.map(c => c.teacher).filter(Boolean))].length,
      unassigned: classes.filter(c => !c.teacher && !c.ignored && c.status !== 'uncertain').length,
      offsite: classes.filter(c => c.offsite).length,
      uncertain: classes.filter(c => c.status === 'uncertain').length
    }
  };
}
/**
 * Reads the grid as it LOOKS, including conditional formatting. Some cells carry
 * a hidden colour underneath that a conditional-format rule paints white;
 * SpreadsheetApp's getBackgrounds() would return the hidden colour, so this uses
 * the Sheets API (Services > Google Sheets API must be added in the editor).
 */
function readGrid_(fileId) {
  if (typeof Sheets === 'undefined') {
    throw new Error('Add the Google Sheets API service: in the Apps Script editor, Services > + > Google Sheets API > Add.');
  }
  const ss = SpreadsheetApp.openById(fileId);
  const sheet = gridSheet_(ss);
  const nRows = sheet.getLastRow(), nCols = sheet.getLastColumn();
  const res = Sheets.Spreadsheets.get(fileId, {
    ranges: ["'" + sheet.getName().replace(/'/g, "''") + "'"],
    includeGridData: true,
    fields: 'sheets.data.rowData.values(formattedValue,effectiveFormat.backgroundColor)',
  });
  const rows = (res.sheets[0].data[0].rowData || []);
  const text = [], bg = [];
  for (let r = 0; r < nRows; r++) {
    const vals = (rows[r] && rows[r].values) || [];
    const t = [], b = [];
    for (let c = 0; c < nCols; c++) {
      const cell = vals[c] || {};
      t.push(cell.formattedValue || '');
      const col = cell.effectiveFormat && cell.effectiveFormat.backgroundColor;
      b.push(col ? toHex_(col) : '#ffffff');   // no format at all = white
    }
    text.push(t); bg.push(b);
  }
  return { text: text, bg: bg };
}
function toHex_(c) {
  const h = v => ('0' + Math.round((v || 0) * 255).toString(16)).slice(-2);
  return '#' + h(c.red) + h(c.green) + h(c.blue);
}
function gridSheet_(ss) { return ss.getSheetByName(GRID_TAB) || ss.getSheets()[0]; }
function mondayOf_(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = d.getDay();                  // Sun 0 .. Sat 6
  d.setDate(d.getDate() + (dow === 6 ? 2 : dow === 0 ? 1 : 1 - dow)); // weekend -> next Monday
  return d;
}
function sameDay_(a, b) { return a.toDateString() === b.toDateString(); }
function fmtDate_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'd MMM yyyy'); }
function fmtMins_(m) { return Math.floor(m / 60) + ':' + ('0' + (m % 60)).slice(-2); }
function titleCase_(s) { return s.toLowerCase().replace(/\b\w/g, ch => ch.toUpperCase()); }

// ---------- Email when a new colour turns up ----------
/**
 * Run installDailyCheck() once from the editor. Every morning it reads this
 * week's and next week's files; if a colour with no teacher has appeared
 * since the last email, it emails you. No new colours, no email.
 */
/** Run once from the editor: 10-minute refresh, 8:00 colour check, 20:00 timetable check. */
function installTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['checkNewColours', 'refreshScheduled', 'checkHealth'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkNewColours').timeBased().everyDays(1).atHour(8).create();
  ScriptApp.newTrigger('checkHealth').timeBased().everyDays(1).atHour(20).create();
  ScriptApp.newTrigger('refreshScheduled').timeBased().everyMinutes(10).create();
  refreshSnapshot();
}
function installDailyCheck() { installTriggers(); }   // older name, still works

function checkNewColours() {
  const thisMon = mondayOf_(new Date());
  const nextMon = new Date(thisMon); nextMon.setDate(nextMon.getDate() + 7);
  listWeeks_()
    .filter(w => sameDay_(w.monday, thisMon) || sameDay_(w.monday, nextMon))
    .forEach(w => parseWeek_(w.id));           // adds any new colours to the Colours tab

  const sh = coloursSheet_();
  if (sh.getLastRow() < 2) return;
  const waiting = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues()
    .filter(([hex, name]) => hex && !String(name).trim());

  const props = PropertiesService.getScriptProperties();
  const told = JSON.parse(props.getProperty('notified') || '[]');
  const fresh = waiting.filter(([hex]) => !told.includes(String(hex).toLowerCase()));
  if (!fresh.length) return;

  const ss = SpreadsheetApp.getActive();
  const body =
    'The timetable has ' + fresh.length + ' colour' + (fresh.length > 1 ? 's' : '') +
    ' with no teacher assigned. Classes in these colours are hidden from staff until you add a name.\n\n' +
    fresh.map(([hex, , where]) => '• ' + hex + ': ' + String(where).replace(/^NEW — /, '')).join('\n') +
    '\n\nAdd the teacher (or IGNORE) in the Colours tab:\n' + ss.getUrl() + '#gid=' + sh.getSheetId();

  MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
    'Timetable: ' + fresh.length + ' new colour' + (fresh.length > 1 ? 's' : '') + ' to assign', body);

  props.setProperty('notified', JSON.stringify(told.concat(fresh.map(([hex]) => String(hex).toLowerCase()))));
}


// ---------- Calendar feed ----------
/**
 * An iCalendar feed of one teacher's classes for this week and next week.
 * Calendar apps subscribe to: <web app link>?ics=<teacher name>
 * Times use the script's time zone (Project Settings > Time zone: Europe/Madrid).
 */
function icsFeed_(teacher) {
  const snap = getSnapshot_() || refreshSnapshot();
  const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
  const utc = d => Utilities.formatDate(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'");
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const stamp = utc(new Date());
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Swift English School//Staff timetable//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + esc('Swift timetable – ' + teacher),
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
  ];
  snap.weeks.filter(w => w.found).forEach(w => {
    const monday = new Date(w.mondayIso);
    // Never add cancelled / unconfirmed blocks to a teacher's confirmed calendar.
    w.classes.filter(c => c.teacher === teacher && c.status !== 'uncertain').forEach(c => {
      const day = new Date(monday);
      day.setDate(day.getDate() + DAYS.indexOf(c.day));
      const at = t => { const [h, m] = t.split(':').map(Number);
        return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m); };
      const start = at(c.start), end = at(c.end);
      const uid = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5,
        [teacher, utc(start), c.code, c.room].join('|'))).replace(/=+$/, '');
      lines.push('BEGIN:VEVENT', 'UID:' + uid + '@swift-timetable', 'DTSTAMP:' + stamp,
        'DTSTART:' + utc(start), 'DTEND:' + utc(end), 'SUMMARY:' + esc(c.code),
        'LOCATION:' + esc(c.offsite ? 'Offsite' : c.online ? 'Online' : 'Room ' + c.room));
      if (c.notes) lines.push('DESCRIPTION:' + esc(c.notes));
      lines.push('END:VEVENT');
    });
  });
  lines.push('END:VCALENDAR');
  return ContentService.createTextOutput(lines.join('\r\n')).setMimeType(ContentService.MimeType.ICAL);
}


// ---------- Missing or unreadable timetable warning ----------
/**
 * Runs every evening around 20:00 (and can be run by hand from the editor).
 * Emails you only when something is wrong:
 *  - Friday to Sunday: next week's timetable hasn't been shared yet.
 *  - Monday to Thursday: this week's timetable isn't in the app.
 *  - A recent timetable file can't be read (no MON/TUE header or date row).
 *  - A week can be opened but no classes come out of it, or far fewer than the other week.
 */
function checkHealth() {
  const problems = [];
  const link = id => 'https://docs.google.com/spreadsheets/d/' + id;
  const now = new Date(), dow = now.getDay();          // Sun 0 .. Sat 6
  const weeks = listWeeks_();
  const thisMon = mondayOf_(now);                      // at the weekend this is the coming Monday
  const needed = [thisMon];
  if (dow === 5) { const next = new Date(thisMon); next.setDate(next.getDate() + 7); needed.push(next); }

  const counts = [];
  needed.forEach(monday => {
    const label = fmtDate_(monday);
    const week = weeks.find(w => sameDay_(w.monday, monday));
    if (!week) {
      problems.push('No timetable for the week of ' + label + ' yet. The app only finds files shared with this ' +
        'account by ' + SOURCE_OWNERS.join(' or ') + '.');
      return;
    }
    try {
      const n = parseWeek_(week.id).classes.filter(c => c.teacher).length;
      if (!n) problems.push('"' + week.title + '" (week of ' + label + ') opens, but no classes could be read from it.\n  ' + link(week.id));
      counts.push({ n: n, week: week, label: label });
    } catch (e) {
      problems.push('"' + week.title + '" (week of ' + label + ') could not be read: ' + e.message + '\n  ' + link(week.id));
    }
  });
  if (counts.length === 2) {
    const [a, b] = counts;
    const small = a.n < b.n ? a : b, big = a.n < b.n ? b : a;
    if (small.n && small.n < big.n * 0.5) {
      problems.push('"' + small.week.title + '" has ' + small.n + ' classes, against ' + big.n +
        ' in the other week. It may be incomplete or laid out differently.\n  ' + link(small.week.id));
    }
  }

  // Recent files from the timetable makers that the app couldn't place in any week.
  const known = new Set(weeks.map(w => w.id));
  const since = new Date(Date.now() - 21 * 24 * 3600 * 1000).toISOString().slice(0, 19);
  const owners = SOURCE_OWNERS.map(o => "'" + o + "' in owners").join(' or ');
  const it = DriveApp.searchFiles("mimeType = 'application/vnd.google-apps.spreadsheet' and (" + owners +
    ") and trashed = false and modifiedDate > '" + since + "'");
  while (it.hasNext()) {
    const f = it.next();
    if (known.has(f.getId())) continue;
    let monday = null;
    try { monday = mondayFromFile_(f); } catch (e) {}
    if (!monday) {
      problems.push('"' + f.getName().trim() + '" looks like a timetable but the app can\'t tell which week it is ' +
        '(it needs the MON/TUE header row with the date numbers above it).\n  ' + f.getUrl());
    }
  }

  if (!problems.length) return;
  const to = [Session.getEffectiveUser().getEmail()].concat(ALERT_ALSO).join(',');
  MailApp.sendEmail(to,
    'Timetable app: ' + problems.length + (problems.length > 1 ? ' problems' : ' problem') + ' to check',
    'The staff timetable app found ' + (problems.length > 1 ? 'these problems' : 'this problem') + ':\n\n' +
    problems.map(p => '• ' + p).join('\n\n') +
    '\n\nStaff may see "No timetable yet" or missing classes until this is fixed.');
}
