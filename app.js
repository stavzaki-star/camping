import { firebaseConfig } from "./config.js";
import { DEFAULT_ITEMS } from "./items.js";

const SDK = "https://www.gstatic.com/firebasejs/12.19.0/";

const PEOPLE = [
  { id: "stav", name: "סתיו" },
  { id: "shlomi", name: "שלומי" },
  { id: "reshef", name: "רשף" },
  { id: "sapir", name: "ספיר" }
];
const WHO_LABEL = { stav: "סתיו", shlomi: "שלומי", reshef: "רשף", sapir: "ספיר", all: "כל אחד" };
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
const editBtn = $("editBtn");
const editHint = $("editHint");
const noticeEl = $("notice");
const toastEl = $("toast");
const copyPanel = $("copyPanel");
const copyText = $("copyText");
const copyClose = $("copyClose");

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

const savedFilter = local.get("camping.filter", "all");
const state = {
  items: [],
  loaded: false,
  live: "wait",
  editing: false,
  filter: FILTER_IDS.includes(savedFilter) ? savedFilter : "all",
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
    who: Object.prototype.hasOwnProperty.call(WHO_LABEL, d.who) ? d.who : null,
    done: d.done === true
  };
}

function sortItems(list) {
  return list.slice().sort((a, b) =>
    (CAT_POS.get(a.cat) - CAT_POS.get(b.cat)) || (a.order - b.order) || a.name.localeCompare(b.name, "he"));
}

function effectiveFilter() { return state.editing ? "all" : state.filter; }

function passes(it, f) {
  if (f === "all") return true;
  if (f === "none") return !it.who;
  return it.who === f || it.who === "all";
}

