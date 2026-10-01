import { firebaseConfig } from "./config.js";
import { DEFAULT_ITEMS, DEFAULT_PERSONAL } from "./items.js";

const SDK = "https://www.gstatic.com/firebasejs/12.19.0/";

const PEOPLE = [
  { id: "stav", name: "סתיו" },
  { id: "shlomi", name: "שלומי" },
  { id: "reshef", name: "רשף" },
  { id: "sapir", name: "ספיר" }
];
const PEOPLE_IDS = PEOPLE.map((p) => p.id);
const NAME_OF = Object.fromEntries(PEOPLE.map((p) => [p.id, p.name]));
const CATS = [
  { id: "meat", name: "בשר", hint: "כמויות לערב אחד, ל-4" },
  { id: "grill", name: "מנגל ואש" },
  { id: "kitchen", name: "מטבח וקירור" },
  { id: "sides", name: "לחם, סלטים ותוספות" },
  { id: "drinks", name: "שתייה" },
  { id: "morning", name: "בוקר, קפה ונשנושים" },
  { id: "disposable", name: "חד״פ וניקיון" },
  { id: "camp", name: "מחנה" },
  { id: "power", name: "חשמל ותאורה" },
  { id: "other", name: "שונות" }
];
const CAT_POS = new Map(CATS.map((c, i) => [c.id, i]));
const FILTERS = [
  { id: "all", label: "הכול" },
  { id: "none", label: "פנויים" },
  ...PEOPLE.map((p) => ({ id: p.id, label: p.name, person: true }))
];
const FILTER_IDS = FILTERS.map((f) => f.id);

const $ = (id) => document.getElementById(id);
const app = $("app");
const catsEl = $("cats");
const chipsEl = $("chips");
const filtersEl = $("filters");
const filtersAnchor = $("filtersAnchor");
const meterEl = $("meter");
const tallyEl = $("tallyText");
const syncEl = $("sync");
const listState = $("listState");
const listStateText = $("listStateText");
const skel = $("skel");
const actionsEl = $("actions");
const copyBtn = $("copyBtn");
const waLink = $("waLink");
const waAllLink = $("waAllLink");
const selHint = $("selHint");
const editBtn = $("editBtn");
const editHint = $("editHint");
const noticeEl = $("notice");
const toastEl = $("toast");
const copyPanel = $("copyPanel");
const copyText = $("copyText");
const copyClose = $("copyClose");
const personalSec = $("personal");
const pEditBtn = $("pEditBtn");
const pStateEl = $("pState");
const plistEl = $("plist");
const paddForm = $("padd");
const paddName = $("paddName");

// Per-device conveniences only (remembered filter, personal ticks).
const local = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }
};

// Which names (and/or "פנויים") are selected. Empty means everything is shown.
const SEL_KEY = "camping.selection.v2";
function loadSelection() {
  let saved = local.get(SEL_KEY, null);
  if (!Array.isArray(saved)) {
    const old = local.get("camping.filter", "all"); // single-name filter from the previous version
    saved = old && old !== "all" ? [old] : [];
  }
  return new Set(saved.filter((id) => FILTER_IDS.includes(id) && id !== "all"));
}
const state = {
  items: [],
  loaded: false,
  live: "wait",
  editing: false,
  selected: loadSelection(),
  pending: 0,
  savedFlash: false
};
let api = null;
const sections = new Map();
const queues = new Map();
const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function normalize(id, d) {
  d = d || {};
  return {
    id,
    name: typeof d.name === "string" && d.name.trim() ? d.name : "פריט",
    note: typeof d.note === "string" ? d.note : "",
    cat: CAT_POS.has(d.cat) ? d.cat : "other",
    order: typeof d.order === "number" && isFinite(d.order) ? d.order : 9999,
    who: normalizeWho(d.who),
    done: d.done === true
  };
}

function sortItems(list) {
  return list.slice().sort((a, b) =>
    (CAT_POS.get(a.cat) - CAT_POS.get(b.cat)) || (a.order - b.order) || a.name.localeCompare(b.name, "he"));
}

// Who brings an item. Stored as null (nobody), one id (one person) or a list of ids
// (several people); "all" is the old "כל אחד" option and reads as all four.
// In the page it is always a list of ids, in PEOPLE order.
function normalizeWho(w) {
  if (w === "all") return PEOPLE_IDS.slice();
  const ids = Array.isArray(w) ? w : typeof w === "string" ? [w] : [];
  return PEOPLE_IDS.filter((id) => ids.includes(id));
}
function encodeWho(ids) {
  return ids.length === 0 ? null : ids.length === 1 ? ids[0] : ids.slice();
}
const isEveryone = (ids) => ids.length === PEOPLE_IDS.length;
// "", "שלומי", "שלומי ורשף", "כולם"
function whoText(ids) {
  if (!ids.length) return "";
  if (isEveryone(ids)) return "כולם";
  return joinNames(ids.map((id) => NAME_OF[id]));
}

const NO_SELECTION = new Set();
function effectiveSelection() { return state.editing ? NO_SELECTION : state.selected; }
function selectedPeople(sel) { return PEOPLE.filter((p) => sel.has(p.id)); }

