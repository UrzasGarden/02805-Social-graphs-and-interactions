/* ═══════════════════════════════════════════════════════════════════
   Week 4 — Disparity filter + cutting bridges (edge betweenness)
   Philosophers network · D3-force layout, canvas rendering
   ═══════════════════════════════════════════════════════════════════ */

"use strict";

const DATA_URL = "graph_data.json";
const N_COLORED_COMMUNITIES = 10;
const TOP_LABEL_COUNT = 10;

const PALETTE = [
  "#6c8dff", "#7fd0ff", "#ff9e6c", "#ffd76c", "#8dff9e",
  "#ff6cc4", "#c46cff", "#6cffe0", "#ff6c6c", "#c4ff6c",
];
const OTHER_COLOR = "#4a5468";

// ── Global state ─────────────────────────────────────────────────
const state = {
  nodes: [],              // all graph nodes (degree > 0), each gets .x/.y/.fixedX/.fixedY
  nodesById: new Map(),
  edges: [],               // all raw edges [{source, target, weight}] (indices into nodes)
  alpha: 0.2,
  backboneEdges: [],        // edges surviving disparity filter at current alpha
  backboneNodeIds: new Set(),
  cutEdgeKeys: new Set(),   // edge keys removed by bridge cutting (subset of backboneEdges)
  cutLog: [],
  componentsHistory: [],
  layoutMode: "fixed",      // 'fixed' | 'backbone'
  transform: null,          // d3.zoomIdentity, set after d3 is available
  hoveredId: null,
  draggingId: null,
  quadtree: null,
  autoCutRunning: false,
  autoCutStop: false,
  colorByCommunity: new Map(), // communityId -> color (top N only)
  radiusScale: null,
  dpr: Math.max(1, window.devicePixelRatio || 1),
};

// ── DOM refs ─────────────────────────────────────────────────────
const canvas = document.getElementById("graph-canvas");
const ctx = canvas.getContext("2d");
const graphContainer = document.getElementById("graph-container");
const graphLoading = document.getElementById("graph-loading");
const hoverTooltip = document.getElementById("hover-tooltip");
const toolbarTitle = document.getElementById("toolbar-title");

const alphaSlider = document.getElementById("alpha-slider");
const alphaValueEl = document.getElementById("alpha-value");
const presetRow = document.getElementById("preset-row");
const statNodes = document.getElementById("stat-nodes");
const statEdges = document.getElementById("stat-edges");
const filterCaption = document.getElementById("filter-caption");
const legendList = document.getElementById("legend-list");
const layoutFixedBtn = document.getElementById("layout-fixed");
const layoutBackboneBtn = document.getElementById("layout-backbone");

const btnCutOne = document.getElementById("btn-cut-one");
const btnCutN = document.getElementById("btn-cut-n");
const btnResetCuts = document.getElementById("btn-reset-cuts");
const btnStopAuto = document.getElementById("btn-stop-auto");
const cutNInput = document.getElementById("cut-n-input");
const statComponents = document.getElementById("stat-components");
const cutLogEl = document.getElementById("cut-log");
const sparklineEl = document.getElementById("sparkline");

const zoomInBtn = document.getElementById("zoom-in");
const zoomOutBtn = document.getElementById("zoom-out");
const zoomResetBtn = document.getElementById("zoom-reset");

// ── Boot ─────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  state.transform = d3.zoomIdentity;
  resizeCanvas();
  window.addEventListener("resize", () => { resizeCanvas(); scheduleRedraw(); });

  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    initGraph(data);
    buildCommunityPalette();
    renderLegend();
    setupZoomAndDrag();
    setupControls();

    computeInitialLayout();

    computeBackbone(state.alpha);
    applyLayoutMode();
    graphLoading.classList.add("done");
    redraw();
  } catch (err) {
    graphLoading.textContent = "Could not load graph_data.json — run build_data.py first.";
    console.error(err);
  }
}

// ── Graph init ───────────────────────────────────────────────────
function initGraph(data) {
  const allNodes = data.nodes.filter((n) => n.degree > 0);
  state.nodes = allNodes;
  state.nodesById = new Map(allNodes.map((n) => [n.id, n]));
  state.edges = data.edges;

  const maxStrength = d3.max(allNodes, (n) => n.strength) || 1;
  const minStrength = d3.min(allNodes, (n) => n.strength) || 1;
  state.radiusScale = d3.scaleSqrt().domain([minStrength, maxStrength]).range([2.2, 15]);
}

