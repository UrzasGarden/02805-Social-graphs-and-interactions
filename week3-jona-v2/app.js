/* ═══════════════════════════════════════════════════════════════════
   Graphle — app.js  (v10 — Advanced Tooltips)
   Vanilla JS · zero dependencies
   ═══════════════════════════════════════════════════════════════════ */

"use strict";

// ── Constants ────────────────────────────────────────────────────
const MAX_GUESSES = 6;
const COLS = 5;

// ── Graph Data ───────────────────────────────────────────────────
const GRAPH = {
  nodes: [],
  edges: [],
  adj: {},
  nameToId: {},
  idToNode: {},
  idToIdx: {},     
};

// ── Game State ───────────────────────────────────────────────────
let target = null;
let guesses = [];
let gameOver = false;
let possibleCandidates = new Set();
let candidatePaths = [];

// ── Visualization State ──────────────────────────────────────────
let positions = [];
let revealedPaths = [];
let guessedSet = new Set();
let winRevealed = false;
let animFrame = null;
let transform = { x: 0, y: 0, k: 1 };
let hoveredNodeId = null;
let lastHoveredNodeId = null;
let isDragging = false;
let dragDist = 0;
let lastMouse = { x: 0, y: 0 };
let currentMouse = { x: 0, y: 0 };

// ── DOM refs ─────────────────────────────────────────────────────
const canvas         = document.getElementById("graph-canvas");
const ctx            = canvas.getContext("2d");
const graphLoading   = document.getElementById("graph-loading");

const board          = document.getElementById("board");
const searchInput    = document.getElementById("search-input");
const autocompleteUl = document.getElementById("autocomplete-list");
const btnGuess       = document.getElementById("btn-guess");
const btnNewGame     = document.getElementById("btn-new-game");
const guessNum       = document.getElementById("guess-num");
const nodeCount      = document.getElementById("node-count");
const toastContainer = document.getElementById("toast-container");
const hoverTooltip   = document.getElementById("hover-tooltip");

const helpOverlay    = document.getElementById("help-overlay");
const btnHelp        = document.getElementById("btn-help");
const helpClose      = document.getElementById("help-close");

const resultOverlay  = document.getElementById("result-overlay");
const resultEmoji    = document.getElementById("result-emoji");
const resultTitle    = document.getElementById("result-title");
const resultBody     = document.getElementById("result-body");
const resultStats    = document.getElementById("result-stats");
const resultBtn      = document.getElementById("result-btn");

// ── Boot ─────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", loadGraphData);