// An item shows when nothing is selected, when any of its people is selected,
// or when it is unassigned and "פנויים" is selected.
function passes(it, sel) {
  if (!sel.size) return true;
  if (!it.who.length) return sel.has("none");
  return it.who.some((id) => sel.has(id));
}

// "סתיו", "סתיו ושלומי", "סתיו, שלומי ורשף"
function joinNames(names) {
  if (names.length <= 1) return names.join("");
  return names.slice(0, -1).join(", ") + " ו" + names[names.length - 1];
}

// single: items one person brings alone; per: every item a person is on; multi: items shared by several.
function tally() {
  const c = { total: 0, none: 0, multi: 0, done: 0, assigned: 0, single: {}, per: {} };
  for (const id of PEOPLE_IDS) { c.single[id] = 0; c.per[id] = 0; }
  for (const it of state.items) {
    c.total++;
    if (it.done) c.done++;
    if (!it.who.length) { c.none++; continue; }
    c.assigned++;
    if (it.who.length === 1) c.single[it.who[0]]++;
    else c.multi++;
    for (const id of it.who) c.per[id]++;
  }
  return c;
}

/* ---------- building ---------- */

function buildChips() {
  for (const f of FILTERS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (f.person ? " person" : "");
    b.dataset.f = f.id;
    b.setAttribute("aria-pressed", "false");
    if (f.person) {
      const dot = document.createElement("span");
      dot.className = "dot";
      b.append(dot);
    }
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = f.label;
    const n = document.createElement("span");
    n.className = "n";
    b.append(lbl, n);
    chipsEl.append(b);
  }
}

function buildSections() {
  for (const cat of CATS) {
    const sec = document.createElement("section");
    sec.className = "cat";
    sec.dataset.cat = cat.id;
    sec.hidden = true;
    sec.setAttribute("aria-labelledby", "h-" + cat.id);

    const head = document.createElement("div");
    head.className = "cat-h";
    const h2 = document.createElement("h2");
    h2.id = "h-" + cat.id;
    h2.textContent = cat.name;
    const cnt = document.createElement("span");
    cnt.className = "cnt";
    head.append(h2, cnt);
    sec.append(head);

    if (cat.hint) {
      const hint = document.createElement("p");
      hint.className = "cat-hint";
      hint.textContent = cat.hint;
      sec.append(hint);
    }

    const ul = document.createElement("ul");
    ul.className = "rows";
    sec.append(ul);

    const form = document.createElement("form");
    form.className = "add";
    form.dataset.cat = cat.id;
    form.noValidate = true;
    const nm = document.createElement("input");
    nm.className = "field add-nm";
    nm.type = "text";
    nm.maxLength = 60;
    nm.autocomplete = "off";
    nm.id = "add-nm-" + cat.id;
    nm.placeholder = "פריט חדש";
    nm.setAttribute("aria-label", "פריט חדש ב" + cat.name);
    const nt = document.createElement("input");
    nt.className = "field add-nt";
    nt.type = "text";
    nt.maxLength = 80;
    nt.autocomplete = "off";
    nt.id = "add-nt-" + cat.id;
    nt.placeholder = "כמות או הערה";
    nt.setAttribute("aria-label", "כמות או הערה");
    const go = document.createElement("button");
    go.type = "submit";
    go.className = "btn small";
    go.textContent = "הוספה";
    form.append(nm, nt, go);
    sec.append(form);

    catsEl.append(sec);
    sections.set(cat.id, sec);
  }
}

function createRow(it) {
  const li = document.createElement("li");
  li.className = "row";
  li.dataset.key = it.id;

  const tick = document.createElement("button");
  tick.type = "button";
  tick.className = "tick";

  const txt = document.createElement("div");
  txt.className = "txt";
  const nm = document.createElement("span");
  nm.className = "nm";
  const nt = document.createElement("span");
  nt.className = "nt";
  const nmIn = document.createElement("input");
  nmIn.className = "field nm-in";
  nmIn.type = "text";
  nmIn.maxLength = 60;
  nmIn.autocomplete = "off";
  nmIn.id = "nm-" + it.id;
  nmIn.setAttribute("aria-label", "שם הפריט");
  const ntIn = document.createElement("input");
  ntIn.className = "field nt-in";
  ntIn.type = "text";
  ntIn.maxLength = 80;
  ntIn.autocomplete = "off";
  ntIn.id = "nt-" + it.id;
  ntIn.placeholder = "כמות או הערה";
  ntIn.setAttribute("aria-label", "כמות או הערה");
  txt.append(nm, nt, nmIn, ntIn);

  const wrap = document.createElement("span");
  wrap.className = "who-wrap";
  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "who";
  pick.id = "who-" + it.id;
  pick.setAttribute("aria-haspopup", "dialog");
  const dots = document.createElement("span");
  dots.className = "dots";
  dots.setAttribute("aria-hidden", "true");
  const lbl = document.createElement("span");
  lbl.className = "who-lbl";
  pick.append(dots, lbl);
  wrap.append(pick);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "del";
  del.textContent = "מחיקה";

  li.append(tick, txt, wrap, del);
  return li;
}