function buildCommunityPalette() {
  const counts = new Map();
  for (const n of state.nodes) counts.set(n.community, (counts.get(n.community) || 0) + 1);
  // community ids are already assigned largest-first by build_data.py
  for (let cid = 0; cid < N_COLORED_COMMUNITIES; cid++) {
    if (counts.has(cid)) state.colorByCommunity.set(cid, PALETTE[cid % PALETTE.length]);
  }
}

function colorForNode(n) {
  return state.colorByCommunity.get(n.community) || OTHER_COLOR;
}

function renderLegend() {
  const counts = new Map();
  const labels = new Map();
  for (const n of state.nodes) {
    counts.set(n.community, (counts.get(n.community) || 0) + 1);
    labels.set(n.community, n.community_label);
  }
  const entries = [...state.colorByCommunity.entries()]
    .map(([cid, color]) => ({ cid, color, count: counts.get(cid) || 0, label: labels.get(cid) }))
    .sort((a, b) => b.count - a.count);

  const otherCount = [...counts.entries()]
    .filter(([cid]) => !state.colorByCommunity.has(cid))
    .reduce((sum, [, c]) => sum + c, 0);

  legendList.innerHTML = "";
  for (const e of entries) {
    legendList.appendChild(legendRow(e.color, e.label, e.count));
  }
  if (otherCount > 0) {
    legendList.appendChild(legendRow(OTHER_COLOR, "Other / small communities", otherCount));
  }
}

