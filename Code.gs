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

// A cell starting with one of these begins a new class; anything else inside a
// coloured block (dates, "o.l.", student counts) is shown as a note.
// Add to this list if a class type ever runs together with the one before it.
const CLASS_PREFIXES = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', '121', '122', '123', '124',
  'IBC', 'DOM', 'KET', 'PET', 'FCE', 'CAE', 'CPE', 'IELTS', 'TOEFL', 'K1', 'K2', 'K3',
  'K4', 'K5', 'MOVERS', 'STARTERS', 'FLYERS'];

// ---------- Web app ----------
// Speed: a background trigger (refreshScheduled, every 10 minutes) reads this
// week's and next week's files and keeps the result ready in the cache. The page
// arrives with that data already inside it, so opening the app doesn't wait on
// Drive or the timetable sheets.
const SNAPSHOT_KEY = 'snapshot_v8';
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
    return { found: false, mondayIso: target.toISOString(), mondayLabel: fmtDate_(target), teachers: teachers };
  }
  const key = 'parse2_' + week.id + '_' + week.modified + '_' + mapKey;
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

  const colourMap = readColourMap_();
  const unknown = {};
  const classes = [];

  cols.forEach(col => {
    let cur = null;
    const close = () => {
      if (!cur) return;
      // A single unlabelled half hour is decoration, not a class: some weeks fill
      // empty cells with a striped pattern (e.g. to mark a day off).
      const keep = cur.code || cur.notes.length || cur.end - cur.start > 30;
      if (keep) {
        classes.push(cur);
        if (!cur.teacher && !unknown[cur.colour]) {
          unknown[cur.colour] = cur.day + ' ' + fmtMins_(cur.start) + ' room ' + cur.room +
            (cur.code ? ' "' + cur.code + '"' : '');
        }
      }
      cur = null;
    };
    times.forEach(t => {
      const colour = (bg[t.r][col.c] || '#ffffff').toLowerCase();
      const cell = text[t.r][col.c].replace(/\s+/g, ' ').trim();
      if (colour === '#ffffff') { close(); return; }
      // Same colour continues the class, unless the cell holds a new class code
      // (a teacher's back-to-back classes in one room share a colour).
      if (cur && cur.colour === colour && !(cell && isClassCode_(cell))) {
        cur.end = t.mins + 30;
        if (cell) cur.notes.push(cell);
        return;
      }
      close();
      const teacher = colourMap[colour];
      cur = {
        day: col.day, room: col.room, start: t.mins, end: t.mins + 30,
        code: cell, notes: [], colour: colour, teacher: teacher || null,
      };
    });
    close();
  });

  logUnknownColours_(unknown);
  // Rooms per day, for the free-room finder (not every day has every room).
  const rooms = {};
  cols.forEach(col => { if (col.room) (rooms[col.day] = rooms[col.day] || []).push(col.room); });

  return {
    // Every coloured block is returned, so free rooms can be worked out;
    // only blocks with a real teacher appear in anyone's timetable.
    classes: classes.map(k => {
      // "o.l." (or "OL", "online") anywhere in the block means an online class.
      const isOL = t => /^(o\.?\s?l\.?|online)$/i.test(t.trim());
      const online = isOL(k.code || '') || k.notes.some(isOL);
      return {
        day: k.day, room: k.room, start: fmtMins_(k.start), end: fmtMins_(k.end),
        code: isOL(k.code || '') ? 'Online class' : (k.code || '(no label)'),
        notes: k.notes.filter(n => !isOL(n)).join(' / '),
        online: online,
        colour: k.colour, teacher: k.teacher === IGNORE ? null : k.teacher,
      };
    }),
    rooms: rooms,
    slots: times.map(t => fmtMins_(t.mins)),
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
function isClassCode_(cell) {
  // Prefix followed by anything but another letter or digit: "B1 20", "C1+ 66", "DOM. 9", "K3 -28".
  const re = new RegExp('^(' + CLASS_PREFIXES.join('|') + ')(?![A-Z0-9])', 'i');
  return re.test(cell.trim());
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
    w.classes.filter(c => c.teacher === teacher).forEach(c => {
      const day = new Date(monday);
      day.setDate(day.getDate() + DAYS.indexOf(c.day));
      const at = t => { const [h, m] = t.split(':').map(Number);
        return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m); };
      const start = at(c.start), end = at(c.end);
      const uid = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5,
        [teacher, utc(start), c.code, c.room].join('|'))).replace(/=+$/, '');
      lines.push('BEGIN:VEVENT', 'UID:' + uid + '@swift-timetable', 'DTSTAMP:' + stamp,
        'DTSTART:' + utc(start), 'DTEND:' + utc(end), 'SUMMARY:' + esc(c.code),
        'LOCATION:' + esc(c.online ? 'Online' : 'Room ' + c.room));
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
