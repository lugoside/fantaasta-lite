// app.js — FantaAsta LITE (versione avversari). UI ridotta + client di sync.
// Contratto con l'app piena (FULL):
//   - /leghe/<code>/config  → config di LEGA: SOLA LETTURA (la scrive solo la FULL/admin)
//   - /leghe/<code>/moves   → log di mosse append-only: la LITE APPENDE i propri acquisti
// Stato d'asta = reduceMoves(moves), identico alla FULL. Nessun dato "vantaggioso"
// (prezzi consigliati, valori, tier, titolarità…): la LITE non li ha proprio.
import { ROLES, reduceMoves, computeTeams } from "./engine-lite.js";

const LS = {
  sync: "fal_sync", moves: "fal_moves", config: "fal_config", myteam: "fal_myteam",
  device: "fal_device", players: "fal_players", meta: "fal_meta", fav: "fal_favorites",
  resetSeen: "fal_reset_seen",
};
const APP_VERSION = "lite-v23"; // mostrata in Setup per capire se l'app è aggiornata (allineata a sw.js)
const RUOLO_NOME = { P: "Portiere", D: "Difensore", C: "Centrocampista", A: "Attaccante" };
// Dal 2/9/2026 la scelta "La mia squadra" si blocca dietro la password admin (in vista dell'asta):
// prima resta libera (gli avversari scelgono la loro squadra), dopo si cambia solo da sbloccati.
const LOCK_MYTEAM_FROM = Date.parse("2026-09-02T00:00:00");

function load(k, f) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch { return f; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

// Default della lega di Valerio: stesso DB e Codice Lega della FULL (stato condiviso).
let SYNC = load(LS.sync, {
  url: "https://fantaasta-62ee7-default-rtdb.europe-west1.firebasedatabase.app/",
  code: "lugoasta", on: true,
});
let MOVES = load(LS.moves, []);
let resetSeen = load(LS.resetSeen, 0); // ultimo resetAt applicato (reset di lega)
let CONFIG = load(LS.config, { numTeams: 10, budgetPerTeam: 500, roster: { P: 3, D: 8, C: 8, A: 6 }, teams: [], auctionOpen: true, resetAt: 0 });
let MYTEAM = load(LS.myteam, "");          // quale squadra sono io (scelta LOCALE)
let FAVORITES = new Set(load(LS.fav, [])); // obiettivi personali (solo locali)
let PURCHASES = [];
let PLAYERS = [];
let META = {};
let selectedId = null;
let buyPrice = null;
let buyConfirm = false; // step di conferma acquisto (evita acquisti involontari)
let DEVICE_ID = load(LS.device, "");
if (!DEVICE_ID) { DEVICE_ID = "lit-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); save(LS.device, DEVICE_ID); }
let _esMoves = null, _esConfig = null, _pollId = null, _status = "off";
const _inflight = new Set(); // uid delle mosse in invio (in MEMORIA): dedup senza perdere ritenti
const ui = { screen: "asta", search: "", expanded: new Set(), role: "ALL", sort: "nome", onlyFav: false, hideTaken: false, searchL: "" };
let obDismissed = false; // onboarding: chiuso manualmente per questa sessione (per raggiungere il Setup)
let syncUnlocked = false; // collegamento alla lega sbloccato per la modifica (solo questa sessione)
// Guardrail SOFT (non sicurezza: il repo è pubblico). Hash SHA-256 della password admin.
const ADMIN_PW_HASH = "7faba760d871c295842460842136c79d8202b494893fe822485a2f5481a30a2c";
async function checkAdminPw(pw) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw || ""));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("") === ADMIN_PW_HASH;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Sync (Firebase RTDB via REST) — config in sola lettura, mosse in append
// ---------------------------------------------------------------------------
function persistSync() { save(LS.sync, SYNC); }
function saveMoves() { save(LS.moves, MOVES); }
function nodeBase() { return SYNC.url && SYNC.code ? SYNC.url.replace(/\/+$/, "") + "/leghe/" + encodeURIComponent(SYNC.code.trim()) : null; }
function movesUrl() { const b = nodeBase(); return b ? b + "/moves" : null; }
function configUrl() { const b = nodeBase(); return b ? b + "/config" : null; }
function mkUid() { return (DEVICE_ID.replace(/^lit-/, "").slice(0, 6) || "x") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7); }
function setStatus(s) { _status = s; if (ui.screen === "setup") renderSetup(); }