function legendRow(color, label, count) {
  const row = document.createElement("div");
  row.className = "legend-item";
  row.innerHTML = `
    <span class="legend-dot" style="background:${color}"></span>
    <span class="legend-name" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
    <span class="legend-count">${count}</span>
  `;
  return row;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ── Full-network force layout (computed once, frozen) ──────────────
// Runs synchronously (no rAF chunking): 220 ticks over ~1.4k nodes /
// 9k edges finishes in well under a second, and a brief main-thread
// block behind the loading overlay is simpler and more reliable than
// spreading it across animation frames (which can stall on throttled
// or backgrounded tabs).
function computeInitialLayout() {
  const w = graphContainer.clientWidth || 900;
  const h = graphContainer.clientHeight || 600;

  const simNodes = state.nodes.map((n) => ({ id: n.id, x: undefined, y: undefined }));
  const simLinks = state.edges.map((e) => ({ source: e.source, target: e.target }));

  const sim = d3.forceSimulation(simNodes)
    .force("link", d3.forceLink(simLinks).id((d) => d.id).distance(22).strength(0.12))
    .force("charge", d3.forceManyBody().strength(-16).theta(0.9))
    .force("center", d3.forceCenter(w / 2, h / 2))
    .force("collide", d3.forceCollide().radius((d) => {
      const n = state.nodesById.get(d.id);
      return state.radiusScale(n.strength) + 1;
    }).iterations(1))
    .stop();

  for (let i = 0; i < 220; i++) sim.tick();

  for (const sn of simNodes) {
    const n = state.nodesById.get(sn.id);
    n.fixedX = sn.x;
    n.fixedY = sn.y;
    n.x = sn.x;
    n.y = sn.y;
  }
}

// ── Disparity filter ─────────────────────────────────────────────
function edgeKey(a, b) {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function computeBackbone(alpha) {
  const kept = [];
  const keptNodeIds = new Set();

  for (const e of state.edges) {
    const nu = state.nodesById.get(e.source);
    const nv = state.nodesById.get(e.target);
    if (!nu || !nv) continue;

    const sigU = nu.degree <= 1
      ? true
      : Math.pow(1 - e.weight / nu.strength, nu.degree - 1) < alpha;
    const sigV = nv.degree <= 1
      ? true
      : Math.pow(1 - e.weight / nv.strength, nv.degree - 1) < alpha;

    if (sigU || sigV) {
      kept.push(e);
      keptNodeIds.add(e.source);
      keptNodeIds.add(e.target);
    }
  }

  state.backboneEdges = kept;
  state.backboneNodeIds = keptNodeIds;
  state.cutEdgeKeys = new Set();
  state.cutLog = [];

  updateFilterStats();
  resetComponentsTracking();
  renderCutLog();
  rebuildQuadtree();
}

function updateFilterStats() {
  const totalNodes = state.nodes.length;
  const totalEdges = state.edges.length;
  const keptNodes = state.backboneNodeIds.size;
  const keptEdges = state.backboneEdges.length;

  statNodes.textContent = `${keptNodes} / ${totalNodes}`;
  statEdges.textContent = `${keptEdges} / ${totalEdges}`;

  const pctEdges = totalEdges ? ((keptEdges / totalEdges) * 100).toFixed(1) : "0.0";
  const pctNodes = totalNodes ? ((keptNodes / totalNodes) * 100).toFixed(1) : "0.0";

  filterCaption.innerHTML = `
    Disparity filter at <strong>&alpha; = ${state.alpha.toFixed(2)}</strong>: kept
    <strong>${keptEdges}</strong> of ${totalEdges} links (${pctEdges}%) touching
    <strong>${keptNodes}</strong> of ${totalNodes} philosophers (${pctNodes}%).
    Removed ${totalEdges - keptEdges} statistically insignificant links.
  `;
  toolbarTitle.textContent = `Backbone at α = ${state.alpha.toFixed(2)}`;
}

// ── Connected components (union-find) ────────────────────────────
function activeEdges() {
  return state.backboneEdges.filter((e) => !state.cutEdgeKeys.has(edgeKey(e.source, e.target)));
}

function countComponents(nodeIds, edges) {
  const parent = new Map();
  for (const id of nodeIds) parent.set(id, id);
  function find(x) {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const e of edges) union(e.source, e.target);
  const roots = new Set();
  for (const id of nodeIds) roots.add(find(id));
  return roots.size;
}

function resetComponentsTracking() {
  const n = countComponents(state.backboneNodeIds, activeEdges());
  state.componentsHistory = [n];
  statComponents.textContent = n;
  drawSparkline();
}

// ── Edge betweenness (Brandes, unweighted) on the active backbone ──
function computeEdgeBetweenness() {
  const idList = [...state.backboneNodeIds];
  const localIndex = new Map(idList.map((id, i) => [id, i]));
  const n = idList.length;

  const adj = Array.from({ length: n }, () => []);
  for (const e of activeEdges()) {
    const a = localIndex.get(e.source);
    const b = localIndex.get(e.target);
    adj[a].push(b);
    adj[b].push(a);
  }

  const betweenness = new Map(); // local edge key "a_b" (a<b) -> score

  for (let s = 0; s < n; s++) {
    const stack = [];
    const preds = Array.from({ length: n }, () => []);
    const sigma = new Float64Array(n);
    const dist = new Int32Array(n).fill(-1);
    sigma[s] = 1;
    dist[s] = 0;
    const queue = [s];
    let qi = 0;
    while (qi < queue.length) {
      const v = queue[qi++];
      stack.push(v);
      for (const w of adj[v]) {
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1;
          queue.push(w);
        }
        if (dist[w] === dist[v] + 1) {
          sigma[w] += sigma[v];
          preds[w].push(v);
        }
      }
    }
    const delta = new Float64Array(n);
    while (stack.length) {
      const w = stack.pop();
      for (const v of preds[w]) {
        const c = (sigma[v] / sigma[w]) * (1 + delta[w]);
        const key = v < w ? `${v}_${w}` : `${w}_${v}`;
        betweenness.set(key, (betweenness.get(key) || 0) + c);
        delta[v] += c;
      }
    }
  }

  // Map local-index keys back to real node-id edges, halving (undirected double count)
  const result = new Map(); // realEdgeKey -> {score, edge}
  for (const e of activeEdges()) {
    const a = localIndex.get(e.source);
    const b = localIndex.get(e.target);
    const lkey = a < b ? `${a}_${b}` : `${b}_${a}`;
    const score = (betweenness.get(lkey) || 0) / 2;
    result.set(edgeKey(e.source, e.target), { score, edge: e });
  }
  return result;
}

function cutOneBridge() {
  const active = activeEdges();
  if (active.length === 0) return false;

  const scores = computeEdgeBetweenness();
  let bestKey = null, bestScore = -1, bestEdge = null;
  for (const [key, { score, edge }] of scores) {
    if (score > bestScore) { bestScore = score; bestKey = key; bestEdge = edge; }
  }
  if (bestKey === null) return false;

  state.cutEdgeKeys.add(bestKey);
  const nCount = countComponents(state.backboneNodeIds, activeEdges());
  state.componentsHistory.push(nCount);
  statComponents.textContent = nCount;

  const u = state.nodesById.get(bestEdge.source);
  const v = state.nodesById.get(bestEdge.target);
  state.cutLog.unshift({
    rank: state.cutLog.length + 1,
    a: u.name, b: v.name,
    score: bestScore,
    components: nCount,
  });

  renderCutLog();
  drawSparkline();
  return true;
}

function renderCutLog() {
  if (state.cutLog.length === 0) {
    cutLogEl.innerHTML = `<div class="cut-log-empty">No bridges cut yet.</div>`;
    return;
  }
  cutLogEl.innerHTML = state.cutLog.slice(0, 100).map((c) => `
    <div class="cut-log-entry">
      <span class="rank">#${c.rank}</span>
      <span class="names" title="${escapeHtml(c.a)} – ${escapeHtml(c.b)}">${escapeHtml(c.a)} – ${escapeHtml(c.b)}</span>
      <span>${c.components}c</span>
    </div>
  `).join("");
}

function drawSparkline() {
  const hist = state.componentsHistory;
  const w = 280, h = 46, pad = 3;
  const maxV = Math.max(1, d3.max(hist) || 1);
  const x = d3.scaleLinear().domain([0, Math.max(1, hist.length - 1)]).range([pad, w - pad]);
  const y = d3.scaleLinear().domain([1, maxV]).range([h - pad, pad]);
  const line = hist.map((v, i) => `${x(i)},${y(v)}`).join(" ");

  sparklineEl.innerHTML = `
    <polyline points="${line}" fill="none" stroke="#7fd0ff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    ${hist.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="2" fill="#6c8dff" />`).join("")}
  `;
}

// ── Layout mode (fixed full-map vs backbone-only reflow) ───────────
function applyLayoutMode() {
  if (state.layoutMode === "fixed") {
    for (const n of state.nodes) { n.x = n.fixedX; n.y = n.fixedY; }
    rebuildQuadtree();
    scheduleRedraw();
  } else {
    reflowBackboneOnly();
  }
}

function reflowBackboneOnly() {
  const ids = [...state.backboneNodeIds];
  if (ids.length === 0) { rebuildQuadtree(); scheduleRedraw(); return; }

  const w = graphContainer.clientWidth || 900;
  const h = graphContainer.clientHeight || 600;

  const idSet = new Set(ids);
  const simNodes = ids.map((id) => {
    const n = state.nodesById.get(id);
    return { id, x: n.x, y: n.y };
  });
  const simLinks = activeEdges()
    .filter((e) => idSet.has(e.source) && idSet.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));

  const sim = d3.forceSimulation(simNodes)
    .force("link", d3.forceLink(simLinks).id((d) => d.id).distance(26).strength(0.2))
    .force("charge", d3.forceManyBody().strength(-40))
    .force("center", d3.forceCenter(w / 2, h / 2))
    .force("collide", d3.forceCollide().radius((d) => {
      const n = state.nodesById.get(d.id);
      return state.radiusScale(n.strength) + 2;
    }).iterations(1))
    .stop();

  for (let i = 0; i < 200; i++) sim.tick();

  for (const sn of simNodes) {
    const n = state.nodesById.get(sn.id);
    n.x = sn.x;
    n.y = sn.y;
  }
  rebuildQuadtree();
  scheduleRedraw();
}

// ── Rendering ────────────────────────────────────────────────────
function resizeCanvas() {
  const w = graphContainer.clientWidth;
  const h = graphContainer.clientHeight;
  state.dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * state.dpr);
  canvas.height = Math.round(h * state.dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
}

let redrawScheduled = false;
function scheduleRedraw() {
  if (redrawScheduled) return;
  redrawScheduled = true;
  requestAnimationFrame(() => { redrawScheduled = false; redraw(); });
}

function topLabeledNodes() {
  return [...state.backboneNodeIds]
    .map((id) => state.nodesById.get(id))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, TOP_LABEL_COUNT);
}

function redraw() {
  const w = canvas.width / state.dpr;
  const h = canvas.height / state.dpr;

  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0a0e17";
  ctx.fillRect(0, 0, w, h);

  const t = state.transform;
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.scale(t.k, t.k);

  // Edges
  ctx.lineCap = "round";
  for (const e of state.backboneEdges) {
    if (state.cutEdgeKeys.has(edgeKey(e.source, e.target))) continue;
    const u = state.nodesById.get(e.source);
    const v = state.nodesById.get(e.target);
    ctx.beginPath();
    ctx.moveTo(u.x, u.y);
    ctx.lineTo(v.x, v.y);
    ctx.strokeStyle = "rgba(124, 141, 255, 0.22)";
    ctx.lineWidth = Math.min(1.8, 0.5 + Math.sqrt(e.weight) * 0.25) / t.k;
    ctx.stroke();
  }

  // Nodes
  for (const id of state.backboneNodeIds) {
    const n = state.nodesById.get(id);
    const r = state.radiusScale(n.strength);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = colorForNode(n);
    ctx.fill();
    if (id === state.hoveredId) {
      ctx.lineWidth = 2 / t.k;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
  }

  // Labels for top-strength nodes
  ctx.font = `${11 / t.k}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = "rgba(231, 236, 245, 0.92)";
  ctx.textBaseline = "bottom";
  for (const n of topLabeledNodes()) {
    const r = state.radiusScale(n.strength);
    ctx.fillText(n.name, n.x + r + 3 / t.k, n.y - 2 / t.k);
  }

  ctx.restore();
}

