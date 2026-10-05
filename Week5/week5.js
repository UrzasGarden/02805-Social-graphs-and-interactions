/* Week 5 page script: loads game/game_data.json once, draws the main figure, starts the game. */
(function () {
  "use strict";
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function drawFigure(root, fig) {
    root.replaceChildren();
    const tip = el("div", "fig-tooltip");
    document.body.appendChild(tip);
    const pct = v => `${Math.round(v * 100)}%`;
    for (const b of fig.bars) {
      const row = el("div", "fig-row");
      row.appendChild(el("div", "fig-label", b.label));
      const track = el("div", "fig-track");
      const bar = el("div", "fig-bar" + (b.kind === "reference" ? " reference" : "") + (b.value === null ? " pending" : ""));
      bar.tabIndex = 0;
      const valueText = b.value === null ? "to be added after the class test" : pct(b.value);
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label", `${b.label}: ${valueText}`);
      if (b.value !== null) bar.style.width = `${b.value * 100}%`;
      track.appendChild(bar);
      const val = el("span", "fig-value", b.value === null ? "add after the class test" : pct(b.value));
      val.style.left = b.value === null ? "10px" : `calc(${b.value * 100}% + 8px)`;
      if (b.value !== null && b.value > 0.85) { val.style.left = `calc(${b.value * 100}% - 46px)`; val.style.color = "#0b0f18"; }
      track.appendChild(val);
      const show = (x, y) => {
        tip.replaceChildren(el("strong", null, valueText), el("span", null, b.label));
        tip.style.display = "block";
        tip.style.left = `${Math.min(x + 14, window.innerWidth - 300)}px`;
        tip.style.top = `${y + 14}px`;
      };
      bar.addEventListener("pointermove", e => show(e.clientX, e.clientY));
      bar.addEventListener("pointerleave", () => { tip.style.display = "none"; });
      bar.addEventListener("focus", () => { const r = bar.getBoundingClientRect(); show(r.left + 20, r.bottom); });
      bar.addEventListener("blur", () => { tip.style.display = "none"; });
      row.appendChild(track);
      root.appendChild(row);
    }
    const axis = el("div", "fig-axis");
    axis.appendChild(el("div"));
    const ticks = el("div", "fig-ticks");
    for (const t of [0, 0.25, 0.5, 0.75, 1]) { const s = el("span", null, pct(t)); s.style.left = `${t * 100}%`; ticks.appendChild(s); }
    axis.appendChild(ticks);
    root.appendChild(axis);
    // table view
    const det = el("details", "table-view");
    det.appendChild(el("summary", null, "Show as a table"));
    const table = el("table");
    const head = el("tr");
    head.append(el("th", null, "Who picks the forgery"), el("th", null, "Pair accuracy"));
    table.appendChild(head);
    for (const b of fig.bars) {
      const tr = el("tr");
      tr.append(el("td", null, b.label), el("td", "num", b.value === null ? "to be added" : pct(b.value)));
      table.appendChild(tr);
    }
    det.appendChild(table);
    root.appendChild(det);
  }

  fetch("game/game_data.json")
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(data => {
      drawFigure(document.getElementById("main-figure"), data.figure);
      window.ForgerGame.init(document.getElementById("game"), data);
    })
    .catch(() => {
      for (const id of ["main-figure", "game"]) {
        document.getElementById(id).replaceChildren(el("p", "note",
          "Could not load game/game_data.json. If you opened this file directly from disk, serve the folder instead: python -m http.server, then open http://localhost:8000/week5.html"));
      }
    });
})();