function tally() {
  const c = { total: 0, none: 0, all: 0, done: 0, assigned: 0 };
  for (const p of PEOPLE) c[p.id] = 0;
  for (const it of state.items) {
    c.total++;
    if (it.done) c.done++;
    if (!it.who) c.none++;
    else { c.assigned++; c[it.who]++; }
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
  const sel = document.createElement("select");
  sel.className = "who";
  sel.id = "who-" + it.id;
  sel.append(new Option("מי מביא?", ""));
  for (const p of PEOPLE) sel.append(new Option(p.name, p.id));
  sel.append(new Option("כל אחד", "all"));
  wrap.append(sel);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "del";
  del.textContent = "מחיקה";

  li.append(tick, txt, wrap, del);
  return li;
}

function updateRow(li, it) {
  li.dataset.who = it.who || "";
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

  const sel = li.querySelector(".who");
  const want = it.who || "";
  if (sel.value !== want) sel.value = want;
  sel.setAttribute("aria-label", "מי מביא: " + it.name);

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
}

function renderTally(c) {
  if (!state.loaded) return;
  tallyEl.textContent = c.total === 0
    ? "אין עדיין פריטים ברשימה"
    : `שובצו ${c.assigned} מתוך ${c.total}` + (c.done ? ` · ${c.done} ארוזים` : "");
  meterEl.textContent = "";
  const segs = [...PEOPLE.map((p) => [p.id, c[p.id]]), ["all", c.all], ["none", c.none]];
  for (const [id, n] of segs) {
    if (!n) continue;
    const s = document.createElement("span");
    s.className = "seg seg-" + id;
    s.style.flexGrow = String(n);
    meterEl.append(s);
  }
}

function renderChips(c) {
  const f = effectiveFilter();
  for (const b of chipsEl.children) {
    const id = b.dataset.f;
    const n = id === "all" ? c.total : id === "none" ? c.none : c[id] + c.all;
    b.querySelector(".n").textContent = state.loaded ? String(n) : "";
    b.setAttribute("aria-pressed", String(f === id));
    b.disabled = state.editing;
  }
}

function renderSections() {
  if (!state.loaded) return;
  const f = effectiveFilter();
  const byCat = new Map(CATS.map((cat) => [cat.id, []]));
  for (const it of sortItems(state.items)) byCat.get(it.cat).push(it);

  let shown = 0;
  for (const cat of CATS) {
    const sec = sections.get(cat.id);
    const all = byCat.get(cat.id);
    const rows = all.filter((it) => passes(it, f));
    const visible = rows.length > 0 || state.editing;
    sec.hidden = !visible;
    if (!visible) continue;
    shown++;
    const assigned = all.filter((it) => it.who).length;
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
  } else if (f === "none") {
    listStateText.textContent = "כל הפריטים כבר שובצו.";
  } else {
    listStateText.textContent = `${WHO_LABEL[f] || ""} עוד לא לקח כלום.`;
  }
}

function renderChrome() {
  filtersEl.hidden = !state.loaded || state.items.length === 0;
  actionsEl.hidden = !state.loaded;
  const hasItems = state.items.length > 0;
  copyBtn.hidden = !hasItems;
  waLink.hidden = !hasItems;
  if (hasItems) waLink.href = "https://wa.me/?text=" + encodeURIComponent(summary(true));
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

// Full version for the copy button; the WhatsApp share link gets a short one
// (who brings what, how many are still free, and the link) so the message stays readable.
function summary(short) {
  const items = sortItems(state.items);
  const line = (it) => `${it.done ? "✓" : "•"} ${it.name}${it.note && !short ? ` (${it.note})` : ""}`;
  const out = ["*קמפינג: מי מביא מה*"];
  for (const p of [...PEOPLE, { id: "all", name: "כל אחד מביא לעצמו" }]) {
    const mine = items.filter((it) => it.who === p.id);
    if (!mine.length) continue;
    out.push("", `*${p.name}* (${mine.length})`, ...mine.map(line));
  }
  const free = items.filter((it) => !it.who);
  if (free.length && short) out.push("", `עוד ${free.length} פריטים פנויים.`);
  else if (free.length) out.push("", `*עוד פנויים* (${free.length})`, ...free.map(line));
  const url = pageUrl();
  if (url) out.push("", "לבחירה ולעדכון: " + url);
  return out.join("\n");
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

function enqueue(key, job) {
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
    onWriteError(err, key);
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
  if (t.classList.contains("who")) {
    const who = t.value || null;
    if (who !== it.who) patch = { who };
  } else if (t.classList.contains("nm-in")) {
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
  if (btn.classList.contains("tick")) {
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
  state.filter = state.filter === f && f !== "all" ? "all" : f;
  local.set("camping.filter", state.filter);
  render();
  const anchorTop = filtersAnchor.getBoundingClientRect().top + window.scrollY;
  if (window.scrollY > anchorTop) window.scrollTo({ top: anchorTop, behavior: reduceMotion ? "auto" : "smooth" });
});

editBtn.addEventListener("click", () => {
  if (!api) return;
  state.editing = !state.editing;
  render();
});

copyBtn.addEventListener("click", () => {
  const text = summary();
  const ok = () => toast("הסיכום הועתק. אפשר להדביק בקבוצה.");
  const fallback = () => {
    copyText.value = text;
    copyPanel.hidden = false;
    copyText.focus();
    copyText.select();
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  } catch (err) {
    fallback();
  }
});

copyClose.addEventListener("click", () => {
  copyPanel.hidden = true;
  copyBtn.focus();
});

window.addEventListener("online", renderSync);
window.addEventListener("offline", renderSync);

/* ---------- personal list (this device only) ---------- */

function wirePersonal() {
  const key = "camping.personal.v1";
  const saved = local.get(key, []);
  const checked = new Set(Array.isArray(saved) ? saved : []);
  for (const cb of document.querySelectorAll(".plist input[type=checkbox]")) {
    cb.checked = checked.has(cb.id);
    cb.addEventListener("change", () => {
      if (cb.checked) checked.add(cb.id); else checked.delete(cb.id);
      local.set(key, Array.from(checked));
    });
  }
}

/* ---------- Firebase ---------- */

function makeApi(F, db) {
  const itemsCol = F.collection(db, "items");
  const itemRef = (id) => F.doc(db, "items", id);
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
wirePersonal();
renderSync();
connect();