// ── Quadtree hit-testing ─────────────────────────────────────────
function rebuildQuadtree() {
  state.quadtree = d3.quadtree()
    .x((d) => d.x)
    .y((d) => d.y)
    .addAll([...state.backboneNodeIds].map((id) => state.nodesById.get(id)));
}

function findNodeAt(worldX, worldY, tolerance) {
  if (!state.quadtree) return null;
  let found = null;
  state.quadtree.visit((quad, x0, y0, x1, y1) => {
    if (!quad.length) {
      let d = quad;
      do {
        const dx = d.x - worldX, dy = d.y - worldY;
        const r = state.radiusScale(d.strength) + tolerance;
        if (dx * dx + dy * dy < r * r) { found = d; }
      } while ((d = d.next));
    }
    return x0 > worldX + tolerance || x1 < worldX - tolerance ||
      y0 > worldY + tolerance || y1 < worldY - tolerance;
  });
  return found;
}

function screenToWorld(px, py) {
  const t = state.transform;
  return { x: (px - t.x) / t.k, y: (py - t.y) / t.k };
}

// ── Zoom, pan, drag, hover ───────────────────────────────────────
function setupZoomAndDrag() {
  const sel = d3.select(canvas);

  const zoom = d3.zoom()
    .scaleExtent([0.08, 8])
    .filter((event) => {
      if (event.type === "wheel") return true;
      if (event.type === "mousedown") {
        const world = screenToWorld(event.offsetX, event.offsetY);
        return findNodeAt(world.x, world.y, 6 / state.transform.k) === null;
      }
      return true;
    })
    .on("zoom", (event) => { state.transform = event.transform; scheduleRedraw(); });

  sel.call(zoom);
  state._zoomBehavior = zoom;

  let dragNode = null;

  sel.on("mousedown.drag", (event) => {
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left, py = event.clientY - rect.top;
    const world = screenToWorld(px, py);
    const hit = findNodeAt(world.x, world.y, 6 / state.transform.k);
    if (hit) {
      dragNode = hit;
      state.draggingId = hit.id;
      event.stopImmediatePropagation();
    }
  });

  window.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom;

    if (!inside && !dragNode) { hideTooltip(); return; }

    const px = event.clientX - rect.left, py = event.clientY - rect.top;
    const world = screenToWorld(px, py);

    if (dragNode) {
      dragNode.x = world.x;
      dragNode.y = world.y;
      dragNode.fixedX = world.x;
      dragNode.fixedY = world.y;
      rebuildQuadtree();
      scheduleRedraw();
      return;
    }

    const hit = findNodeAt(world.x, world.y, 6 / state.transform.k);
    const newHoverId = hit ? hit.id : null;
    if (newHoverId !== state.hoveredId) {
      state.hoveredId = newHoverId;
      scheduleRedraw();
    }
    if (hit) {
      showTooltip(hit, px, py);
      canvas.style.cursor = "pointer";
    } else {
      hideTooltip();
      canvas.style.cursor = "grab";
    }
  });

  window.addEventListener("mouseup", () => { dragNode = null; state.draggingId = null; });
}