function updateRow(li, it) {
  li.dataset.who = !it.who.length ? "" : it.who.length === 1 ? it.who[0] : "multi";
  li.dataset.done = it.done ? "1" : "0";

  const nm = li.querySelector(".nm");
  const nt = li.querySelector(".nt");
  if (nm.textContent !== it.name) nm.textContent = it.name;
  if (nt.textContent !== it.note) nt.textContent = it.note;
  nt.hidden = !it.note;

  const nmIn = li.querySelector(".nm-in");
  const ntIn = li.querySelector(".nt-in");
  if (document.activeElement !== nmIn && nmIn.value !== it.name) nmIn.value = it.name;
  if (document.activeElement !== ntIn && ntIn.value !== it.note) ntIn.value = it.note;

  const pick = li.querySelector(".who");
  const label = whoText(it.who) || "מי מביא?";
  const lbl = pick.querySelector(".who-lbl");
  if (lbl.textContent !== label) lbl.textContent = label;
  const dots = pick.querySelector(".dots");
  const dotsKey = it.who.length > 1 ? it.who.join(",") : "";
  if (dots.dataset.k !== dotsKey) {
    dots.dataset.k = dotsKey;
    dots.textContent = "";
    if (it.who.length > 1) for (const id of it.who) { const d = document.createElement("i"); d.dataset.p = id; dots.append(d); }
  }
  pick.setAttribute("aria-label", `מי מביא: ${it.name}. ${it.who.length ? "עכשיו: " + whoText(it.who) : "עוד אף אחד"}`);

  const tick = li.querySelector(".tick");
  tick.setAttribute("aria-pressed", it.done ? "true" : "false");
  tick.setAttribute("aria-label", "ארוז: " + it.name);

  li.querySelector(".del").setAttribute("aria-label", "מחיקה: " + it.name);
}

function reconcile(ul, list) {
  const existing = new Map();
  for (const el of ul.children) existing.set(el.dataset.key, el);
  let cursor = ul.firstElementChild;
  for (const it of list) {
    let el = existing.get(it.id);
    if (el) existing.delete(it.id);
    else el = createRow(it);
    updateRow(el, it);
    if (el === cursor) cursor = cursor.nextElementSibling;
    else ul.insertBefore(el, cursor);
  }
  for (const el of existing.values()) el.remove();
}

/* ---------- rendering ---------- */

function render() {
  const c = tally();
  renderTally(c);
  renderChips(c);
  renderSections();
  renderChrome();
  renderSync();
  renderWhoSheet();
}

function renderTally(c) {
  if (!state.loaded) return;
  tallyEl.textContent = c.total === 0
    ? "אין עדיין פריטים ברשימה"
    : `שובצו ${c.assigned} מתוך ${c.total}` + (c.done ? ` · ${c.done} ארוזים` : "");
  meterEl.textContent = "";
  const segs = [...PEOPLE_IDS.map((id) => [id, c.single[id]]), ["multi", c.multi], ["none", c.none]];
  for (const [id, n] of segs) {
    if (!n) continue;
    const s = document.createElement("span");
    s.className = "seg seg-" + id;
    s.style.flexGrow = String(n);
    meterEl.append(s);
  }
}

function renderChips(c) {
  const sel = effectiveSelection();
  for (const b of chipsEl.children) {
    const id = b.dataset.f;
    const n = id === "all" ? c.total : id === "none" ? c.none : c.per[id];
    b.querySelector(".n").textContent = state.loaded ? String(n) : "";
    b.setAttribute("aria-pressed", String(id === "all" ? sel.size === 0 : sel.has(id)));
    b.disabled = state.editing;
  }
}

function renderSections() {
  if (!state.loaded) return;
  const sel = effectiveSelection();
  const byCat = new Map(CATS.map((cat) => [cat.id, []]));
  for (const it of sortItems(state.items)) byCat.get(it.cat).push(it);

  let shown = 0;
  for (const cat of CATS) {
    const sec = sections.get(cat.id);
    const all = byCat.get(cat.id);
    const rows = all.filter((it) => passes(it, sel));
    const visible = rows.length > 0 || state.editing;
    sec.hidden = !visible;
    if (!visible) continue;
    shown++;
    const assigned = all.filter((it) => it.who.length).length;
    sec.querySelector(".cnt").textContent = all.length ? `${assigned}/${all.length} שובצו` : "";
    reconcile(sec.querySelector(".rows"), rows);
  }

  skel.hidden = true;
  if (shown > 0) {
    listState.hidden = true;
    return;
  }
  listState.hidden = false;
  if (state.items.length === 0) {
    listStateText.textContent = "הרשימה עדיין ריקה. לחצו על ״עריכת הרשימה״ כדי להוסיף פריט ראשון.";
  } else {
    const people = selectedPeople(sel);
    if (!people.length) listStateText.textContent = "כל הפריטים כבר שובצו.";
    else if (sel.has("none")) listStateText.textContent = "אין פריטים בבחירה הזו.";
    else listStateText.textContent = `${joinNames(people.map((p) => p.name))} עוד לא ${people.length > 1 ? "לקחו" : "לקח"} כלום.`;
  }
}

