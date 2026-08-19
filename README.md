# FantaAsta LITE

Versione "avversari" di FantaAsta: registra gli acquisti dell'asta e li sincronizza
con tutta la lega, **senza** i dati elaborati della versione piena (prezzi consigliati,
valori, tier, titolarità, rigoristi, infortuni…).

- **Dati ridotti**: `docs/data/players_lite.json` contiene solo id, nome, squadra, ruolo, qi, isNuovo.
- **Sync condivisa**: stesso Firebase + Codice Lega della versione piena. La config di lega
  (squadre, budget, slot) è pubblicata dall'app piena (admin) ed è qui in **sola lettura**;
  gli acquisti sono un log di mosse append-only che tutti possono aggiungere.
- **PWA** installabile (GitHub Pages da `/docs`).

Generare i dati ridotti (dalla root del repo FULL): `node pipeline/build_lite.mjs`.