function showTooltip(n, px, py) {
  hoverTooltip.classList.remove("hidden");
  const subfields = n.subfields ? n.subfields.split(";").filter(Boolean).join(", ") : "";
  hoverTooltip.innerHTML = `
    <div class="tt-name">${escapeHtml(n.name)}</div>
    <div class="tt-era">${escapeHtml(n.era)}${subfields ? " · " + escapeHtml(subfields) : ""}</div>
    <div class="tt-desc">${escapeHtml(n.description)}</div>
    <div class="tt-stat"><span>Strength</span><span class="tt-val">${n.strength}</span></div>
    <div class="tt-stat"><span>Degree</span><span class="tt-val">${n.degree}</span></div>
    <div class="tt-stat"><span>Community</span><span class="tt-val">${escapeHtml(n.community_label)}</span></div>
  `;
  const cw = graphContainer.clientWidth, ch = graphContainer.clientHeight;
  let left = px + 14, top = py + 14;
  if (left + 260 > cw) left = px - 274;
  if (top + 160 > ch) top = py - 170;
  hoverTooltip.style.left = `${left}px`;
  hoverTooltip.style.top = `${top}px`;
}

function hideTooltip() {
  hoverTooltip.classList.add("hidden");
  if (state.hoveredId !== null) { state.hoveredId = null; scheduleRedraw(); }
}

