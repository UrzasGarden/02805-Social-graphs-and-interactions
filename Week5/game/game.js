/* Real-or-AI game (Week 5: The Forger).
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
  function pctText(p) { return p < 0.005 ? "<1%" : p > 0.995 ? ">99%" : `${Math.round(p * 100)}%`; }

  function init(root, data, opts) {
    opts = opts || {};
    let round = "1", game = null;

    const controls = el("div", "game-controls");
    const roundBtns = {};
    for (const r of ["1", "2", "3"]) {
      const info = data.rounds[r];
      const b = el("button", "g-btn", info.available ? `Round ${r}` : `Round ${r} · ${info.note}`);
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
      left.append(el("strong", null, `${game.turn + 1} / ${game.pairs.length}`));
      const right = el("span");
      right.append("You ", el("strong", null, String(game.score)), "  ·  Word counter ", el("strong", null, String(game.detector)));
      s.append(left, right);
      return s;
    }

    function showTurn() {
      const pair = game.pairs[game.turn];
      const sides = Math.random() < 0.5 ? ["real", "forged"] : ["forged", "real"];
      const wrap = el("div", "game");
      wrap.appendChild(status());
      const q = el("p", "g-question");
      q.append("Which one is the real Wikipedia article?");
      wrap.appendChild(q);
      const cards = el("div", "g-cards");
      const cardEls = {};
      sides.forEach((kind, i) => {
        const card = el("div", "g-card");
        const head = el("div", "g-card-head");
        head.appendChild(el("span", null, "AB"[i]));
        const tagSlot = el("span");
        head.appendChild(tagSlot);
        const title = el("h4", "g-wtitle", pair.name);
        const text = el("div", "g-text");
        text.appendChild(document.createTextNode(kind === "real" ? pair.real : plain(pair.forged)));
        const btn = el("button", "g-btn g-pick", "This one is real");
        btn.type = "button";
        btn.setAttribute("aria-label", `Excerpt ${"AB"[i]} is the real one`);
        btn.addEventListener("click", () => guess(kind));
        card.append(head, title, text, btn);
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
          c.tagSlot.appendChild(k === "real" ? el("span", "ai-tag real-tag", "Real · Wikipedia") : el("span", "ai-tag", "AI · Claude Fable 5.1"));
        }
        cardEls.forged.text.replaceChildren(forgedText(pair.forged, true));
        wrap.querySelector(".g-status").replaceWith(status());

        const box = el("div", "g-reveal");
        box.appendChild(el("div", "verdict " + (correct ? "ok" : "no"), correct ? "Correct! You caught Claude Fable 5.1." : "Fooled — Claude Fable 5.1 wrote that one."));
        const prob = el("div", "g-prob");
        prob.appendChild(el("span", "g-prob-title", "How suspicious the word counter found each full article:"));
        for (const [label, p, col] of [["Real", pair.p_real_doc, "var(--real)"], ["AI", pair.p_forged_doc, "var(--forged)"]]) {
          const row = el("div", "g-prob-row");
          const track = el("div", "track");
          const fill = el("div", "fill");
          fill.style.width = `${Math.max(1, Math.round(p * 100))}%`;
          fill.style.background = col;
          track.appendChild(fill);
          row.append(el("span", "lbl", label), track, el("span", "num", pctText(p)));
          prob.appendChild(row);
        }
        box.appendChild(prob);
        const foot = el("p", "note");
        foot.append(pair.detector_correct ? "The word counter caught it too. " : "Fable fooled the word counter here as well. ",
          el("mark", null, "Highlighted"), " = word pairs no real Marvel article uses. ");
        const a = el("a", null, "Real article ↗");
        a.href = pair.url; a.target = "_blank"; a.rel = "noopener";
        foot.appendChild(a);
        box.appendChild(foot);
        const next = el("button", "g-btn primary", game.turn + 1 < game.pairs.length ? "Next" : "See results");
        next.type = "button";
        next.addEventListener("click", () => { game.turn++; game.turn < game.pairs.length ? showTurn() : showEnd(); });
        box.appendChild(next);
        reveal.replaceChildren(box);
        next.focus({ preventScroll: true });
      }
    }

    function showEnd() {
      writeBest(round, game.score);
      const best = readBest(round);
      const n = game.pairs.length;
      const end = el("div", "g-end");
      const head = game.score > game.detector ? "You beat the machine!" : game.score === game.detector ? "A draw with the machine." : "The machine wins this time.";
      end.appendChild(el("h3", "g-end-head", head));
      const scores = el("div", "scores");
      for (const [v, cap, cls] of [[game.score, "you", "you"], [game.detector, "word counter", "machine"]]) {
        const s = el("div", "score " + cls);
        s.append(el("div", "big", `${v}/${n}`), el("div", "cap", cap));
        scores.appendChild(s);
      }
      end.appendChild(scores);
      const plural = k => (k === 1 ? "" : "s");
      end.appendChild(el("p", "g-end-line", `Claude Fable 5.1 fooled you ${n - game.score} time${plural(n - game.score)}, and the word counter ${n - game.detector} time${plural(n - game.detector)}.`));
      if (best !== null) end.appendChild(el("p", "note", `Your best: ${best}/${n} (saved in this browser only).`));
      const result = { game: "week5-forger", round: Number(round), score: game.score, of: n, detector: game.detector, picks: game.picks };
      const actions = el("div", "actions");
      const copy = el("button", "g-btn", "Copy my result");
      copy.type = "button";
      const msg = el("div", "g-copied");
      copy.addEventListener("click", async () => {
        const text = JSON.stringify(result);
        try { await navigator.clipboard.writeText(text); msg.textContent = "Copied — paste it to us in Teams."; }
        catch (e) {
          try {
            const ta = el("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
            document.execCommand("copy"); ta.remove(); msg.textContent = "Copied — paste it to us in Teams.";
          } catch (e2) { msg.textContent = text; }
        }
      });
      const again = el("button", "g-btn primary", "Play again");
      again.type = "button";
      again.addEventListener("click", start);
      actions.append(again, copy);
      end.append(actions, msg);
      stage.replaceChildren(end);
      if (typeof opts.onFinish === "function") opts.onFinish({ score: game.score, of: n, detector: game.detector });
    }

    start();
  }

  window.ForgerGame = { init };
})();
