/* Real-or-forged game (Week 5: The Forger).
 * Reads precomputed data only (game/game_data.json); nothing here calls a model.
 * All data is inserted with textContent / createTextNode, never innerHTML. */
(function () {
  "use strict";
  const TURNS = 10;
  const BEST_KEY = "week5-forger-best";

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function readBest(round) {
    try { const v = JSON.parse(localStorage.getItem(BEST_KEY) || "{}"); return v[round] ?? null; } catch (e) { return null; }
  }
  function writeBest(round, score) {
    try {
      const v = JSON.parse(localStorage.getItem(BEST_KEY) || "{}");
      if (v[round] === undefined || score > v[round]) { v[round] = score; localStorage.setItem(BEST_KEY, JSON.stringify(v)); }
    } catch (e) { /* storage blocked: personal best is optional */ }
  }
  function forgedText(segments, highlight) {
    const frag = document.createDocumentFragment();
    for (const [t, unseen] of segments) {
      if (highlight && unseen) frag.appendChild(el("mark", null, t));
      else frag.appendChild(document.createTextNode(t));
    }
    return frag;
  }
  function plain(segments) { return segments.map(s => s[0]).join(""); }

  function init(root, data) {
    let round = "1", game = null;

    const controls = el("div", "game-controls");
    controls.appendChild(el("span", "label", "Forger round:"));
    const roundBtns = {};
    for (const r of ["1", "2", "3"]) {
      const info = data.rounds[r];
      const b = el("button", "g-btn", info.available ? `Round ${r}` : `Round ${r} (${info.note})`);
      b.type = "button";
      b.disabled = !info.available;
      b.addEventListener("click", () => { round = r; start(); });
      roundBtns[r] = b;
      controls.appendChild(b);
    }
    const newBtn = el("button", "g-btn primary", "New game");
    newBtn.type = "button";
    newBtn.addEventListener("click", start);
    controls.appendChild(newBtn);
    const stage = el("div");
    root.replaceChildren(controls, stage);

    function start() {
      for (const r in roundBtns) roundBtns[r].classList.toggle("active", r === round);
      const pool = shuffle(data.rounds[round].pairs.slice()).slice(0, TURNS);
      game = { turn: 0, pairs: pool, picks: [], score: 0, detector: 0 };
      showTurn();
    }

    function status() {
      const s = el("div", "g-status");
      const left = el("span");
      left.append("Turn ", el("strong", null, `${game.turn + 1} of ${game.pairs.length}`));
      const right = el("span");
      right.append("You ", el("strong", null, String(game.score)), " · Detector ", el("strong", null, String(game.detector)));
      s.append(left, right);
      return s;
    }

    function showTurn() {
      const pair = game.pairs[game.turn];
      const realFirst = Math.random() < 0.5;
      const sides = realFirst ? ["real", "forged"] : ["forged", "real"];
      const wrap = el("div", "game");
      wrap.appendChild(status());
      wrap.appendChild(el("p", "g-question", `${pair.name}: which opening is the real Wikipedia article? (The other one was written by an AI.)`));
      const cards = el("div", "g-cards");
      const cardEls = {};
      sides.forEach((kind, i) => {
        const card = el("div", "g-card");
        const head = el("div", "g-card-head");
        head.appendChild(el("span", null, `Excerpt ${"AB"[i]}`));
        const tagSlot = el("span");
        head.appendChild(tagSlot);
        const text = el("div", "g-text");
        text.appendChild(kind === "real" ? document.createTextNode(pair.real) : document.createTextNode(plain(pair.forged)));
        const btn = el("button", "g-btn g-pick", `Excerpt ${"AB"[i]} is the real one`);
        btn.type = "button";
        btn.addEventListener("click", () => guess(kind));
        card.append(head, text, btn);
        cards.appendChild(card);
        cardEls[kind] = { card, text, tagSlot, btn };
      });
      wrap.appendChild(cards);
      const reveal = el("div");
      wrap.appendChild(reveal);
      stage.replaceChildren(wrap);

      function guess(kind) {
        const correct = kind === "real";
        if (correct) game.score++;
        if (pair.detector_correct) game.detector++;
        game.picks.push({ id: pair.id, correct });
        for (const k of ["real", "forged"]) {
          const c = cardEls[k];
          c.btn.remove();
          c.card.classList.add(k === "real" ? "is-real" : "is-forged");
          c.tagSlot.appendChild(k === "real" ? el("span", "ai-tag real-tag", "Real · Wikipedia") : el("span", "ai-tag", "AI-generated forgery"));
        }
        cardEls.forged.text.replaceChildren(forgedText(pair.forged, true));
        wrap.querySelector(".g-status").replaceWith(status());

        const box = el("div", "g-reveal");
        box.appendChild(el("div", "verdict " + (correct ? "ok" : "no"), correct ? "Correct: you found the real article." : "Fooled: that one was the AI forgery."));
        box.appendChild(el("p", null, "What the counting detector said about the two full documents (probability that the document is forged):"));
        const prob = el("div", "g-prob");
        for (const [label, p, col] of [["Real article", pair.p_real_doc, "var(--real)"], ["AI forgery", pair.p_forged_doc, "var(--forged)"]]) {
          const track = el("div", "track");
          const fill = el("div", "fill");
          fill.style.width = `${Math.round(p * 100)}%`;
          fill.style.background = col;
          track.appendChild(fill);
          prob.append(el("span", null, label), track, el("span", "num", p < 0.005 ? "<1%" : p > 0.995 ? ">99%" : `${Math.round(p * 100)}%`));
        }
        box.appendChild(prob);
        box.appendChild(el("p", null, pair.detector_correct
          ? "The detector rated the forgery as more likely forged, so it got this pair right."
          : "The detector rated the real article as more likely forged, so it got this pair wrong."));
        const hl = el("p", "note");
        hl.append("Highlighted in the forgery: ", el("mark", null, "word pairs"),
          " that never occur in any other real Marvel article in our corpus (the character's own page is left out, so names can light up too).");
        box.appendChild(hl);
        const link = el("p", "note");
        const a = el("a", null, `Read the real "${pair.name}" article on Wikipedia`);
        a.href = pair.url; a.target = "_blank"; a.rel = "noopener";
        link.append(a, " (CC BY-SA 4.0).");
        box.appendChild(link);
        const next = el("button", "g-btn primary", game.turn + 1 < game.pairs.length ? "Next pair" : "See results");
        next.type = "button";
        next.style.marginTop = "10px";
        next.addEventListener("click", () => { game.turn++; game.turn < game.pairs.length ? showTurn() : showEnd(); });
        box.appendChild(next);
        reveal.replaceChildren(box);
        next.focus();
      }
    }

    function showEnd() {
      writeBest(round, game.score);
      const best = readBest(round);
      const end = el("div", "g-end panel");
      end.appendChild(el("h3", null, `Round ${round} results`));
      const scores = el("div", "scores");
      for (const [n, cap] of [[game.score, "you"], [game.detector, "the counting detector"]]) {
        const s = el("div");
        s.append(el("div", "big", `${n}/${game.pairs.length}`), el("div", "cap", cap));
        scores.appendChild(s);
      }
      end.appendChild(scores);
      end.appendChild(el("p", "note", "Same 10 pairs for both. " + (best !== null ? `Your personal best on this round: ${best}/${game.pairs.length} (stored only in this browser).` : "")));
      const result = { game: "week5-forger", round: Number(round), score: game.score, of: game.pairs.length,
                       detector: game.detector, picks: game.picks };
      const actions = el("div", "actions");
      const copy = el("button", "g-btn", "Copy results for Teams");
      copy.type = "button";
      const msg = el("div", "g-copied");
      copy.addEventListener("click", async () => {
        const text = JSON.stringify(result);
        try { await navigator.clipboard.writeText(text); msg.textContent = "Copied. Paste it to us in Teams."; }
        catch (e) {
          try {
            const ta = el("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
            document.execCommand("copy"); ta.remove(); msg.textContent = "Copied. Paste it to us in Teams.";
          } catch (e2) { msg.textContent = text; }
        }
      });
      const again = el("button", "g-btn primary", "Play again");
      again.type = "button";
      again.addEventListener("click", start);
      actions.append(copy, again);
      end.append(actions, msg);
      stage.replaceChildren(end);
    }

    start();
  }

  window.ForgerGame = { init };
})();