// ── Controls wiring ──────────────────────────────────────────────
function setupControls() {
  alphaSlider.addEventListener("input", () => {
    setAlpha(parseFloat(alphaSlider.value), false);
  });

  presetRow.addEventListener("click", (e) => {
    const btn = e.target.closest(".preset-btn");
    if (!btn) return;
    setAlpha(parseFloat(btn.dataset.alpha), true);
  });

  layoutFixedBtn.addEventListener("click", () => {
    state.layoutMode = "fixed";
    layoutFixedBtn.classList.add("active");
    layoutBackboneBtn.classList.remove("active");
    applyLayoutMode();
  });
  layoutBackboneBtn.addEventListener("click", () => {
    state.layoutMode = "backbone";
    layoutBackboneBtn.classList.add("active");
    layoutFixedBtn.classList.remove("active");
    applyLayoutMode();
  });

  btnCutOne.addEventListener("click", () => { cutOneBridge(); scheduleRedraw(); });

  btnCutN.addEventListener("click", () => runAutoCut(parseInt(cutNInput.value, 10) || 1));
  btnStopAuto.addEventListener("click", () => { state.autoCutStop = true; });

  btnResetCuts.addEventListener("click", () => {
    state.cutEdgeKeys = new Set();
    state.cutLog = [];
    resetComponentsTracking();
    renderCutLog();
    scheduleRedraw();
  });

  zoomInBtn.addEventListener("click", () => d3.select(canvas).transition().duration(200).call(state._zoomBehavior.scaleBy, 1.4));
  zoomOutBtn.addEventListener("click", () => d3.select(canvas).transition().duration(200).call(state._zoomBehavior.scaleBy, 1 / 1.4));
  zoomResetBtn.addEventListener("click", () => d3.select(canvas).transition().duration(300).call(state._zoomBehavior.transform, d3.zoomIdentity));
}

function setAlpha(alpha, fromPreset) {
  state.alpha = alpha;
  alphaSlider.value = alpha;
  alphaValueEl.textContent = alpha.toFixed(2);

  [...presetRow.children].forEach((btn) => {
    btn.classList.toggle("active", Math.abs(parseFloat(btn.dataset.alpha) - alpha) < 1e-9);
  });

  computeBackbone(alpha);
  applyLayoutMode();
  scheduleRedraw();
}

async function runAutoCut(n) {
  if (state.autoCutRunning) return;
  state.autoCutRunning = true;
  state.autoCutStop = false;
  btnCutOne.disabled = true;
  btnCutN.disabled = true;
  btnStopAuto.disabled = false;

  for (let i = 0; i < n; i++) {
    if (state.autoCutStop) break;
    const ok = cutOneBridge();
    scheduleRedraw();
    if (!ok) break;
    await new Promise((r) => setTimeout(r, 120));
  }

  state.autoCutRunning = false;
  btnCutOne.disabled = false;
  btnCutN.disabled = false;
  btnStopAuto.disabled = true;
}