function renderChrome() {
  filtersEl.hidden = !state.loaded || state.items.length === 0;
  actionsEl.hidden = !state.loaded;
  const hasItems = state.items.length > 0;
  copyBtn.hidden = !hasItems;
  waLink.hidden = !hasItems;
  waAllLink.hidden = !hasItems;
  const sel = effectiveSelection();
  selHint.hidden = !hasItems || !sel.size;
  if (sel.size) selHint.textContent = `העתקה ושליחה בוואטסאפ יכללו רק את ${selectionPhrase(sel)}. ״כל הרשימה לוואטסאפ״ שולח תמיד את הכול.`;
  editBtn.setAttribute("aria-pressed", String(state.editing));
  editBtn.textContent = state.editing ? "סיום עריכה" : "עריכת הרשימה";
  editHint.hidden = !state.editing;
  app.classList.toggle("editing", state.editing);
}

let flashTimer = 0;
function renderSync() {
  let s = "wait";
  let t = "מתחבר…";
  if (state.live === "none") { s = "off"; t = "לא מחובר"; }
  else if (!navigator.onLine) { s = "off"; t = state.pending > 0 ? "אין קליטה. השינויים יישלחו כשתחזור" : "אין קליטה"; }
  else if (state.pending > 0) { s = "saving"; t = "שומר…"; }
  else if (state.savedFlash) { s = "live"; t = "נשמר"; }
  else if (state.live === "live") { s = "live"; t = "מעודכן אצל כולם"; }
  else if (state.live === "off") { s = "off"; t = "לא מחובר"; }
  syncEl.dataset.state = s;
  if (syncEl.textContent !== t) syncEl.textContent = t;
}

function pageUrl() {
  return location.protocol.startsWith("http") ? location.href.split("#")[0] : "";
}

// "הפריטים של סתיו ושלומי", "הפריטים הפנויים", or both.
function selectionPhrase(sel) {
  const people = selectedPeople(sel);
  const parts = [];
  if (people.length) parts.push(`הפריטים של ${joinNames(people.map((p) => p.name))}`);
  if (sel.has("none")) parts.push("הפריטים הפנויים");
  return parts.join(" ו");
}

const itemLine = (it) => `${it.done ? "✓" : "•"} ${it.name}${it.note ? ` (${it.note})` : ""}`;

function withLink(out) {
  const url = pageUrl();
  if (url) out.push("", "לבחירה ולעדכון: " + url);
  return out.join("\n");
}

// "Who brings what", grouped by the exact set of people on each item: "סתיו", then shared
// groups such as "שלומי ורשף", then "כולם", then what is still free. With names selected, only
// the groups that include one of them; with "פנויים" selected, the unassigned items.
// Returns null when there is nothing to send.
function summaryByPerson() {
  const items = sortItems(state.items);
  const sel = effectiveSelection();
  const groups = new Map();
  for (const it of items) {
    if (!it.who.length) continue;
    if (sel.size && !it.who.some((id) => sel.has(id))) continue;
    const key = it.who.join(",");
    if (!groups.has(key)) groups.set(key, { ids: it.who, items: [] });
    groups.get(key).items.push(it);
  }
  const byPeople = (a, b) => {
    if (a.ids.length !== b.ids.length) return a.ids.length - b.ids.length;
    for (let i = 0; i < a.ids.length; i++) {
      const d = PEOPLE_IDS.indexOf(a.ids[i]) - PEOPLE_IDS.indexOf(b.ids[i]);
      if (d) return d;
    }
    return 0;
  };
  const out = [];
  for (const g of [...groups.values()].sort(byPeople)) {
    out.push("", `*${whoText(g.ids)}* (${g.items.length})`, ...g.items.map(itemLine));
  }
  if (!sel.size || sel.has("none")) {
    const free = items.filter((it) => !it.who.length);
    if (free.length) out.push("", `*עוד פנויים* (${free.length})`, ...free.map(itemLine));
  }
  if (!out.length) return null;
  return withLink(["*קמפינג: מי מביא מה*", ...out]);
}

// The whole list by topic, who brings each item, and the "כל אחד לעצמו" list.
function summaryByTopic() {
  const items = sortItems(state.items);
  const out = ["*קמפינג: כל הרשימה*"];
  for (const cat of CATS) {
    const list = items.filter((it) => it.cat === cat.id);
    if (!list.length) continue;
    out.push("", `*${cat.name}*`, ...list.map((it) => `${itemLine(it)} – ${it.who.length ? whoText(it.who) : "פנוי"}`));
  }
  const own = (personal.loaded ? personal.items : DEFAULT_PERSONAL.map((p) => normPersonal(p.id, p)))
    .slice().sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, "he"));
  if (own.length) out.push("", "*כל אחד לעצמו*", ...own.map((p) => `• ${p.name}`));
  return withLink(out);
}

let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3600);
}

function showProblem(msg) {
  noticeEl.textContent = msg;
  noticeEl.hidden = false;
}

/* ---------- writing ---------- */

function enqueue(key, job, onError = onWriteError) {
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(job);
  queues.set(key, run);
  state.pending++;
  renderSync();
  run.then(() => {
    state.savedFlash = true;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { state.savedFlash = false; renderSync(); }, 1600);
  }, (err) => {
    onError(err, key);
  }).then(() => {
    state.pending--;
    if (queues.get(key) === run) queues.delete(key);
    renderSync();
  });
}

function onWriteError(err, key) {
  const code = err && err.code;
  if (code === "not-found") { resync(key); return; } // someone deleted the item meanwhile
  if (code === "permission-denied") toast("השינוי נחסם ולא נשמר. ספרו לסתיו.");
  else if (code === "resource-exhausted") toast("נגמרה המכסה היומית של מסד הנתונים. נסו שוב מחר.");
  else toast("השינוי לא נשמר. נסו שוב.");
  resync(key);
}

