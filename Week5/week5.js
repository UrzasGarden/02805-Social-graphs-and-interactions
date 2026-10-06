/* Week 5 page script: loads game/game_data.json once, fills the headline numbers,
 * draws "you vs the machine" and the real-vs-AI comparison cards, and starts the game.
 * Works on both week5.html and week5-deep-dive.html (each block is optional). */
(function () {
  "use strict";
  const BEST_KEY = "week5-forger-best";

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const pct = v => `${Math.round(v * 100)}%`;

  // one shared tooltip for every bar on the page
  const tip = el("div", "fig-tooltip");
  document.body.appendChild(tip);
  function attachTip(target, value, label) {
    const show = (x, y) => {
      tip.replaceChildren(el("strong", null, value), el("span", null, label));
      tip.style.display = "block";
      tip.style.left = `${Math.min(x + 14, window.innerWidth - 300)}px`;
      tip.style.top = `${y + 14}px`;
    };
    target.tabIndex = 0;
    target.setAttribute("role", "img");
    target.setAttribute("aria-label", `${label}: ${value}`);
    target.addEventListener("pointermove", e => show(e.clientX, e.clientY));
    target.addEventListener("pointerleave", () => { tip.style.display = "none"; });
    target.addEventListener("focus", () => { const r = target.getBoundingClientRect(); show(r.left + 20, r.bottom); });
    target.addEventListener("blur", () => { tip.style.display = "none"; });
  }

  // a labelled horizontal bar: fraction 0..1 of the track, or null for "not yet"
  function barRow(label, fraction, valueText, kind, emptyText, tipLabel) {
    const row = el("div", "fig-row");
    row.appendChild(el("div", "fig-label", label));
    const track = el("div", "fig-track");
    const bar = el("div", `fig-bar ${kind || ""}` + (fraction === null ? " pending" : ""));
    const val = el("span", "fig-value");
    track.append(bar, val);
    row.appendChild(track);
    function set(f, text) {
      bar.classList.toggle("pending", f === null);
      bar.style.width = f === null ? "" : `${Math.max(f, 0.01) * 100}%`;
      val.textContent = f === null ? emptyText : text;
      const inside = f !== null && f > 0.6;            // long bars carry their label inside, right-aligned
      val.classList.toggle("inside", inside);
      val.style.left = f === null ? "10px" : inside ? "auto" : `calc(${f * 100}% + 8px)`;
      val.style.right = inside ? `calc(${(1 - f) * 100}% + 8px)` : "auto";
      attachTip(bar, f === null ? emptyText : text, tipLabel || label);
    }
    set(fraction, valueText);
    return { row, set };
  }

  function drawVs(root, data) {
    root.replaceChildren();
    const s = data.stats;
    const humans = data.figure.bars.find(b => b.kind === "human");
    let best = null;
    try { best = (JSON.parse(localStorage.getItem(BEST_KEY) || "{}"))["1"] ?? null; } catch (e) { /* optional */ }
    const rows = [
      barRow("Guessing", 0.5, "50%", "reference"),
      barRow("You", best === null ? null : best / 10, best === null ? "" : `${best}/10`, "you", "play the game above", "You (best so far)"),
      barRow("Your classmates", humans && humans.value !== null ? humans.value : null,
             humans && humans.value !== null ? pct(humans.value) : "", "you", "coming after class"),
      barRow("Word counter, 1 clue", s.best_single_pair_accuracy, pct(s.best_single_pair_accuracy), "machine"),
      barRow(`Word counter, all ${s.n_features} clues`, s.d1_pair_accuracy, pct(s.d1_pair_accuracy), "machine"),
    ];
    for (const r of rows) root.appendChild(r.row);
    const axis = el("div", "fig-axis");
    axis.appendChild(el("div"));
    const ticks = el("div", "fig-ticks");
    for (const t of [0, 0.5, 1]) { const sp = el("span", null, pct(t)); sp.style.left = `${t * 100}%`; ticks.appendChild(sp); }
    axis.appendChild(ticks);
    root.appendChild(axis);
    const det = el("details", "table-view");
    det.appendChild(el("summary", null, "Show as a table"));
    const table = el("table");
    const tbody = el("tbody");
    const addRow = (a, b) => { const tr = el("tr"); tr.append(el("td", null, a), el("td", "num", b)); tbody.appendChild(tr); };
    addRow("Guessing", "50%");
    addRow("Your classmates", humans && humans.value !== null ? pct(humans.value) : "coming after class");
    addRow("Word counter, 1 clue (sentence length)", pct(s.best_single_pair_accuracy));
    addRow(`Word counter, all ${s.n_features} clues`, pct(s.d1_pair_accuracy));
    table.appendChild(tbody);
    det.appendChild(table);
    root.appendChild(det);
    return { setYou: (score, of) => rows[1].set(score / of, `${score}/${of}`) };
  }

  const TELLS = {
    sent_len_mean: { title: "It talks longer", sub: "words per sentence", fmt: v => v.toFixed(1) },
    dash_rate: { title: "It loves dashes", sub: "dashes per 100 words", fmt: v => v.toFixed(2) },
    paren_rate: { title: "It over-explains (in brackets)", sub: "brackets per 100 words", fmt: v => v.toFixed(2) },
    unseen_bigram_rate: { title: "It plays it safe", sub: "word pairs no other real article uses", fmt: v => `${Math.round(v * 100)}%` },
  };

  function drawTells(root, data) {
    root.replaceChildren();
    for (const t of data.tells) {
      const meta = TELLS[t.feature];
      if (!meta) continue;
      const card = el("div", "tell");
      card.appendChild(el("h3", null, meta.title));
      const ratio = t.forged / t.real;
      card.appendChild(el("div", "tell-big", ratio >= 1.5 ? `${ratio.toFixed(1)}×` : ratio >= 1 ? `+${Math.round((ratio - 1) * 100)}%` : `${Math.round((1 - ratio) * 100)}% fewer`));
      card.appendChild(el("div", "tell-sub", meta.sub));
      const max = Math.max(t.real, t.forged);
      for (const [lab, v, kind] of [["Real", t.real, "real"], ["AI", t.forged, "machine ai"]]) {
        const row = el("div", "tell-row");
        row.appendChild(el("span", "tell-lab", lab));
        const track = el("div", "tell-track");
        const bar = el("div", `tell-bar ${kind}`);
        bar.style.width = `${(v / max) * 100}%`;
        attachTip(bar, meta.fmt(v), `${lab} articles, ${meta.sub} (median)`);
        track.appendChild(bar);
        row.append(track, el("span", "tell-val", meta.fmt(v)));
        card.appendChild(row);
      }
      card.appendChild(el("div", "tell-foot", `On its own, this clue spots the AI in ${pct(t.pair_accuracy)} of pairs.`));
      root.appendChild(card);
    }
  }

  function fillStats(data) {
    const s = data.stats;
    const values = { n_pairs: String(s.n_pairs), n_features: String(s.n_features),
                     forged_words: s.forged_words.toLocaleString("en-US"), forger_minutes: String(s.forger_minutes),
                     d1_pair_accuracy: pct(s.d1_pair_accuracy), best_single: pct(s.best_single_pair_accuracy),
                     d1_pairs_right: `${s.d1_pairs_right} of ${s.n_pairs}` };
    document.querySelectorAll("[data-stat]").forEach(n => {
      const v = values[n.getAttribute("data-stat")];
      if (v !== undefined) n.textContent = v;
    });
  }

  fetch("game/game_data.json")
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(data => {
      fillStats(data);
      const vsRoot = document.getElementById("vs-figure");
      const vs = vsRoot ? drawVs(vsRoot, data) : null;
      const tellsRoot = document.getElementById("tells");
      if (tellsRoot) drawTells(tellsRoot, data);
      const gameRoot = document.getElementById("game");
      if (gameRoot) window.ForgerGame.init(gameRoot, data, { onFinish: r => vs && vs.setYou(r.score, r.of) });
    })
    .catch(() => {
      for (const id of ["vs-figure", "tells", "game"]) {
        const n = document.getElementById(id);
        if (n) n.replaceChildren(el("p", "note",
          "Could not load game/game_data.json. If you opened this file from disk, serve the folder instead: python -m http.server, then open http://localhost:8000/week5.html"));
      }
    });
})();
