// engine-lite.js — core CONDIVISO con l'app piena (FULL).
// ⚠️ reduceMoves() è una COPIA VERBATIM di engine.js della FULL: se cambia là,
//    va aggiornata anche qui (stesso protocollo di mosse = stato d'asta coerente
//    tra FULL e LITE). Tutto il resto della LITE è volutamente minimale.

export const ROLES = ["P", "D", "C", "A"];

// --- reduceMoves: identica alla FULL (log di mosse append-only → acquisti) ---
export function reduceMoves(moves) {
  const events = Array.isArray(moves)
    ? moves.map((m, i) => ({ id: m.id ?? m.uid ?? String(i), ...m }))
    : Object.entries(moves || {}).map(([id, m]) => ({ id, ...(m || {}) }));

  const byUid = new Map();
  for (const e of events) {
    if (!e || !e.uid) { byUid.set(Symbol(), e); continue; }
    const prev = byUid.get(e.uid);
    if (!prev) { byUid.set(e.uid, e); continue; }
    const prevTs = typeof prev.ts === "number" ? prev.ts : -1;
    const curTs = typeof e.ts === "number" ? e.ts : -1;
    if (curTs >= prevTs) byUid.set(e.uid, e);
  }
  const uniq = [...byUid.values()].filter(Boolean);

  uniq.sort((a, b) => {
    const ta = typeof a.ts === "number" ? a.ts : Infinity;
    const tb = typeof b.ts === "number" ? b.ts : Infinity;
    if (ta !== tb) return ta - tb;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });

  const byPlayer = new Map();
  for (const e of uniq) {
    if (!e || !e.playerId || !e.type) continue;
    const cur = byPlayer.get(e.playerId) || { present: false };
    if (e.type === "buy") {
      byPlayer.set(e.playerId, {
        present: true, price: e.price, team: e.team,
        nome: e.nome ?? cur.nome, ruolo: e.ruolo ?? cur.ruolo, squadra: e.squadra ?? cur.squadra,
      });
    } else if (e.type === "undo") {
      byPlayer.set(e.playerId, { ...cur, present: false });
    } else if (e.type === "move") {
      byPlayer.set(e.playerId, {
        ...cur, present: cur.present !== false, team: e.team,
        price: e.price != null ? e.price : cur.price,
        nome: e.nome ?? cur.nome, ruolo: e.ruolo ?? cur.ruolo, squadra: e.squadra ?? cur.squadra,
      });
    }
  }

  const purchases = [];
  for (const [playerId, v] of byPlayer) {
    if (!v.present) continue;
    purchases.push({
      playerId, price: Math.max(1, Math.round(v.price || 1)),
      team: v.team, nome: v.nome, ruolo: v.ruolo, squadra: v.squadra,
    });
  }
  return purchases;
}

// --- budget/slot per squadra (solo conteggi, nessun prezzo consigliato) ---
export function computeTeams(purchases, config) {
  const roster = config.roster || { P: 3, D: 8, C: 8, A: 6 };
  const budget = config.budgetPerTeam || 500;
  // elenco squadre: dalla config di lega; in mancanza, dedotto dagli acquisti
  let names = Array.isArray(config.teams) && config.teams.length
    ? config.teams.slice()
    : [...new Set(purchases.map((p) => p.team).filter(Boolean))];
  const map = new Map(names.map((n) => [n, { name: n, spent: 0, count: 0, filled: { P: 0, D: 0, C: 0, A: 0 } }]));
  for (const pu of purchases) {
    const t = map.get(pu.team); if (!t) continue;
    const price = Math.max(1, Math.round(pu.price || 1));
    t.spent += price; t.count += 1;
    if (ROLES.includes(pu.ruolo)) t.filled[pu.ruolo] += 1;
  }
  return names.map((name) => {
    const t = map.get(name);
    const slotsRemaining = {}; let slotsTot = 0;
    for (const r of ROLES) { const rem = Math.max(0, (roster[r] || 0) - t.filled[r]); slotsRemaining[r] = rem; slotsTot += rem; }
    return {
      name, spent: t.spent, budgetLeft: budget - t.spent, count: t.count, filled: t.filled,
      slotsRemaining, slotsRemainingTotal: slotsTot,
      maxBid: Math.max(0, budget - t.spent - Math.max(0, slotsTot - 1)),
    };
  });
}