function resync(key) {
  if (!api) return;
  api.get(key).then((fresh) => {
    const i = state.items.findIndex((it) => it.id === key);
    if (!fresh) { if (i >= 0) state.items.splice(i, 1); }
    else if (i >= 0) state.items[i] = fresh;
    else state.items.push(fresh);
    render();
  }, () => {});
}

function patchLocal(id, patch) {
  const it = state.items.find((x) => x.id === id);
  if (it) Object.assign(it, patch);
}

function findItem(li) {
  if (!li) return null;
  return state.items.find((x) => x.id === li.dataset.key) || null;
}

catsEl.addEventListener("change", (e) => {
  const t = e.target;
  if (!api) return;
  const it = findItem(t.closest(".row"));
  if (!it) return;
  const id = it.id;
  let patch = null;
  if (t.classList.contains("nm-in")) {
    const name = t.value.trim().slice(0, 60);
    if (!name) { t.value = it.name; return; }
    if (name !== it.name) patch = { name };
  } else if (t.classList.contains("nt-in")) {
    const note = t.value.trim().slice(0, 80);
    if (note !== it.note) patch = { note };
  }
  if (!patch) return;
  patchLocal(id, patch);
  render();
  enqueue(id, () => api.update(id, patch));
});

catsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || !api) return;
  const it = findItem(btn.closest(".row"));
  if (!it) return;
  const id = it.id;
  if (btn.classList.contains("who")) {
    openWhoSheet(id, btn);
  } else if (btn.classList.contains("tick")) {
    const patch = { done: !it.done };
    patchLocal(id, patch);
    render();
    enqueue(id, () => api.update(id, patch));
  } else if (btn.classList.contains("del")) {
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = "למחוק?";
      clearTimeout(btn._disarm);
      btn._disarm = setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "מחיקה"; }, 3000);
      return;
    }
    clearTimeout(btn._disarm);
    state.items = state.items.filter((x) => x.id !== id);
    render();
    enqueue(id, () => api.remove(id));
  }
});

catsEl.addEventListener("submit", (e) => {
  const form = e.target.closest("form.add");
  if (!form) return;
  e.preventDefault();
  if (!api) return;
  const cat = CAT_POS.has(form.dataset.cat) ? form.dataset.cat : "other";
  const nmIn = form.querySelector(".add-nm");
  const ntIn = form.querySelector(".add-nt");
  const name = nmIn.value.trim().slice(0, 60);
  if (!name) { nmIn.focus(); return; }
  const note = ntIn.value.trim().slice(0, 80);
  const order = state.items.filter((x) => x.cat === cat).reduce((m, x) => Math.max(m, x.order), 0) + 1;
  const id = api.newId();
  const data = { name, note, cat, order, who: null, done: false };
  state.items.push(normalize(id, data));
  render();
  nmIn.value = "";
  ntIn.value = "";
  nmIn.focus();
  enqueue(id, () => api.create(id, data));
});

chipsEl.addEventListener("click", (e) => {
  const b = e.target.closest(".chip");
  if (!b || state.editing) return;
  const f = b.dataset.f;
  if (f === "all") state.selected.clear();
  else if (state.selected.has(f)) state.selected.delete(f);
  else state.selected.add(f);
  local.set(SEL_KEY, Array.from(state.selected));
  render();
  const anchorTop = filtersAnchor.getBoundingClientRect().top + window.scrollY;
  if (window.scrollY > anchorTop) window.scrollTo({ top: anchorTop, behavior: reduceMotion ? "auto" : "smooth" });
});

editBtn.addEventListener("click", () => {
  if (!api) return;
  closeWhoSheet();
  state.editing = !state.editing;
  render();
});

function copyToClipboard(text, okMessage) {
  const fallback = () => {
    copyText.value = text;
    copyPanel.hidden = false;
    copyText.focus();
    copyText.select();
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(okMessage), fallback);
    else fallback();
  } catch (err) {
    fallback();
  }
}

const EMPTY_SELECTION_MSG = "אין מה לשלוח: אין פריטים בבחירה הזו.";

copyBtn.addEventListener("click", () => {
  const text = summaryByPerson();
  if (!text) { toast(EMPTY_SELECTION_MSG); return; }
  const sel = effectiveSelection();
  copyToClipboard(text, sel.size
    ? `הועתקו רק ${selectionPhrase(sel)}. אפשר להדביק בוואטסאפ.`
    : "הסיכום הועתק. אפשר להדביק בקבוצה.");
});

// WhatsApp links are real links (so a tap opens the app directly); the text is filled in on tap.
// Very long texts can fail as a link, so they go through the phone's share menu, or get copied on a computer.
const WA_MAX_URL = 6000;
const isTouch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
function wireWhatsAppLink(link, build) {
  link.addEventListener("click", (e) => {
    const text = build();
    if (!text) { e.preventDefault(); toast(EMPTY_SELECTION_MSG); return; }
    const url = "https://wa.me/?text=" + encodeURIComponent(text);
    if (url.length <= WA_MAX_URL) { link.href = url; return; }
    e.preventDefault();
    if (isTouch && navigator.share) navigator.share({ text }).catch(() => {});
    else copyToClipboard(text, "הרשימה ארוכה מדי לשליחה ישירה, אז העתקתי אותה. הדביקו בוואטסאפ.");
  });
}
wireWhatsAppLink(waLink, summaryByPerson);
wireWhatsAppLink(waAllLink, summaryByTopic);