async function loadGraphData() {
  try {
    const res = await fetch("graph_data.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    initGraph(data);
    setTimeout(() => {
      computeForceLayout();
      graphLoading.classList.add("done");
      startNewGame();
    }, 50);
  } catch (err) {
    alert("⚠️  Could not load graph_data.json.\nRun data_builder.py first.\n\n" + err.message);
  }
}

// ── Graph init ───────────────────────────────────────────────────
function initGraph(data) {
  GRAPH.nodes = data.nodes;
  GRAPH.edges = data.edges;
  GRAPH.adj = {};
  GRAPH.nameToId = {};
  GRAPH.idToNode = {};
  GRAPH.idToIdx = {};

  for (let i = 0; i < GRAPH.nodes.length; i++) {
    const n = GRAPH.nodes[i];
    GRAPH.adj[n.id] = new Set();
    GRAPH.nameToId[n.name.toLowerCase()] = n.id;
    GRAPH.idToNode[n.id] = n;
    GRAPH.idToIdx[n.id] = i;
  }
  for (const e of GRAPH.edges) {
    GRAPH.adj[e.source].add(e.target);
    GRAPH.adj[e.target].add(e.source);
  }
}

// ═════════════════════════════════════════════════════════════════
//  FORCE-DIRECTED LAYOUT
// ═════════════════════════════════════════════════════════════════

function computeForceLayout() {
  const N = GRAPH.nodes.length;
  const W = 680, H = 380;
  const area = W * H;
  const k = Math.sqrt(area / N) * 0.85;
  const kRep = k * k * 1.2;
  const kAtt = 0.006;
  const gravity = 0.03;
  const iterations = 350;

  const rng = mulberry32(42);
  positions = GRAPH.nodes.map(() => ({
    x: W / 2 + (rng() - 0.5) * W * 0.6,
    y: H / 2 + (rng() - 0.5) * H * 0.6,
    vx: 0, vy: 0,
  }));

  for (let iter = 0; iter < iterations; iter++) {
    const temp = Math.max(0.01, 1 - iter / iterations);
    const maxDisp = k * temp * 2;

    for (let i = 0; i < N; i++) {
      let fx = 0, fy = 0;
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        let dx = positions[i].x - positions[j].x;
        let dy = positions[i].y - positions[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) d2 = 1;
        const force = kRep / d2;
        const d = Math.sqrt(d2);
        fx += (dx / d) * force;
        fy += (dy / d) * force;
      }
      fx += (W / 2 - positions[i].x) * gravity;
      fy += (H / 2 - positions[i].y) * gravity;
      positions[i].vx = (positions[i].vx + fx) * 0.85 * temp;
      positions[i].vy = (positions[i].vy + fy) * 0.85 * temp;
    }

    for (const e of GRAPH.edges) {
      const si = GRAPH.idToIdx[e.source];
      const ti = GRAPH.idToIdx[e.target];
      let dx = positions[ti].x - positions[si].x;
      let dy = positions[ti].y - positions[si].y;
      let d = Math.sqrt(dx * dx + dy * dy) || 1;
      let force = kAtt * (d - k);
      positions[si].vx += (dx / d) * force;
      positions[si].vy += (dy / d) * force;
      positions[ti].vx -= (dx / d) * force;
      positions[ti].vy -= (dy / d) * force;
    }

    for (let i = 0; i < N; i++) {
      let d = Math.sqrt(positions[i].vx ** 2 + positions[i].vy ** 2) || 1;
      let scale = Math.min(d, maxDisp) / d;
      positions[i].x += positions[i].vx * scale;
      positions[i].y += positions[i].vy * scale;
      positions[i].x = Math.max(30, Math.min(W - 30, positions[i].x));
      positions[i].y = Math.max(30, Math.min(H - 30, positions[i].y));
    }
  }
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ═════════════════════════════════════════════════════════════════
//  CANVAS INTERACTION (Pan, Zoom, Hover, Click)
// ═════════════════════════════════════════════════════════════════

const W_BASE = 680;
const H_BASE = 380;

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const zoomSensitivity = 0.002;
  const zoomFactor = Math.exp(-e.deltaY * zoomSensitivity);

  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  let newK = transform.k * zoomFactor;
  newK = Math.max(0.3, Math.min(newK, 15));

  const actualFactor = newK / transform.k;
  transform.x = mouseX - (mouseX - transform.x) * actualFactor;
  transform.y = mouseY - (mouseY - transform.y) * actualFactor;
  transform.k = newK;
}, { passive: false });

canvas.addEventListener("pointerdown", (e) => {
  isDragging = true;
  dragDist = 0;
  lastMouse = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  if (isDragging) {
    const dx = e.clientX - lastMouse.x;
    const dy = e.clientY - lastMouse.y;
    dragDist += Math.abs(dx) + Math.abs(dy);
    transform.x += dx;
    transform.y += dy;
    lastMouse = { x: e.clientX, y: e.clientY };
  } else {
    const rect = canvas.getBoundingClientRect();
    currentMouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
});

canvas.addEventListener("pointerup", (e) => {
  isDragging = false;
  canvas.releasePointerCapture(e.pointerId);
  
  if (dragDist < 5 && !gameOver) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let clickedId = null;
    let minDistSq = 200; 

    for (const node of GRAPH.nodes) {
      if (guesses.length > 0 && !possibleCandidates.has(node.id)) continue;
      
      const idx = GRAPH.idToIdx[node.id];
      const nx = W_BASE ? (positions[idx].x * (rect.width / W_BASE) * transform.k + transform.x) : positions[idx].x;
      const ny = H_BASE ? (positions[idx].y * (rect.height / H_BASE) * transform.k + transform.y) : positions[idx].y;
      
      const dx = mx - nx;
      const dy = my - ny;
      const distSq = dx * dx + dy * dy;
      
      if (distSq < minDistSq) {
        minDistSq = distSq;
        clickedId = node.id;
      }
    }

    if (clickedId) {
      const name = GRAPH.idToNode[clickedId].name;
      searchInput.value = name;
      btnGuess.disabled = false;
      submitGuess();
      autocompleteUl.innerHTML = "";
      autocompleteUl.classList.add("hidden");
    }
  }
});

canvas.addEventListener("dblclick", () => {
  transform = { x: 0, y: 0, k: 1 };
});

// ═════════════════════════════════════════════════════════════════
//  CANVAS RENDERING
// ═════════════════════════════════════════════════════════════════