function rebuildPurchases() { PURCHASES = reduceMoves(MOVES); }

// applica subito la mossa in locale (ottimistica) e la spedisce sul cloud
function emitMove(mv) {
  const m = { uid: mkUid(), id: null, type: mv.type, playerId: mv.playerId, ts: Date.now(), byDevice: DEVICE_ID, posted: false };
  m.id = m.uid;
  for (const k of ["team", "price", "nome", "ruolo", "squadra"]) if (mv[k] != null) m[k] = mv[k];
  MOVES.push(m);
  saveMoves(); rebuildPurchases();
  pushMove(m);
  return m;
}
async function pushMove(m) {
  const url = movesUrl(); if (!SYNC.on || !url || m.posted || _inflight.has(m.uid)) return; // già inviata / in invio
  _inflight.add(m.uid);                                             // dedup concorrenza (in memoria)
  const body = { uid: m.uid, type: m.type, playerId: m.playerId, byDevice: m.byDevice, ts: { ".sv": "timestamp" } };
  for (const k of ["team", "price", "nome", "ruolo", "squadra"]) if (m[k] != null) body[k] = m[k];
  try {
    await fetch(url + ".json", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    m.posted = true; saveMoves(); setStatus("ok");                 // posted solo DOPO invio riuscito → fetch interrotta = ritentata
  } catch { setStatus("err"); }
  finally { _inflight.delete(m.uid); }
}
async function flushPending() {
  if (!SYNC.on) return;
  for (const m of MOVES.filter((x) => x.posted === false && x.byDevice === DEVICE_ID)) await pushMove(m);
}
function mergeCloudMoves(obj) {
  if (!obj || typeof obj !== "object") return false;
  const byUid = new Map(MOVES.map((m) => [m.uid, m]));
  let changed = false;
  for (const [pushId, mv] of Object.entries(obj)) {
    if (!mv || !mv.uid) continue;
    const local = byUid.get(mv.uid);
    if (!local) { MOVES.push({ ...mv, id: pushId, posted: true }); byUid.set(mv.uid, MOVES[MOVES.length - 1]); changed = true; }
    else if (typeof mv.ts === "number" && (local.ts !== mv.ts || local.id !== pushId || local.posted !== true)) {
      Object.assign(local, mv, { id: pushId, posted: true }); changed = true;
    }
  }
  if (changed) { saveMoves(); rebuildPurchases(); }
  return changed;
}
// config: SOLA LETTURA. Rispecchia la config di lega dal cloud (non scrive mai).
function adoptConfig(remote) {
  if (!remote || typeof remote !== "object") return false;
  // teams[] è il modello attuale; tollera la vecchia forma (myName+opponents) durante la transizione
  const teams = Array.isArray(remote.teams) ? remote.teams
    : (remote.myName != null || Array.isArray(remote.opponents)) ? [remote.myName || "IO", ...(remote.opponents || [])]
    : (CONFIG.teams || []);
  const next = {
    numTeams: remote.numTeams ?? CONFIG.numTeams,
    budgetPerTeam: remote.budgetPerTeam ?? CONFIG.budgetPerTeam,
    roster: remote.roster ?? CONFIG.roster,
    teams,
    auctionOpen: remote.auctionOpen === false ? false : true, // assente = aperta
    resetAt: Math.max(CONFIG.resetAt || 0, remote.resetAt || 0), // MONOTÒNO: non scende mai
  };
  if (JSON.stringify(next) === JSON.stringify(CONFIG)) return false;
  CONFIG = next; save(LS.config, CONFIG);
  if (MYTEAM && !CONFIG.teams.includes(MYTEAM)) { MYTEAM = ""; save(LS.myteam, MYTEAM); } // squadra sparita dall'elenco
  // reset di lega: l'admin ha azzerato → svuota le mosse locali (il cloud è già stato svuotato)
  if ((CONFIG.resetAt || 0) > resetSeen) { MOVES = []; saveMoves(); resetSeen = CONFIG.resetAt; save(LS.resetSeen, resetSeen); rebuildPurchases(); }
  return true;
}
async function reconcile() {
  const cu = configUrl(), mu = movesUrl(); if (!SYNC.on || !cu || !mu) return;
  try {
    const rc = await (await fetch(cu + ".json", { cache: "no-store" })).json();
    adoptConfig(rc);
    const rm = await (await fetch(mu + ".json", { cache: "no-store" })).json();
    mergeCloudMoves(rm);
    await flushPending();
    renderAll(); setStatus("ok");
  } catch { setStatus("err"); }
}
async function pullOnce() {
  const mu = movesUrl(), cu = configUrl(); if (!SYNC.on || !mu) return;
  try {
    const rm = await (await fetch(mu + ".json", { cache: "no-store" })).json();
    const cm = mergeCloudMoves(rm);
    const rc = await (await fetch(cu + ".json", { cache: "no-store" })).json();
    const cc = adoptConfig(rc);
    if (cm || cc) renderAll();
    await flushPending(); setStatus("ok");
  } catch { setStatus("err"); }
}
function connectSSE() {
  for (const es of [_esMoves, _esConfig]) if (es) es.close();
  _esMoves = _esConfig = null;
  const mu = movesUrl(), cu = configUrl();
  if (!SYNC.on || !mu || typeof EventSource === "undefined") return;
  try {
    _esMoves = new EventSource(mu + ".json");
    const onMoves = (ev) => {
      try {
        const msg = JSON.parse(ev.data); if (!msg) return;
        if (msg.path === "/") { if (mergeCloudMoves(msg.data)) renderAll(); }
        else if (msg.path && msg.data && msg.data.uid) {
          const pid = msg.path.replace(/^\//, "");
          if (mergeCloudMoves({ [pid]: msg.data })) renderAll();
        }
      } catch {}
    };
    _esMoves.addEventListener("put", onMoves);
    _esMoves.addEventListener("patch", onMoves);
    _esMoves.onopen = () => setStatus("ok");
    _esMoves.onerror = () => setStatus("err");

    _esConfig = new EventSource(cu + ".json");
    const onConfig = () => { pullConfigOnce(); };
    _esConfig.addEventListener("put", onConfig);
    _esConfig.addEventListener("patch", onConfig);
  } catch { setStatus("err"); }
}
async function pullConfigOnce() {
  const cu = configUrl(); if (!SYNC.on || !cu) return;
  try { const rc = await (await fetch(cu + ".json", { cache: "no-store" })).json(); if (adoptConfig(rc)) renderAll(); } catch {}
}
function startSync() { if (!SYNC.on) return; reconcile().then(connectSSE); if (!_pollId) _pollId = setInterval(pullOnce, 10000); }
function stopSync() { for (const es of [_esMoves, _esConfig]) if (es) es.close(); _esMoves = _esConfig = null; if (_pollId) { clearInterval(_pollId); _pollId = null; } setStatus("off"); }

// ---------------------------------------------------------------------------
// Dati (listone ridotto)
// ---------------------------------------------------------------------------
async function loadData(force = false) {
  try {
    const bust = force ? `?ts=${Date.now()}` : "";
    const [pj, mj] = await Promise.all([
      fetch(`data/players_lite.json${bust}`, { cache: force ? "reload" : "default" }).then((r) => r.json()),
      fetch(`data/players_lite.meta.json${bust}`, { cache: force ? "reload" : "default" }).then((r) => r.json()).catch(() => ({})),
    ]);
    PLAYERS = pj; META = mj; save(LS.players, pj); save(LS.meta, mj);
  } catch (e) {
    PLAYERS = load(LS.players, []); META = load(LS.meta, {});
    if (!PLAYERS.length) throw e;
    toast("Offline: uso l'ultimo listone salvato");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
let toastTimer;
function toast(msg) { const t = document.getElementById("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 1800); }
// gate condiviso: quando l'admin chiude l'asta, la LITE non può registrare/annullare
function auctionClosed() {
  if (CONFIG.auctionOpen === false) { toast("🔒 Asta chiusa: modifiche disabilitate"); return true; }
  return false;
}
const takenIds = () => new Set(PURCHASES.map((p) => p.playerId));
const teamOf = (pid) => { const p = PURCHASES.find((x) => x.playerId === pid); return p ? p.team : null; };
// ts dell'ultima mossa per giocatore, per ordinare "ultimi acquisti"
function moveTsMap() { const m = new Map(); for (const mv of MOVES) if (mv.playerId) { const t = typeof mv.ts === "number" ? mv.ts : 0; if (!m.has(mv.playerId) || t >= m.get(mv.playerId)) m.set(mv.playerId, t); } return m; }

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function renderAll() {
  renderOnboarding();
  renderDataChip();
  if (ui.screen === "asta") renderAsta();
  if (ui.screen === "listone") renderListone();
  if (ui.screen === "squadre") renderSquadre();
  if (ui.screen === "setup") renderSetup();
}

// Prima apertura: finché non hai scelto la tua squadra, mostra la schermata di scelta.
// Dopo, si cambia solo dal Setup (con la ⭐). obDismissed = via di fuga verso il Setup.
function renderOnboarding() {
  const el = document.getElementById("onboarding");
  if (MYTEAM || obDismissed) { el.style.display = "none"; return; }
  const teams = CONFIG.teams || [];
  el.style.display = "flex";
  el.innerHTML = `<div class="ob-card">
    <div class="ob-logo">⚽</div>
    <h2>Fanta<span>Asta</span> LITE</h2>
    <p>Qual è la <b>tua squadra</b> in questa lega?</p>
    ${teams.length
      ? `<div class="team-pick">${teams.map((t) => `<button class="pickbtn" data-pickteam="${esc(t)}">${esc(t)}</button>`).join("")}</div>`
      : `<div class="ob-wait">⏳ Mi collego alla lega…<div class="hint" style="margin-top:8px">Se le squadre non compaiono, controlla il <b>Codice Lega</b>.</div><button class="btn ghost full" id="obSetup" style="margin-top:16px">⚙️ Apri Setup</button></div>`}
  </div>`;
}
function renderDataChip() {
  const chip = document.getElementById("dataChip"); if (!chip) return;
  chip.textContent = META.fonteAggiornata ? `listone ${META.fonteAggiornata}` : (META.numGiocatori ? `${META.numGiocatori} giocatori` : "…");
}
function setScreen(name) {
  ui.screen = name;
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === `screen-${name}`));
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.screen === name));
  renderAll();
}

// ---- ASTA ----
function renderAsta() {
  const ban = document.getElementById("auctionBanner");
  if (ban) ban.style.display = CONFIG.auctionOpen === false ? "block" : "none";
  const card = document.getElementById("calledCard");
  const p = selectedId ? PLAYERS.find((x) => x.id === selectedId) : null;
  if (!p) {
    card.className = "called empty";
    card.textContent = "Cerca un giocatore per registrarne l'acquisto.";
  } else {
    const taken = takenIds().has(p.id);
    const price = buyPrice != null ? buyPrice : 1; // l'offerta parte sempre da 1
    card.className = "called";
    card.innerHTML = `
      <div class="top">
        <span class="rp ${p.ruolo}">${p.ruolo}</span>
        <div class="grow">
          <div class="nome">${p.isNuovo ? "🆕 " : ""}${esc(p.nome)}</div>
          <div class="sub">${esc(p.squadra)}${(p.qa ?? p.qi) != null ? ` · Quot ${p.qa ?? p.qi}` : ""} · ${RUOLO_NOME[p.ruolo]}</div>
        </div>
      </div>
      ${taken ? `
        <div class="taken-box">✔ Già preso da <b>${esc(teamOf(p.id) || "?")}</b></div>
      ` : CONFIG.auctionOpen === false ? `
        <div class="taken-box">🔒 Asta chiusa: non puoi registrare acquisti finché l'admin non la riapre.</div>
      ` : !MYTEAM ? `
        <div class="taken-box">Imposta prima la <b>tua squadra</b> (alla prima apertura o in Setup).</div>
      ` : buyConfirm ? `
        <div class="confirm-box">Confermi l'acquisto?<br><b>${esc(p.nome)}</b> <span style="opacity:.7">(${esc(p.squadra)})</span><br><b>${price}</b> crediti · <b>${esc(MYTEAM)}</b></div>
        <div class="buy-actions">
          <button class="btn me" data-confirmbuy="1">✓ Conferma</button>
          <button class="btn ghost" data-cancelbuy="1">✗ Annulla</button>
        </div>
      ` : `
        <div class="buy-row">
          <button class="step" data-step="-1">−</button>
          <input id="priceInput" type="number" inputmode="numeric" min="1" value="${price}" />
          <button class="step" data-step="1">+</button>
        </div>
        <button class="btn me full" data-buymine="1">✓ Compra per ${esc(MYTEAM)}</button>
      `}
    `;
  }
  renderRecent();
}
function renderRecent() {
  const el = document.getElementById("recentList");
  if (!PURCHASES.length) { el.innerHTML = `<div class="row"><span class="meta">Nessun acquisto ancora.</span></div>`; return; }
  const ts = moveTsMap();
  const list = [...PURCHASES].sort((a, b) => (ts.get(b.playerId) || 0) - (ts.get(a.playerId) || 0)).slice(0, 12);
  el.innerHTML = list.map((pu) => {
    const pl = PLAYERS.find((x) => x.id === pu.playerId) || { ruolo: pu.ruolo || "?", nome: pu.nome || pu.playerId };
    return `<div class="row">
      <span class="rp ${pl.ruolo}">${pl.ruolo}</span>
      <div class="grow"><div class="nome">${esc(pl.nome)}</div><div class="meta">${esc(pu.team || "?")}</div></div>
      <span class="price">${pu.price}</span>
    </div>`;
  }).join("");
}

// ---- LISTONE (solo dati pubblici: nome, squadra, ruolo, Qi, stato preso) ----
function renderListone() {
  const el = document.getElementById("listoneList");
  const taken = new Map(PURCHASES.map((p) => [p.playerId, p]));
  let list = PLAYERS.slice();
  if (ui.role !== "ALL") list = list.filter((p) => p.ruolo === ui.role);
  if (ui.onlyFav) list = list.filter((p) => FAVORITES.has(p.id));
  if (ui.hideTaken) list = list.filter((p) => !taken.has(p.id));
  if (ui.searchL) { const q = ui.searchL.toLowerCase(); list = list.filter((p) => p.nome.toLowerCase().includes(q) || p.squadra.toLowerCase().includes(q)); }
  const cmp = { nome: (a, b) => a.nome.localeCompare(b.nome), squadra: (a, b) => a.squadra.localeCompare(b.squadra) || a.nome.localeCompare(b.nome), quotazione: (a, b) => ((b.qa ?? b.qi) || 0) - ((a.qa ?? a.qi) || 0) || a.nome.localeCompare(b.nome) }[ui.sort] || ((a, b) => a.nome.localeCompare(b.nome));
  list.sort(cmp);
  el.innerHTML = list.slice(0, 300).map((p) => {
    const t = taken.get(p.id);
    return `<div class="row ${t ? "taken" : ""}" data-pick="${esc(p.id)}">
      <button class="star ${FAVORITES.has(p.id) ? "on" : ""}" data-fav="${esc(p.id)}">${FAVORITES.has(p.id) ? "★" : "☆"}</button>
      <span class="rp ${p.ruolo}">${p.ruolo}</span>
      <div class="grow"><div class="nome">${p.isNuovo ? "🆕 " : ""}${esc(p.nome)}</div>
        <div class="meta">${esc(p.squadra)}${(p.qa ?? p.qi) != null ? ` · Quot ${p.qa ?? p.qi}` : ""}${t ? ` · preso ${esc(t.team)}` : ""}</div></div>
      <span class="price">${t ? t.price : ""}</span>
    </div>`;
  }).join("") || `<div class="row"><span class="meta">Nessun giocatore.</span></div>`;
}
function toggleFav(id) {
  if (FAVORITES.has(id)) FAVORITES.delete(id); else FAVORITES.add(id);
  save(LS.fav, [...FAVORITES]);
  if (ui.screen === "listone") renderListone();
}

// ---- SQUADRE ----
function renderSquadre() {
  const el = document.getElementById("teamsList");
  const teams = computeTeams(PURCHASES, CONFIG);
  if (!teams.length) { el.innerHTML = `<div class="row"><span class="meta">In attesa della configurazione di lega dall'admin.</span></div>`; return; }
  teams.sort((a, b) => (a.name === MYTEAM ? 0 : 1) - (b.name === MYTEAM ? 0 : 1)); // la mia squadra in cima (resto in ordine)
  const budget = CONFIG.budgetPerTeam || 500;
  el.innerHTML = teams.map((t) => {
    const pct = Math.max(0, Math.min(100, (t.budgetLeft / budget) * 100));
    const open = ui.expanded.has(t.name);
    const isMe = t.name === MYTEAM;
    const roster = PURCHASES.filter((pu) => pu.team === t.name).map((pu) => {
      const pl = PLAYERS.find((x) => x.id === pu.playerId) || { ruolo: pu.ruolo || "?", nome: pu.nome || pu.playerId };
      return { ruolo: pl.ruolo, nome: pl.nome, price: pu.price };
    }).sort((a, b) => ROLES.indexOf(a.ruolo) - ROLES.indexOf(b.ruolo) || b.price - a.price);
    const rosterHtml = open ? `<div class="roster">${roster.length ? roster.map((r) => `
      <div class="rrow"><span class="rp ${r.ruolo}">${r.ruolo}</span><span class="rn">${esc(r.nome)}</span><span class="rprice">${r.price}</span></div>`).join("") : `<div class="rempty">Nessun giocatore ancora.</div>`}</div>` : "";
    return `<div class="team">
      <div class="hd tap" data-team="${esc(t.name)}">
        <span class="nm ${isMe ? "me" : ""}">${open ? "▾" : "▸"} ${isMe ? "⭐ " : ""}${esc(t.name)}</span>
        <span class="bud">${t.budgetLeft} <small>/ ${budget}</small></span>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="slotline">${ROLES.map((r) => `<span class="slot ${r}">${r} ${(CONFIG.roster[r] || 0) - (t.slotsRemaining[r] ?? CONFIG.roster[r])}/${CONFIG.roster[r] || 0}</span>`).join("")}</div>
      ${rosterHtml}
    </div>`;
  }).join("");
}

// ---- SETUP ----
function renderSetup() {
  document.getElementById("metaInfo").innerHTML =
    `Stagione <b>${META.stagione || "?"}</b> · ${META.numGiocatori || PLAYERS.length} giocatori` +
    (META.fonteAggiornata ? `<br>📅 Listone: <b>${esc(META.fonteAggiornata)}</b>` : "") +
    `<br><span style="opacity:.55">app ${APP_VERSION}</span>`;

  const u = document.getElementById("syncUrl"); if (document.activeElement !== u) u.value = SYNC.url || "";
  const c = document.getElementById("syncCode"); if (document.activeElement !== c) c.value = SYNC.code || "";
  const st = { ok: "🟢 connesso", err: "🔴 errore (controlla URL e Codice Lega)", off: "⚪ spenta" }[_status] || "";
  document.getElementById("syncStatus").innerHTML = SYNC.on ? "Stato: " + st : "Sincronizzazione spenta";
  document.getElementById("syncToggle").textContent = SYNC.on ? "⏸ Disattiva" : "▶ Attiva";
  // collegamento alla lega nascosto finché non si sblocca con la password admin
  const locked = !syncUnlocked;
  document.getElementById("unlockRow").style.display = locked ? "" : "none";
  document.getElementById("adminFields").style.display = locked ? "none" : "";

  // dal 2/9 la scelta squadra è bloccata dietro la password admin (a meno di sblocco in sessione)
  const myTeamLocked = Date.now() >= LOCK_MYTEAM_FROM && !syncUnlocked;
  document.getElementById("myTeamBlock").style.display = myTeamLocked ? "none" : "";
  document.getElementById("myTeamLocked").style.display = myTeamLocked ? "" : "none";

  const sel = document.getElementById("myTeamSel");
  const teams = CONFIG.teams || [];
  if (!teams.length) {
    sel.innerHTML = `<div class="hint">In attesa dell'elenco squadre dall'admin (config di lega). Se non compaiono, chiedi all'admin di verificare il collegamento.</div>`;
  } else {
    sel.innerHTML = `<div class="team-pick">${teams.map((t) => `
      <button class="pickbtn ${t === MYTEAM ? "on" : ""}" data-pickteam="${esc(t)}">${t === MYTEAM ? "⭐ " : ""}${esc(t)}</button>`).join("")}</div>
      <div class="hint" style="margin-top:6px">Scelta locale: dice all'app quale squadra sei tu (per registrare "preso da me"). Non cambia nulla per gli altri.</div>`;
  }
}

// ---------------------------------------------------------------------------
// Azioni
// ---------------------------------------------------------------------------
function selectPlayer(id) {
  selectedId = id; buyPrice = null; setScreen("asta");
  const s = document.getElementById("search"); if (s) s.value = "";
  document.getElementById("searchResults").innerHTML = "";
  renderAll();
}
function recordBuy(team) {
  if (auctionClosed()) return;
  const p = PLAYERS.find((x) => x.id === selectedId); if (!p || !team) return;
  const price = Math.max(1, Math.round(buyPrice != null ? buyPrice : 1));
  emitMove({ type: "buy", playerId: p.id, team, price, nome: p.nome, ruolo: p.ruolo, squadra: p.squadra });
  toast(`${p.nome} → ${team} a ${price}`);
  selectedId = null; buyPrice = null; buyConfirm = false; renderAll();
}
// La LITE NON annulla acquisti (funzione riservata all'admin nella FULL).

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wire() {
  document.getElementById("tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-screen]"); if (b) setScreen(b.dataset.screen); });

  const search = document.getElementById("search");
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    const res = document.getElementById("searchResults");
    if (q.length < 2) { res.innerHTML = ""; return; }
    const taken = takenIds();
    const found = PLAYERS.filter((p) => p.nome.toLowerCase().includes(q) || p.squadra.toLowerCase().includes(q))
      .sort((a, b) => Number(taken.has(a.id)) - Number(taken.has(b.id)) || a.nome.localeCompare(b.nome)).slice(0, 12);
    res.innerHTML = found.map((p) => `
      <div class="result-row ${taken.has(p.id) ? "taken" : ""}" data-pick="${esc(p.id)}">
        <span class="rp ${p.ruolo}">${p.ruolo}</span>
        <div class="grow"><div class="nome">${esc(p.nome)}</div><div class="meta">${esc(p.squadra)}</div></div>
        <span class="price">${taken.has(p.id) ? "preso" : ""}</span>
      </div>`).join("");
  });

  document.body.addEventListener("input", (e) => { if (e.target && e.target.id === "priceInput") buyPrice = Math.max(1, Math.round(Number(e.target.value) || 1)); });

  // filtri Listone
  document.getElementById("searchL").addEventListener("input", (e) => { ui.searchL = e.target.value.trim(); renderListone(); });
  document.getElementById("roleFilters").addEventListener("click", (e) => {
    const c = e.target.closest("[data-role]"); if (!c) return;
    ui.role = c.dataset.role;
    document.querySelectorAll("#roleFilters [data-role]").forEach((x) => x.classList.toggle("on", x === c));
    renderListone();
  });
  document.getElementById("sortBy").addEventListener("change", (e) => { ui.sort = e.target.value; renderListone(); });
  document.getElementById("onlyFav").addEventListener("click", (e) => { ui.onlyFav = !ui.onlyFav; e.target.classList.toggle("on", ui.onlyFav); renderListone(); });
  document.getElementById("hideTaken").addEventListener("click", (e) => { ui.hideTaken = !ui.hideTaken; e.target.classList.toggle("on", ui.hideTaken); renderListone(); });

  document.body.addEventListener("click", (e) => {
    const fav = e.target.closest("[data-fav]"); if (fav) { e.stopPropagation(); toggleFav(fav.dataset.fav); return; }
    const pick = e.target.closest("[data-pick]"); if (pick) { selectPlayer(pick.dataset.pick); return; }
    const step = e.target.closest("[data-step]"); if (step) { const inp = document.getElementById("priceInput"); const v = Math.max(1, (Number(inp.value) || 1) + Number(step.dataset.step)); inp.value = v; buyPrice = v; return; }
    const team = e.target.closest("[data-team]"); // solo espansione nella schermata Squadre
    if (team) { const n = team.dataset.team; if (ui.expanded.has(n)) ui.expanded.delete(n); else ui.expanded.add(n); renderSquadre(); return; }
    const buymine = e.target.closest("[data-buymine]");
    if (buymine) { const inp = document.getElementById("priceInput"); buyPrice = Math.max(1, Math.round(Number(inp?.value) || 1)); buyConfirm = true; renderAsta(); return; }
    const confirmbuy = e.target.closest("[data-confirmbuy]"); if (confirmbuy) { recordBuy(MYTEAM); return; }
    const cancelbuy = e.target.closest("[data-cancelbuy]"); if (cancelbuy) { buyConfirm = false; renderAsta(); return; }
    const pickteam = e.target.closest("[data-pickteam]"); if (pickteam) { if (Date.now() >= LOCK_MYTEAM_FROM && !syncUnlocked) { toast("Scelta squadra bloccata: sbloccala in Impostazioni admin"); return; } MYTEAM = pickteam.dataset.pickteam; save(LS.myteam, MYTEAM); renderAll(); toast(`Sei: ${MYTEAM}`); return; }
    const obSetup = e.target.closest("#obSetup"); if (obSetup) { obDismissed = true; setScreen("setup"); return; }
    const unlockBtn = e.target.closest("#unlockBtn");
    if (unlockBtn) {
      const inp = document.getElementById("unlockPw"); const pw = inp ? inp.value : "";
      checkAdminPw(pw).then((ok) => {
        if (ok) { syncUnlocked = true; if (inp) inp.value = ""; renderSetup(); toast("Collegamento sbloccato"); }
        else toast("Password errata");
      });
      return;
    }
  });

  document.getElementById("syncUrl").addEventListener("change", (e) => { SYNC.url = e.target.value.trim(); persistSync(); if (SYNC.on) startSync(); });
  document.getElementById("syncCode").addEventListener("change", (e) => { SYNC.code = e.target.value.trim(); persistSync(); if (SYNC.on) startSync(); });
  document.getElementById("syncToggle").addEventListener("click", () => {
    SYNC.on = !SYNC.on; persistSync();
    if (SYNC.on) { startSync(); toast("Sincronizzazione attivata"); } else { stopSync(); toast("Disattivata"); }
    renderSetup();
  });
  document.getElementById("refreshData").addEventListener("click", async (e) => {
    e.target.textContent = "⏳…"; try { await loadData(true); toast("Dati aggiornati"); } catch { toast("Aggiornamento fallito"); }
    e.target.textContent = "🔄 Aggiorna dati"; renderAll();
  });
  document.getElementById("forceApp").addEventListener("click", forceAppUpdate);
}

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------
async function init() {
  wire();
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
  try { await loadData(false); } catch { document.getElementById("calledCard").textContent = "Impossibile caricare i dati."; }
  rebuildPurchases();
  renderAll();
  if (SYNC.on) startSync();
  // tornando in primo piano, riallinea SUBITO (mobile sospende SSE/timer in background)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && SYNC.on) { pullOnce(); connectSSE(); }
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    let _ref = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (_ref) return; _ref = true; location.reload(); });
  }
}
async function forceAppUpdate() {
  try {
    if ("serviceWorker" in navigator) { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map((r) => r.unregister())); }
    if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); }
  } catch {}
  location.reload();
}
init();