copyClose.addEventListener("click", () => {
  copyPanel.hidden = true;
  copyBtn.focus();
});

/* ---------- "who brings it" picker: several names per item ---------- */

const whoSheet = $("whoSheet");
const whoBackdrop = $("whoBackdrop");
const whoSheetItem = $("whoSheetItem");
const whoOptions = $("whoOptions");
const whoAllBtn = $("whoAll");
const whoNoneBtn = $("whoNone");
const whoDoneBtn = $("whoDone");
let sheetItemId = null;
let sheetReturnFocus = null;

function buildWhoOptions() {
  for (const p of PEOPLE) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "who-opt";
    b.dataset.p = p.id;
    b.setAttribute("aria-pressed", "false");
    const dot = document.createElement("span");
    dot.className = "dot";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = p.name;
    const chk = document.createElement("span");
    chk.className = "chk";
    chk.setAttribute("aria-hidden", "true");
    b.append(dot, lbl, chk);
    whoOptions.append(b);
  }
}

function openWhoSheet(id, trigger) {
  sheetItemId = id;
  sheetReturnFocus = trigger;
  whoBackdrop.hidden = false;
  whoSheet.hidden = false;
  renderWhoSheet();
  whoOptions.querySelector(".who-opt").focus();
}

function closeWhoSheet() {
  if (sheetItemId === null) return;
  sheetItemId = null;
  whoBackdrop.hidden = true;
  whoSheet.hidden = true;
  if (sheetReturnFocus && document.contains(sheetReturnFocus)) sheetReturnFocus.focus();
  sheetReturnFocus = null;
}

function renderWhoSheet() {
  if (sheetItemId === null) return;
  const it = state.items.find((x) => x.id === sheetItemId);
  if (!it) { closeWhoSheet(); return; } // deleted by someone meanwhile
  if (whoSheetItem.textContent !== it.name) whoSheetItem.textContent = it.name;
  for (const b of whoOptions.children) b.setAttribute("aria-pressed", String(it.who.includes(b.dataset.p)));
  whoAllBtn.disabled = isEveryone(it.who);
  whoNoneBtn.disabled = !it.who.length;
}

// Every tap saves right away, like the rest of the page.
function setWho(ids) {
  const it = state.items.find((x) => x.id === sheetItemId);
  if (!it || !api) return;
  const next = PEOPLE_IDS.filter((id) => ids.includes(id));
  if (next.join() === it.who.join()) return;
  const id = it.id;
  patchLocal(id, { who: next });
  render();
  const stored = encodeWho(next);
  enqueue(id, () => api.update(id, { who: stored }));
}

whoOptions.addEventListener("click", (e) => {
  const b = e.target.closest(".who-opt");
  const it = b && state.items.find((x) => x.id === sheetItemId);
  if (!it) return;
  const p = b.dataset.p;
  setWho(it.who.includes(p) ? it.who.filter((x) => x !== p) : [...it.who, p]);
});
whoAllBtn.addEventListener("click", () => setWho(PEOPLE_IDS.slice()));
whoNoneBtn.addEventListener("click", () => setWho([]));
whoDoneBtn.addEventListener("click", closeWhoSheet);
whoBackdrop.addEventListener("click", closeWhoSheet);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sheetItemId !== null) closeWhoSheet(); });

window.addEventListener("online", renderSync);
window.addEventListener("offline", renderSync);

/* ---------- personal list: shared names, ticks on this device only ---------- */

const TICKS_KEY = "camping.personal.v1";
const savedTicks = local.get(TICKS_KEY, []);
const ticks = new Set(Array.isArray(savedTicks) ? savedTicks : []);
const personal = { items: [], loaded: false, editing: false, editable: false };

function normPersonal(id, d) {
  d = d || {};
  return {
    id,
    name: typeof d.name === "string" && d.name.trim() ? d.name : "פריט",
    order: typeof d.order === "number" && isFinite(d.order) ? d.order : 9999
  };
}

function createPersonalRow(it) {
  const li = document.createElement("li");
  li.dataset.key = it.id;
  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.id = "pc-" + it.id;
  const span = document.createElement("span");
  label.append(cb, span);
  const nameIn = document.createElement("input");
  nameIn.className = "field pname-in";
  nameIn.type = "text";
  nameIn.maxLength = 60;
  nameIn.autocomplete = "off";
  nameIn.id = "pn-" + it.id;
  nameIn.setAttribute("aria-label", "שם הפריט");
  const del = document.createElement("button");
  del.type = "button";
  del.className = "pdel";
  del.textContent = "מחיקה";
  li.append(label, nameIn, del);
  return li;
}

function updatePersonalRow(li, it) {
  const span = li.querySelector("label span");
  if (span.textContent !== it.name) span.textContent = it.name;
  li.querySelector("input[type=checkbox]").checked = ticks.has(it.id);
  const nameIn = li.querySelector(".pname-in");
  if (document.activeElement !== nameIn && nameIn.value !== it.name) nameIn.value = it.name;
  li.querySelector(".pdel").setAttribute("aria-label", "מחיקה: " + it.name);
}