function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return rect;
}

function startRenderLoop() {
  if (animFrame) cancelAnimationFrame(animFrame);
  function loop(time) {
    renderGraph(time);
    animFrame = requestAnimationFrame(loop);
  }
  animFrame = requestAnimationFrame(loop);
}

function renderGraph(time) {
  const rect = setupCanvas();
  const W = rect.width;
  const H = rect.height;
  const scaleX = W / W_BASE;
  const scaleY = H / H_BASE;

  const tx = (x) => x * scaleX * transform.k + transform.x;
  const ty = (y) => y * scaleY * transform.k + transform.y;

  ctx.clearRect(0, 0, W, H);

  // Hover detection logic
  let foundHover = null;
  let minDistSq = 144; 
  
  if (!isDragging && !gameOver) {
    for (const node of GRAPH.nodes) {
      if (guesses.length > 0 && !possibleCandidates.has(node.id)) continue;
      
      const idx = GRAPH.idToIdx[node.id];
      const nx = tx(positions[idx].x);
      const ny = ty(positions[idx].y);
      const dx = currentMouse.x - nx;
      const dy = currentMouse.y - ny;
      const distSq = dx * dx + dy * dy;
      
      if (distSq < minDistSq) {
        minDistSq = distSq;
        foundHover = node.id;
      }
    }
  }

  if (foundHover !== hoveredNodeId) {
    hoveredNodeId = foundHover;
    canvas.style.cursor = hoveredNodeId ? "pointer" : (isDragging ? "grabbing" : "grab");
  }

  // Pre-compute sets for Paths (ONLY REVEALED WHEN GAME IS OVER!)
  const pathNodeSet = new Set();
  const pathEdgeSet = new Set();
  if (gameOver) {
    for (const p of revealedPaths) {
      for (let i = 0; i < p.path.length; i++) {
        pathNodeSet.add(p.path[i]);
        if (i < p.path.length - 1) {
          const a = Math.min(p.path[i], p.path[i + 1]);
          const b = Math.max(p.path[i], p.path[i + 1]);
          pathEdgeSet.add(`${a}-${b}`);
        }
      }
    }
  }

  // ── Layer 1: All edges ──
  const edgeAlpha = guesses.length > 0 ? "0.015" : "0.035";
  ctx.strokeStyle = `rgba(255,255,255,${edgeAlpha})`;
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (const e of GRAPH.edges) {
    const si = GRAPH.idToIdx[e.source];
    const ti = GRAPH.idToIdx[e.target];
    const a = Math.min(e.source, e.target);
    const b = Math.max(e.source, e.target);
    if (gameOver && pathEdgeSet.has(`${a}-${b}`)) continue;
    ctx.moveTo(tx(positions[si].x), ty(positions[si].y));
    ctx.lineTo(tx(positions[ti].x), ty(positions[ti].y));
  }
  ctx.stroke();

  // ── Layer 1.5: Paths to valid candidates (Hypotheses) ──
  if (!gameOver && candidatePaths.length > 0) {
    ctx.save();
    const pulseAlpha = 0.2 + Math.sin((time || 0) / 200) * 0.1;
    ctx.strokeStyle = `rgba(124, 77, 255, ${pulseAlpha})`; // Purple
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]); // Dashed radar look
    ctx.beginPath();
    for (const path of candidatePaths) {
      for (let i = 0; i < path.length - 1; i++) {
        const si = GRAPH.idToIdx[path[i]];
        const ti = GRAPH.idToIdx[path[i + 1]];
        ctx.moveTo(tx(positions[si].x), ty(positions[si].y));
        ctx.lineTo(tx(positions[ti].x), ty(positions[ti].y));
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  // ── Layer 2: Path edges (glowing) — ONLY SHOWN ON GAME OVER ──
  if (gameOver) {
    for (const p of revealedPaths) {
      const dist = p.dist;
      const color = dist <= 1 ? "rgba(83,141,78," : dist === 2 ? "rgba(230,126,34," : "rgba(192,57,43,";
      for (let i = 0; i < p.path.length - 1; i++) {
        const si = GRAPH.idToIdx[p.path[i]];
        const ti = GRAPH.idToIdx[p.path[i + 1]];
        ctx.save();
        ctx.strokeStyle = color + "0.3)";
        ctx.lineWidth = 6;
        ctx.shadowColor = color + "0.6)";
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.moveTo(tx(positions[si].x), ty(positions[si].y));
        ctx.lineTo(tx(positions[ti].x), ty(positions[ti].y));
        ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = color + "0.8)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(tx(positions[si].x), ty(positions[si].y));
        ctx.lineTo(tx(positions[ti].x), ty(positions[ti].y));
        ctx.stroke();
      }
    }
  }

  // ── Layer 3: All nodes (Sized by Degree) ──
  const N = GRAPH.nodes.length;
  for (let i = 0; i < N; i++) {
    const id = GRAPH.nodes[i].id;
    if (guessedSet.has(id)) continue; 

    const node = GRAPH.nodes[i];
    const x = tx(positions[i].x);
    const y = ty(positions[i].y);

    const baseRadius = 1.5 + (node.degree * 25);
    let radius = baseRadius;
    let color = "rgba(255,255,255,0.08)";

    if (guesses.length > 0) {
      if (!possibleCandidates.has(id)) {
        color = "rgba(255,255,255,0.02)";
      } else {
        radius = baseRadius + 1.5;
        color = "rgba(124, 77, 255, 0.7)"; 
      }
    } 
    
    if (winRevealed && GRAPH.adj[target.id].has(id)) {
      radius = baseRadius + 2.5;
      color = "rgba(83,141,78,0.6)";
    } else if (gameOver && pathNodeSet.has(id)) {
      radius = baseRadius + 1.5;
      color = "rgba(255,255,255,0.35)";
    }

    if (hoveredNodeId === id) {
      radius = baseRadius + 3.5;
      color = "#fff";
    }

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Layer 4: Guessed nodes ──
  for (let g = 0; g < guesses.length; g++) {
    const id = guesses[g];
    const idx = GRAPH.idToIdx[id];
    const node = GRAPH.nodes[idx];
    const x = tx(positions[idx].x);
    const y = ty(positions[idx].y);
    const dist = revealedPaths[g] ? revealedPaths[g].dist : 99;

    const baseRadius = 1.5 + (node.degree * 25);

    const col = dist === 0 ? [83, 141, 78]
              : dist === 1 ? [181, 159, 59]
              : dist === 2 ? [230, 126, 34]
              : [192, 57, 43];

    ctx.save();
    ctx.shadowColor = `rgba(${col[0]},${col[1]},${col[2]},0.8)`;
    ctx.shadowBlur = 14;
    ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.9)`;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(6, baseRadius + 2), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ── Layer 4.5: Node Text Labels (Context) ──
  const labelsToDraw = new Set([...guessedSet]);
  if (gameOver) {
    for (const id of pathNodeSet) labelsToDraw.add(id);
  }

  for (const id of labelsToDraw) {
    const idx = GRAPH.idToIdx[id];
    const node = GRAPH.nodes[idx];
    const x = tx(positions[idx].x);
    const y = ty(positions[idx].y);

    let textColor = "rgba(255,255,255,0.4)";
    let font = "500 8px Inter, system-ui, sans-serif";
    
    const baseRadius = 1.5 + (node.degree * 25);
    let yOffset = -(baseRadius + 6);

    if (guessedSet.has(id)) {
      textColor = "#fff";
      font = "600 9px Inter, system-ui, sans-serif";
      yOffset = -(baseRadius + 8);
    } else if (gameOver && pathNodeSet.has(id)) {
      textColor = "rgba(255,255,255,0.9)";
      font = "500 8.5px Inter, system-ui, sans-serif";
    }

    if (transform.k < 0.6 && !guessedSet.has(id)) continue;

    ctx.fillStyle = textColor;
    ctx.font = font;
    ctx.textAlign = "center";
    const dispName = GRAPH.idToNode[id].name.split("(")[0].trim();
    ctx.fillText(dispName, x, y + yOffset);
  }

  // ── Layer 4.8: DOM Hover Tooltip ──
  if (hoveredNodeId !== lastHoveredNodeId) {
    lastHoveredNodeId = hoveredNodeId;
    if (hoveredNodeId) {
      const node = GRAPH.idToNode[hoveredNodeId];
      const name = node.name.split("(")[0].trim();
      hoverTooltip.innerHTML = `
        <div class="tt-name">${name}</div>
        <div class="tt-stat"><span>Degree</span><span class="tt-val">${node.degree.toFixed(4)}</span></div>
        <div class="tt-stat"><span>Between</span><span class="tt-val">${node.betweenness.toFixed(4)}</span></div>
        <div class="tt-stat"><span>Close</span><span class="tt-val">${node.closeness.toFixed(4)}</span></div>
      `;
      hoverTooltip.classList.remove("hidden");
    } else {
      hoverTooltip.classList.add("hidden");
    }
  }

  if (hoveredNodeId) {
    const idx = GRAPH.idToIdx[hoveredNodeId];
    const node = GRAPH.nodes[idx];
    const hx = tx(positions[idx].x);
    const hy = ty(positions[idx].y);
    const baseRadius = 1.5 + (node.degree * 25);
    hoverTooltip.style.left = (rect.left + hx) + "px";
    hoverTooltip.style.top = (rect.top + hy - baseRadius - 8) + "px";
  }

  // ── Layer 5: Win Reveal ──
  if (target && winRevealed) {
    const idx = GRAPH.idToIdx[target.id];
    const node = GRAPH.nodes[idx];
    const x = tx(positions[idx].x);
    const y = ty(positions[idx].y);

    const baseRadius = 1.5 + (node.degree * 25);
    const pulse = (baseRadius + 5) + Math.sin((time || 0) / 200) * 3;
    ctx.save();
    ctx.shadowColor = "rgba(83,141,78,0.9)";
    ctx.shadowBlur = 25;
    ctx.fillStyle = "rgba(83,141,78,1)";
    ctx.beginPath();
    ctx.arc(x, y, pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    
    ctx.fillStyle = "#fff";
    ctx.font = "700 12px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    const dispName = target.name.split("(")[0].trim();
    ctx.fillText(dispName, x, y - (baseRadius + 12));
  }
}

// ═════════════════════════════════════════════════════════════════
//  GAME LIFECYCLE
// ═════════════════════════════════════════════════════════════════

function startNewGame() {
  const sortedByDegree = [...GRAPH.nodes].sort((a, b) => b.degree - a.degree);
  
  let targetPool;
  if (Math.random() < 0.6) {
    targetPool = sortedByDegree.slice(0, 100);
  } else {
    targetPool = sortedByDegree;
  }
  
  target = targetPool[Math.floor(Math.random() * targetPool.length)];
  
  guesses = [];
  gameOver = false;
  guessedSet = new Set();
  revealedPaths = [];
  candidatePaths = [];
  winRevealed = false;
  transform = { x: 0, y: 0, k: 1 }; 
  hoveredNodeId = null;
  lastHoveredNodeId = null;
  hoverTooltip.classList.add("hidden");

  possibleCandidates = new Set(GRAPH.nodes.map(n => n.id));
  updateCandidateCount();
  toastContainer.innerHTML = ""; // Clear toasts

  searchInput.value = "";
  searchInput.disabled = false;
  btnGuess.disabled = true;
  hideOverlay(resultOverlay);
  hideOverlay(helpOverlay);
  updateGuessLabel();
  renderEmptyBoard();
  startRenderLoop();
}

btnNewGame.addEventListener("click", startNewGame);
resultBtn.addEventListener("click", startNewGame);

function updateCandidateCount() {
  if (guesses.length === 0) {
    nodeCount.textContent = `${GRAPH.nodes.length} characters`;
  } else {
    nodeCount.innerHTML = `<span style="color:var(--accent);font-weight:700;">${possibleCandidates.size} possibilities left</span>`;
  }
}

function renderEmptyBoard() {
  board.innerHTML = "";
  for (let r = 0; r < MAX_GUESSES; r++) {
    const row = document.createElement("div");
    row.className = "tile-row";
    row.dataset.row = r;
    for (let c = 0; c < COLS; c++) {
      const tile = document.createElement("div");
      tile.className = "tile";
      row.appendChild(tile);
    }
    board.appendChild(row);
  }
}

function showToast(htmlMessage) {
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = htmlMessage;
  toastContainer.appendChild(t);
  
  setTimeout(() => {
    t.classList.add("fade-out");
    t.addEventListener("animationend", () => {
      t.remove();
    });
  }, 4500);
}

// ═════════════════════════════════════════════════════════════════
//  AUTOCOMPLETE
// ═════════════════════════════════════════════════════════════════

let selectedIdx = -1;

searchInput.addEventListener("focus", () => {
  if (!searchInput.value.trim() && GRAPH.nodes.length > 0) {
    showHint();
  }
});

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim().toLowerCase();
  selectedIdx = -1;

  if (!q) {
    showHint();
    btnGuess.disabled = true;
    return;
  }

  const matches = GRAPH.nodes
    .filter(n => n.name.toLowerCase().includes(q) && !guesses.includes(n.id))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts || a.name.localeCompare(b.name);
    })
    .slice(0, 10);

  if (!matches.length) {
    showNoMatches(q);
    btnGuess.disabled = true;
    return;
  }

  renderAutocomplete(matches, q);
});

searchInput.addEventListener("keydown", (e) => {
  const items = autocompleteUl.querySelectorAll("li:not(.ac-hint):not(.ac-no-match)");

  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
    highlightItem(items);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIdx = Math.max(selectedIdx - 1, 0);
    highlightItem(items);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (selectedIdx >= 0 && selectedIdx < items.length) {
      items[selectedIdx].click();
    } else {
      submitGuess();
    }
  } else if (e.key === "Escape") {
    hideAutocomplete();
  }
});

function renderAutocomplete(matches, query) {
  autocompleteUl.innerHTML = "";
  matches.forEach((node) => {
    const li = document.createElement("li");
    const idx = node.name.toLowerCase().indexOf(query);
    
    if (guesses.length > 0 && possibleCandidates.has(node.id)) {
      li.style.borderLeft = "4px solid var(--accent)";
      li.style.paddingLeft = "12px";
    }

    if (idx >= 0) {
      li.innerHTML =
        escapeHtml(node.name.substring(0, idx)) +
        "<mark>" + escapeHtml(node.name.substring(idx, idx + query.length)) + "</mark>" +
        escapeHtml(node.name.substring(idx + query.length));
    } else {
      li.textContent = node.name;
    }
    li.addEventListener("click", () => {
      searchInput.value = node.name;
      hideAutocomplete();
      btnGuess.disabled = false;
      searchInput.focus();
    });
    autocompleteUl.appendChild(li);
  });
  autocompleteUl.classList.remove("hidden");
}

function showNoMatches(query) {
  autocompleteUl.innerHTML = "";
  const li = document.createElement("li");
  li.className = "ac-no-match";

  const available = GRAPH.nodes.filter(n => !guesses.includes(n.id) && possibleCandidates.has(n.id));
  const suggestions = shuffle(available).slice(0, 3).map(n => n.name);

  li.innerHTML = `<span class="no-match-text">No match for "<strong>${escapeHtml(query)}</strong>"</span>
    <span class="no-match-try">Try: ${suggestions.map(s => `<a class="suggestion">${escapeHtml(s)}</a>`).join(", ")}</span>`;

  autocompleteUl.appendChild(li);

  li.querySelectorAll(".suggestion").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      searchInput.value = el.textContent;
      hideAutocomplete();
      btnGuess.disabled = false;
      searchInput.focus();
    });
  });

  autocompleteUl.classList.remove("hidden");
}

function showHint() {
  autocompleteUl.innerHTML = "";
  const available = GRAPH.nodes.filter(n => !guesses.includes(n.id) && possibleCandidates.has(n.id));
  const examples = shuffle(available).slice(0, 5);

  const hintLi = document.createElement("li");
  hintLi.className = "ac-hint";
  hintLi.innerHTML = `<span class="hint-label">🔍 ${available.length} possibilities — try one:</span>`;
  autocompleteUl.appendChild(hintLi);

  examples.forEach(node => {
    const li = document.createElement("li");
    li.textContent = node.name;
    li.addEventListener("click", () => {
      searchInput.value = node.name;
      hideAutocomplete();
      btnGuess.disabled = false;
      searchInput.focus();
    });
    autocompleteUl.appendChild(li);
  });

  autocompleteUl.classList.remove("hidden");
}

function highlightItem(items) {
  items.forEach((el, i) => el.classList.toggle("active", i === selectedIdx));
}

function hideAutocomplete() {
  autocompleteUl.innerHTML = "";
  autocompleteUl.classList.add("hidden");
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrapper")) hideAutocomplete();
});

// ═════════════════════════════════════════════════════════════════
//  GUESS SUBMISSION & VISUAL ELIMINATION
// ═════════════════════════════════════════════════════════════════

btnGuess.addEventListener("click", submitGuess);

function submitGuess() {
  if (gameOver) return;

  const name = searchInput.value.trim();
  const id = GRAPH.nameToId[name.toLowerCase()];

  if (id === undefined || guesses.includes(id)) {
    shakeInput();
    return;
  }

  guesses.push(id);
  guessedSet.add(id);
  const guessNode = GRAPH.idToNode[id];

  const distMap = bfsAllDistances(id);
  const dist = distMap.has(target.id) ? distMap.get(target.id) : Infinity;
  
  const prevCount = possibleCandidates.size;

  // ELIMINATION: Filter candidates by ALL centrality metrics and distance
  const nextCandidates = new Set();
  const EPSILON = 1e-9;
  
  for (const cid of possibleCandidates) {
    const cNode = GRAPH.idToNode[cid];
    
    // 1. Distance filter
    const d = distMap.has(cid) ? distMap.get(cid) : Infinity;
    if (d !== dist) continue;

    // 2. Degree filter
    if (target.degree > guessNode.degree + EPSILON && cNode.degree <= guessNode.degree) continue;
    if (target.degree < guessNode.degree - EPSILON && cNode.degree >= guessNode.degree) continue;

    // 3. Betweenness filter
    if (target.betweenness > guessNode.betweenness + EPSILON && cNode.betweenness <= guessNode.betweenness) continue;
    if (target.betweenness < guessNode.betweenness - EPSILON && cNode.betweenness >= guessNode.betweenness) continue;

    // 4. Closeness filter
    if (target.closeness > guessNode.closeness + EPSILON && cNode.closeness <= guessNode.closeness) continue;
    if (target.closeness < guessNode.closeness - EPSILON && cNode.closeness >= guessNode.closeness) continue;

    nextCandidates.add(cid);
  }
  possibleCandidates = nextCandidates;
  const eliminated = prevCount - possibleCandidates.size;
  updateCandidateCount();

  // Create Toast Message
  if (dist > 0) {
    let traits = [];
    if (target.degree > guessNode.degree + EPSILON) traits.push("Higher Degree");
    else if (target.degree < guessNode.degree - EPSILON) traits.push("Lower Degree");

    if (target.betweenness > guessNode.betweenness + EPSILON) traits.push("Higher Betweenness");
    else if (target.betweenness < guessNode.betweenness - EPSILON) traits.push("Lower Betweenness");
    
    if (target.closeness > guessNode.closeness + EPSILON) traits.push("Higher Closeness");
    else if (target.closeness < guessNode.closeness - EPSILON) traits.push("Lower Closeness");

    let msg = `Eliminated ${eliminated} nodes!`;
    if (traits.length > 0) {
      msg += `<br><span style="color:var(--accent);font-size:12px;">Target has ${traits.join(", ")}</span>`;
    }
    showToast(msg);
  }

  // Draw paths to candidates if reasonable (prevents spaghetti chaos)
  candidatePaths = [];
  if (dist > 0 && possibleCandidates.size <= 40) {
    for (const cid of possibleCandidates) {
      candidatePaths.push(extractPath(distMap, id, cid));
    }
  }

  const pathResult = extractPath(distMap, id, target.id);
  revealedPaths.push({ path: pathResult, dist: dist });

  fillRow(guesses.length - 1, guessNode, dist);

  searchInput.value = "";
  btnGuess.disabled = true;
  hideAutocomplete();
  updateGuessLabel();

  if (dist === 0) {
    endGame(true);
    return;
  }
  if (guesses.length >= MAX_GUESSES) {
    endGame(false);
  }
}

function shakeInput() {
  searchInput.classList.add("shake");
  setTimeout(() => searchInput.classList.remove("shake"), 400);
}

// ═════════════════════════════════════════════════════════════════
//  TILE BOARD (clue rows)
// ═════════════════════════════════════════════════════════════════

function fillRow(rowIdx, guessNode, dist) {
  const row = board.querySelector(`.tile-row[data-row="${rowIdx}"]`);
  const tiles = row.querySelectorAll(".tile");

  const isWin = dist === 0;
  const distClass = dist === 0 ? "dist-0"
                  : dist === 1 ? "dist-1"
                  : dist === 2 ? "dist-2"
                  : "dist-3";

  const degArrow = arrowFor(guessNode.degree, target.degree);
  const betArrow = arrowFor(guessNode.betweenness, target.betweenness);
  const cloArrow = arrowFor(guessNode.closeness, target.closeness);

  const degClass = degArrow === "✅" ? "match" : "neutral";
  const betClass = betArrow === "✅" ? "match" : "neutral";
  const cloClass = cloArrow === "✅" ? "match" : "neutral";

  const tileData = [
    { label: "",          value: guessNode.name.split("(")[0].trim(), cls: `${distClass} name-tile` },
    { label: "DISTANCE",  value: isWin ? "🎯" : `${dist}`,  cls: distClass },
    { label: "DEGREE",    value: guessNode.degree.toFixed(4), cls: degClass, arrow: degArrow },
    { label: "BETWEEN.",  value: guessNode.betweenness.toFixed(4), cls: betClass, arrow: betArrow },
    { label: "CLOSENESS", value: guessNode.closeness.toFixed(4), cls: cloClass, arrow: cloArrow },
  ];

  tileData.forEach((d, i) => {
    const tile = tiles[i];
    const delay = i * 150;

    setTimeout(() => {
      tile.innerHTML = "";
      if (d.label) {
        const lbl = document.createElement("span");
        lbl.className = "tile-label";
        lbl.textContent = d.label;
        tile.appendChild(lbl);
      }
      const val = document.createElement("span");
      val.className = "tile-value";
      val.textContent = d.value;
      tile.appendChild(val);

      if (d.arrow) {
        const arr = document.createElement("span");
        arr.className = "tile-arrow";
        arr.textContent = d.arrow;
        tile.appendChild(arr);
      }

      tile.className = `tile filled revealed ${d.cls}`;
    }, delay);
  });

  if (isWin) {
    setTimeout(() => row.classList.add("win"), tileData.length * 150 + 400);
  }
}

function arrowFor(guessVal, targetVal) {
  if (Math.abs(guessVal - targetVal) < 1e-9) return "✅";
  return targetVal > guessVal ? "⬆️" : "⬇️";
}

function updateGuessLabel() {
  guessNum.textContent = Math.min(guesses.length + 1, MAX_GUESSES);
}

// ═════════════════════════════════════════════════════════════════
//  BFS ALGORITHMS
// ═════════════════════════════════════════════════════════════════

function bfsAllDistances(startId) {
  const dists = new Map();
  dists.set(startId, 0);
  
  let frontier = [startId];
  let currentDist = 0;

  while (frontier.length > 0) {
    currentDist++;
    const nextFrontier = [];
    for (const u of frontier) {
      for (const v of GRAPH.adj[u]) {
        if (!dists.has(v)) {
          dists.set(v, currentDist);
          nextFrontier.push(v);
        }
      }
    }
    frontier = nextFrontier;
  }
  return dists;
}

function extractPath(distMap, startId, goalId) {
  if (startId === goalId) return [startId];
  if (!distMap.has(goalId)) return [];

  const path = [goalId];
  let curr = goalId;
  let d = distMap.get(goalId);

  while (d > 0) {
    for (const nb of GRAPH.adj[curr]) {
      if (distMap.get(nb) === d - 1) {
        path.push(nb);
        curr = nb;
        d--;
        break;
      }
    }
  }
  return path.reverse();
}

// ═════════════════════════════════════════════════════════════════
//  END GAME
// ═════════════════════════════════════════════════════════════════

function endGame(won) {
  gameOver = true;
  searchInput.disabled = true;
  btnGuess.disabled = true;
  hoverTooltip.classList.add("hidden");

  if (won) {
    setTimeout(() => { winRevealed = true; }, COLS * 150 + 200);
  }

  const delay = won ? COLS * 150 + 1200 : 800;

  setTimeout(() => {
    if (won) {
      resultEmoji.textContent = "🎉";
      resultTitle.textContent = "Brilliant!";
      resultBody.innerHTML = `The mystery character was <strong>${target.name}</strong>`;
    } else {
      winRevealed = true;
      resultEmoji.textContent = "😬";
      resultTitle.textContent = "Better luck next time";
      resultBody.innerHTML = `The mystery character was <strong>${target.name}</strong>`;
    }
    resultStats.innerHTML = `
      <div class="stat-box"><div class="stat-val">${target.degree.toFixed(3)}</div><div class="stat-label">Degree</div></div>
      <div class="stat-box"><div class="stat-val">${target.betweenness.toFixed(3)}</div><div class="stat-label">Betweenness</div></div>
      <div class="stat-box"><div class="stat-val">${target.closeness.toFixed(3)}</div><div class="stat-label">Closeness</div></div>
    `;
    showOverlay(resultOverlay);
  }, delay);
}

// ── Modals ───────────────────────────────────────────────────────
function showOverlay(el) { el.classList.remove("hidden"); }
function hideOverlay(el) { el.classList.add("hidden"); }

btnHelp.addEventListener("click", () => showOverlay(helpOverlay));
helpClose.addEventListener("click", () => hideOverlay(helpOverlay));
helpOverlay.addEventListener("click", (e) => {
  if (e.target === helpOverlay) hideOverlay(helpOverlay);
});
resultOverlay.addEventListener("click", (e) => {
  if (e.target === resultOverlay) hideOverlay(resultOverlay);
});