function renderPersonal() {
  const editing = personal.editing && personal.editable;
  pEditBtn.hidden = !personal.editable;
  pEditBtn.textContent = editing ? "סיום עריכה" : "עריכה";
  pEditBtn.setAttribute("aria-pressed", String(editing));
  personalSec.classList.toggle("p-editing", editing);

  const list = personal.items.slice().sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, "he"));
  if (!personal.loaded) {
    pStateEl.hidden = false;
    pStateEl.textContent = "טוען…";
  } else if (!list.length && !editing) {
    pStateEl.hidden = false;
    pStateEl.textContent = personal.editable ? "הרשימה ריקה. לחצו על ״עריכה״ כדי להוסיף פריט." : "הרשימה ריקה.";
  } else {
    pStateEl.hidden = true;
  }

  const existing = new Map();
  for (const el of plistEl.children) existing.set(el.dataset.key, el);
  let cursor = plistEl.firstElementChild;
  for (const it of list) {
    let el = existing.get(it.id);
    if (el) existing.delete(it.id);
    else el = createPersonalRow(it);
    updatePersonalRow(el, it);
    if (el === cursor) cursor = cursor.nextElementSibling;
    else plistEl.insertBefore(el, cursor);
  }
  for (const el of existing.values()) el.remove();
}

// Without the database (no rules yet, no connection) the starting list still shows, just not editable.
function personalFallback() {
  if (personal.loaded) return;
  personal.items = DEFAULT_PERSONAL.map((p) => normPersonal(p.id, p));
  personal.loaded = true;
  personal.editable = false;
  personal.editing = false;
  renderPersonal();
}

function onPersonalWriteError(err) {
  const code = err && err.code;
  if (code === "permission-denied") toast("השינוי ברשימה האישית נחסם ולא נשמר. ספרו לסתיו.");
  else if (code === "resource-exhausted") toast("נגמרה המכסה היומית של מסד הנתונים. נסו שוב מחר.");
  else if (code !== "not-found") toast("השינוי לא נשמר. נסו שוב.");
}

pEditBtn.addEventListener("click", () => {
  if (!personal.editable) return;
  personal.editing = !personal.editing;
  renderPersonal();
});

plistEl.addEventListener("change", (e) => {
  const t = e.target;
  const li = t.closest("li");
  if (!li) return;
  const id = li.dataset.key;
  if (t.type === "checkbox") {
    if (t.checked) ticks.add(id); else ticks.delete(id);
    local.set(TICKS_KEY, Array.from(ticks));
    return;
  }
  if (!t.classList.contains("pname-in") || !api || !personal.editable) return;
  const it = personal.items.find((x) => x.id === id);
  if (!it) return;
  const name = t.value.trim().slice(0, 60);
  if (!name) { t.value = it.name; return; }
  if (name === it.name) return;
  it.name = name;
  renderPersonal();
  enqueue("p:" + id, () => api.updatePersonal(id, { name }), onPersonalWriteError);
});

plistEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".pdel");
  if (!btn || !api || !personal.editable) return;
  const id = btn.closest("li").dataset.key;
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "למחוק?";
    clearTimeout(btn._disarm);
    btn._disarm = setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "מחיקה"; }, 3000);
    return;
  }
  clearTimeout(btn._disarm);
  personal.items = personal.items.filter((x) => x.id !== id);
  if (ticks.delete(id)) local.set(TICKS_KEY, Array.from(ticks));
  renderPersonal();
  enqueue("p:" + id, () => api.removePersonal(id), onPersonalWriteError);
});

paddForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!api || !personal.editable) return;
  const name = paddName.value.trim().slice(0, 60);
  if (!name) { paddName.focus(); return; }
  const order = personal.items.reduce((m, x) => Math.max(m, x.order), 0) + 1;
  const id = api.newPersonalId();
  personal.items.push(normPersonal(id, { name, order }));
  renderPersonal();
  paddName.value = "";
  paddName.focus();
  enqueue("p:" + id, () => api.createPersonal(id, { name, order }), onPersonalWriteError);
});

function startPersonal() {
  let seedTried = false;
  api.watchPersonal((snap) => {
    // An empty answer from the phone's cache says nothing yet; wait for the server.
    if (snap.empty && snap.fromCache && !personal.loaded) return;
    personal.items = snap.items;
    personal.loaded = true;
    personal.editable = true;
    renderPersonal();
    if (snap.empty && !snap.fromCache && !seedTried) {
      seedTried = true;
      api.seedPersonal(DEFAULT_PERSONAL).catch(() => {});
    }
  }, () => {
    // Keep whatever already loaded; only fall back to the starting list if nothing did.
    personal.editable = false;
    personal.editing = false;
    if (personal.loaded) renderPersonal();
    else personalFallback();
  });
  setTimeout(() => { if (!personal.loaded) personalFallback(); }, 10000);
}

/* ---------- Firebase ---------- */

function makeApi(F, db) {
  const itemsCol = F.collection(db, "items");
  const itemRef = (id) => F.doc(db, "items", id);
  const personalCol = F.collection(db, "personal");
  const personalRef = (id) => F.doc(db, "personal", id);
  return {
    watch(next, fail) {
      return F.onSnapshot(itemsCol, { includeMetadataChanges: true }, (qs) => next({
        items: qs.docs.map((d) => normalize(d.id, d.data())),
        fromCache: qs.metadata.fromCache,
        empty: qs.empty
      }), fail);
    },
    update: (id, patch) => F.updateDoc(itemRef(id), patch),
    remove: (id) => F.deleteDoc(itemRef(id)),
    create: (id, data) => F.setDoc(itemRef(id), data),
    newId: () => F.doc(itemsCol).id,
    async get(id) {
      const snap = await F.getDoc(itemRef(id));
      return snap.exists() ? normalize(id, snap.data()) : null;
    },
    watchPersonal(next, fail) {
      return F.onSnapshot(personalCol, { includeMetadataChanges: true }, (qs) => next({
        items: qs.docs.map((d) => normPersonal(d.id, d.data())),
        fromCache: qs.metadata.fromCache,
        empty: qs.empty
      }), fail);
    },
    updatePersonal: (id, patch) => F.updateDoc(personalRef(id), patch),
    removePersonal: (id) => F.deleteDoc(personalRef(id)),
    createPersonal: (id, data) => F.setDoc(personalRef(id), data),
    newPersonalId: () => F.doc(personalCol).id,
    seedPersonal(items) {
      const metaRef = F.doc(db, "meta", "seedPersonal");
      return F.runTransaction(db, async (tx) => {
        const meta = await tx.get(metaRef);
        if (meta.exists()) return false;
        for (const it of items) tx.set(personalRef(it.id), { name: it.name, order: it.order });
        tx.set(metaRef, { seededAt: F.serverTimestamp(), count: items.length });
        return true;
      });
    },
    // Loads the starting list exactly once, even if several people open the page at the same moment.
    seed(items) {
      const metaRef = F.doc(db, "meta", "seed");
      return F.runTransaction(db, async (tx) => {
        const meta = await tx.get(metaRef);
        if (meta.exists()) return false;
        for (const it of items) {
          tx.set(itemRef(it.id), { name: it.name, note: it.note, cat: it.cat, order: it.order, who: null, done: false });
        }
        tx.set(metaRef, { seededAt: F.serverTimestamp(), count: items.length });
        return true;
      });
    }
  };
}

function connectionProblem(err) {
  state.live = "none";
  skel.hidden = true;
  listState.hidden = !state.loaded ? false : listState.hidden;
  if (err && err.code === "permission-denied") {
    showProblem("אין גישה למסד הנתונים. צריך לפרסם ב-Firebase את החוקים מהקובץ firestore.rules.");
    if (!state.loaded) listStateText.textContent = "הרשימה לא נטענה.";
  } else {
    showProblem("החיבור לרשימה נותק. רעננו את הדף.");
  }
  renderSync();
}

async function connect() {
  if (!firebaseConfig || !firebaseConfig.projectId || String(firebaseConfig.projectId).includes("REPLACE")) {
    state.live = "none";
    skel.hidden = true;
    listStateText.textContent = "הרשימה לא נטענה.";
    tallyEl.textContent = "חסרות הגדרות";
    showProblem("צריך להדביק את firebaseConfig בקובץ config.js.");
    renderSync();
    personalFallback();
    return;
  }

  let appMod, fsMod;
  try {
    [appMod, fsMod] = await Promise.all([import(SDK + "firebase-app.js"), import(SDK + "firebase-firestore.js")]);
  } catch (e) {
    state.live = "none";
    skel.hidden = true;
    listStateText.textContent = "לא הצלחתי לטעון את הרשימה. בדקו את החיבור ורעננו את הדף.";
    renderSync();
    personalFallback();
    return;
  }

  const fbApp = appMod.initializeApp(firebaseConfig);
  let db;
  try {
    // Keeps a copy on the phone, so the list opens and ticks work even with weak reception at the campsite.
    db = fsMod.initializeFirestore(fbApp, {
      localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() })
    });
  } catch (e) {
    db = fsMod.getFirestore(fbApp);
  }
  api = makeApi(fsMod, db);
  startPersonal();

  let seedTried = false;
  setTimeout(() => {
    if (!state.loaded) listStateText.textContent = "הרשימה עדיין לא נטענה. אם אין קליטה, היא תיטען כשהחיבור יחזור.";
  }, 10000);
  api.watch((snap) => {
    // An empty answer from the phone's cache says nothing yet; wait for the server.
    if (snap.empty && snap.fromCache && !state.loaded) return;
    state.items = snap.items;
    state.loaded = true;
    state.live = snap.fromCache ? "wait" : "live";
    noticeEl.hidden = true;
    render();
    if (snap.empty && !snap.fromCache && !seedTried) {
      seedTried = true;
      api.seed(DEFAULT_ITEMS).catch((err) => {
        if (err && err.code === "permission-denied") showProblem("אין הרשאה לכתוב למסד הנתונים. צריך לפרסם ב-Firebase את החוקים מהקובץ firestore.rules.");
      });
    }
  }, connectionProblem);
}

buildChips();
buildSections();
buildWhoOptions();
renderPersonal();
renderSync();
connect();
