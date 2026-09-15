const PALETTES = [
  { bg1: "#7a0d1f", bg2: "#ff5b3a", accent: "#ffd23f", ink: "#12080a" },
  { bg1: "#101b4d", bg2: "#2f6fed", accent: "#7fe7ff", ink: "#0a0f22" },
  { bg1: "#2c0f45", bg2: "#8a2be2", accent: "#ff5ec4", ink: "#160821" },
  { bg1: "#0c2818", bg2: "#1d8a4b", accent: "#c8ff4d", ink: "#062012" },
  { bg1: "#171717", bg2: "#ff7a1a", accent: "#ffd23f", ink: "#101018" },
];

const SOLO_TAGLINES = [
  "THE HUB OF THIS UNIVERSE!",
  "EVERY ROAD LEADS HERE!",
  "ALL CONNECTIONS CONVERGE!",
  "THE MOST-LINKED HERO ALIVE!",
  "CHANCE MADE THEM LEGENDARY!",
  "BORN RANDOM. BUILT UNSTOPPABLE.",
];

const TEAM_TAGLINES = [
  "ALLIES CHANCE NEVER PLANNED!",
  "STRANGERS NO MORE!",
  "TWO PATHS, ONE UNIVERSE!",
  "A TEAM-UP NOBODY SAW COMING!",
  "FATE REWRITES THE WIKI!",
  "NEVER MET. NOW INSEPARABLE.",
];

const MIN_NODES_FOR_HUB_CHECK = 12;
const HUB_Z = 2.5;
const HUB_MIN_DEGREE = 6;
// Slowest first: base is half the old default speed (1300ms/arrival), the old default
// (650ms) now sits in the middle as "normal" speed, and the old fixed speed (200ms) stays fastest.
const SPEED_LEVELS_MS = [1300, 650, 200];

const state = {
  realNodes: new Map(), // characterId -> name
  realDegree: new Map(), // characterId -> number
  realAdj: new Map(), // characterId -> Set(characterId)
  realTopHubs: [],
  universe: null, // { uniName, edges:[{source,target}], nodeOrder:[{characterId,name}] }
  timeline: [], // index -> { index, characterId, name, targetIndices:[] }
  hubEvents: [], // { step, index, characterId, name, degree, realDegree, threshold, uid, palette, tagline, images }
  pairEvents: [], // { step, aIndex, bIndex, characterIdA, characterIdB, nameA, nameB, realDist, uid, palette, tagline, images }
  N: 0,
  currentT: 0,
  renderedT: 0, // how many nodes are currently present in the live cy graph
  playing: false,
  playTimer: null,
  speedLevel: 0, // index into SPEED_LEVELS_MS
  centerSettleTimer: null,
  renderRAF: null,
  cy: null,
  imageCache: new Map(),
  modalUid: null,
};

function displayName(rawName) {
  return rawName.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function initials(rawName) {
  const n = displayName(rawName);
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return n.slice(0, 2).toUpperCase();
}

function escapeXML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function pickPalette() {
  return PALETTES[Math.floor(Math.random() * PALETTES.length)];
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function parseTSV(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => line.split("\t"));
}

// ---------- Wikipedia character art ----------
// node_id in the Week 1 dataset is the literal Wikipedia page title (e.g. "Abomination_(character)"),
// so it doubles as the path segment for the public REST summary endpoint.

function fetchWikipediaImage(id) {
  const endpoint = "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(id);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 6000));
  const req = fetch(endpoint, { headers: { accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => (data && data.thumbnail && data.thumbnail.source) || null)
    .catch(() => null);
  return Promise.race([req, timeout]);
}

function getCharacterImage(id) {
  if (!state.imageCache.has(id)) {
    state.imageCache.set(id, fetchWikipediaImage(id));
  }
  return state.imageCache.get(id);
}

// ---------- data loading (the real Week 1 network, for comparison) ----------

async function loadData() {
  const [nodesRes, edgesRes] = await Promise.all([
    fetch("../Week1/week1_nodes.tsv"),
    fetch("../Week1/week1_edges.tsv"),
  ]);
  if (!nodesRes.ok || !edgesRes.ok) throw new Error("Could not load the Week 1 Marvel dataset.");

  const nodesRaw = parseTSV(await nodesRes.text());
  const edgesRaw = parseTSV(await edgesRes.text());

  nodesRaw.forEach((row) => {
    if (row[0] === "node_id") return;
    const id = row[0].trim();
    const name = (row[1] || id).trim();
    state.realNodes.set(id, name);
    state.realDegree.set(id, 0);
    state.realAdj.set(id, new Set());
  });

  edgesRaw.forEach((row) => {
    const a = row[0].trim();
    const b = row[1].trim();
    if (!state.realNodes.has(a) || !state.realNodes.has(b)) return;
    state.realDegree.set(a, (state.realDegree.get(a) || 0) + 1);
    state.realDegree.set(b, (state.realDegree.get(b) || 0) + 1);
    state.realAdj.get(a).add(b);
    state.realAdj.get(b).add(a);
  });

  state.realTopHubs = Array.from(state.realDegree.entries())
    .sort((x, y) => y[1] - x[1])
    .slice(0, 5);
}

function realShortestPath(a, b) {
  if (a === b) return 0;
  const visited = new Set([a]);
  let frontier = [a];
  let dist = 0;
  while (frontier.length) {
    dist += 1;
    const next = [];
    for (const node of frontier) {
      const neighbors = state.realAdj.get(node);
      if (!neighbors) continue;
      for (const nb of neighbors) {
        if (nb === b) return dist;
        if (!visited.has(nb)) {
          visited.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return Infinity;
}

// ---------- cytoscape ----------

// Cytoscape draws style sizes in graph space, so by default they scale up
// with zoom — zoom in and nodes/text/edges all get proportionally bigger
// together, which is what makes a zoomed-in view feel like a handful of
// giant blobs rather than more legible detail. Style values can be given as
// functions that Cytoscape re-evaluates per render, so dividing every size
// by the current zoom cancels that scaling out and keeps each one a fixed
// number of screen pixels regardless of zoom level — zooming acts purely as
// a magnifying glass on layout/position, not on the ink itself.
const NODE_MIN_PX = 12;
const NODE_MAX_PX = 56;
const NODE_MAX_DEGREE_FOR_SIZE = 26;

function nodeDiameterPx(ele) {
  const deg = ele.data("degree") || 0;
  const t = Math.max(0, Math.min(1, deg / NODE_MAX_DEGREE_FOR_SIZE));
  return NODE_MIN_PX + t * (NODE_MAX_PX - NODE_MIN_PX);
}

function zoomFixed(basePx) {
  return (ele) => basePx / ele.cy().zoom();
}

function initCytoscape() {
  state.cy = cytoscape({
    container: document.getElementById("cy"),
    elements: [],
    style: [
      {
        selector: "node",
        style: {
          label: "data(label)",
          color: "#111",
          "font-size": (ele) => 11 / ele.cy().zoom(),
          "font-family": "JetBrains Mono, monospace",
          "text-valign": "bottom",
          "text-margin-y": zoomFixed(5),
          "text-outline-width": zoomFixed(2),
          "text-outline-color": "#fff",
          "background-color": "mapData(degree, 0, 26, #3b82f6, #ef4444)",
          width: (ele) => nodeDiameterPx(ele) / ele.cy().zoom(),
          height: (ele) => nodeDiameterPx(ele) / ele.cy().zoom(),
          "border-width": zoomFixed(2),
          "border-color": "#000",
        },
      },
      {
        selector: "edge",
        style: {
          width: zoomFixed(1.4),
          "line-color": "#000",
          "curve-style": "haystack",
          "haystack-radius": 0,
          opacity: 0.55,
        },
      },
      { selector: "node.hub-flag", style: { "border-color": "#fde047", "border-width": zoomFixed(4) } },
      { selector: "node.highlight", style: { "border-color": "#06b6d4", "border-width": zoomFixed(4) } },
      { selector: "edge.highlight", style: { "line-color": "#06b6d4", opacity: 1, width: zoomFixed(2.4) } },
      { selector: ".fade", style: { opacity: 0.1 } },
    ],
    layout: { name: "grid" },
    wheelSensitivity: 0.25,
  });

  // Function-valued styles are re-evaluated when Cytoscape recomputes an
  // element's style, which a plain zoom (no element data/class change)
  // doesn't otherwise trigger — nudge it explicitly so sizing updates live
  // while the user is actively zooming, not just on the next unrelated
  // render.
  state.cy.on("zoom", () => state.cy.style().update());

  state.cy.on("tap", "node", (evt) => {
    const node = evt.target;
    state.cy.elements().removeClass("highlight fade");
    state.cy.elements().addClass("fade");
    node.removeClass("fade").addClass("highlight");
    node.connectedEdges().removeClass("fade").addClass("highlight");
    node.connectedEdges().connectedNodes().removeClass("fade");
  });
  state.cy.on("tap", (evt) => {
    if (evt.target === state.cy) state.cy.elements().removeClass("highlight fade");
  });
}

// ---------- timeline construction ----------
// week2.html builds its BA graph so that in every {source,target} edge, the
// higher-index endpoint is always the node that was attaching (the "newcomer")
// and the lower-index endpoint already existed. That lets us replay the exact
// same universe as a node-by-node arrival sequence with no new randomness.

function buildTimeline() {
  const nodeOrder = state.universe.nodeOrder;
  const edges = state.universe.edges;
  const N = nodeOrder.length;
  state.N = N;

  const targetsByIndex = Array.from({ length: N }, () => []);
  edges.forEach((e) => {
    const hi = Math.max(e.source, e.target);
    const lo = Math.min(e.source, e.target);
    if (hi >= 0 && hi < N) targetsByIndex[hi].push(lo);
  });

  const degree = new Array(N).fill(0);
  const alertedHubs = new Set();
  const alertedPairs = new Set();
  state.timeline = [];
  state.hubEvents = [];
  state.pairEvents = [];

  for (let i = 0; i < N; i++) {
    const targets = targetsByIndex[i];
    targets.forEach((t) => {
      degree[i]++;
      degree[t]++;
    });
    const issue = i + 1;
    state.timeline.push({ index: i, characterId: nodeOrder[i].characterId, name: nodeOrder[i].name, targetIndices: targets });

    const arrivedCount = i + 1;
    if (arrivedCount >= MIN_NODES_FOR_HUB_CHECK) {
      let sum = 0;
      for (let k = 0; k <= i; k++) sum += degree[k];
      const mean = sum / arrivedCount;
      let variance = 0;
      for (let k = 0; k <= i; k++) variance += (degree[k] - mean) ** 2;
      const std = Math.sqrt(variance / arrivedCount);
      const threshold = Math.max(HUB_MIN_DEGREE, Math.round(mean + HUB_Z * std));

      [i, ...targets].forEach((nid) => {
        if (alertedHubs.has(nid)) return;
        if (degree[nid] < threshold) return;
        alertedHubs.add(nid);
        const characterId = nodeOrder[nid].characterId;
        state.hubEvents.push({
          type: "hub",
          step: i,
          uid: "h" + nid + "-" + issue,
          index: nid,
          characterId,
          name: nodeOrder[nid].name,
          degree: degree[nid],
          realDegree: state.realDegree.get(characterId) || 0,
          threshold,
          issue,
          palette: pickPalette(),
          tagline: pick(SOLO_TAGLINES),
        });
      });
    }

    targets.forEach((t) => {
      const key = [i, t].sort((a, b) => a - b).join("|");
      if (alertedPairs.has(key)) return;
      const idA = nodeOrder[i].characterId;
      const idB = nodeOrder[t].characterId;
      const realDist = realShortestPath(idA, idB);
      if (!(realDist === Infinity || realDist >= 5)) return;
      alertedPairs.add(key);
      state.pairEvents.push({
        type: "pair",
        step: i,
        uid: "p" + key + "-" + issue,
        aIndex: i,
        bIndex: t,
        characterIdA: idA,
        characterIdB: idB,
        nameA: nodeOrder[i].name,
        nameB: nodeOrder[t].name,
        realDist,
        newDist: 1,
        issue,
        palette: pickPalette(),
        tagline: pick(TEAM_TAGLINES),
      });
    });
  }
}

function replayUpTo(t) {
  const degree = new Array(t).fill(0);
  const nodesPresent = [];
  for (let i = 0; i < t; i++) {
    const step = state.timeline[i];
    nodesPresent.push(step);
    step.targetIndices.forEach((tg) => {
      degree[i]++;
      degree[tg]++;
    });
  }
  return { nodesPresent, degree };
}

// ---------- rendering ----------

function renderHubRow(rank, name, degree, maxDegree, isHub) {
  const li = document.createElement("li");
  li.className = "hub-row" + (isHub ? " is-new-hub" : "");
  const pct = maxDegree > 0 ? Math.max(6, Math.round((degree / maxDegree) * 100)) : 0;
  li.innerHTML =
    '<span class="hub-rank">' +
    rank +
    '</span><span class="hub-name-wrap"><span class="hub-name">' +
    escapeXML(displayName(name)) +
    '</span><span class="hub-bar-track"><span class="hub-bar-fill" style="width:' +
    pct +
    '%"></span></span></span><span class="hub-deg">' +
    degree +
    "</span>";
  return li;
}

function renderRealHubList() {
  const list = document.getElementById("real-hub-list");
  list.innerHTML = "";
  const max = state.realTopHubs.length ? state.realTopHubs[0][1] : 0;
  state.realTopHubs.forEach(([id, deg], i) => {
    list.appendChild(renderHubRow(i + 1, state.realNodes.get(id), deg, max, false));
  });
}

function renderGrowingHubList(nodesPresent, degree, t) {
  const list = document.getElementById("growing-hub-list");
  const entries = nodesPresent.map((n, i) => ({ idx: i, name: n.name, degree: degree[i] }));
  entries.sort((a, b) => b.degree - a.degree);
  const top = entries.slice(0, 5);
  if (!top.length) {
    list.innerHTML = '<li class="empty-note">Nobody has arrived yet.</li>';
    return;
  }
  list.innerHTML = "";
  const max = top[0].degree;
  const hubIndexSet = new Set(state.hubEvents.filter((ev) => ev.step < t).map((ev) => ev.index));
  top.forEach((n, i) => list.appendChild(renderHubRow(i + 1, n.name, n.degree, max, hubIndexSet.has(n.idx))));
}

// ---------- comic cover ----------

function starburstPoints(cx, cy, rOuter, rInner, spikes) {
  const pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const angle = (Math.PI * i) / spikes - Math.PI / 2;
    pts.push((cx + r * Math.cos(angle)).toFixed(1) + "," + (cy + r * Math.sin(angle)).toFixed(1));
  }
  return pts.join(" ");
}

function titleFontSize(title) {
  if (title.length > 26) return 20;
  if (title.length > 18) return 24;
  return 30;
}

function badgeOrPhoto(rx, ry, rw, rh, imageUrl, initialsText, uid, slot, p) {
  if (imageUrl) {
    const clipId = "clip-" + uid + "-" + slot;
    return (
      '<clipPath id="' + clipId + '"><rect x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '" rx="10"/></clipPath>' +
      '<rect x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '" rx="10" fill="url(#badgeGrad-' + uid + ')"/>' +
      '<image href="' + escapeXML(imageUrl) + '" x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '" preserveAspectRatio="xMidYMid meet" clip-path="url(#' + clipId + ')"/>' +
      '<rect x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '" fill="none" stroke="' + p.ink + '" stroke-width="5" rx="10"/>'
    );
  }
  const cx = rx + rw / 2;
  const cy = ry + rh / 2;
  const fontSize = Math.round(Math.min(rh * 0.4, rw / (initialsText.length * 0.7)));
  return (
    '<rect x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '" rx="10" fill="url(#badgeGrad-' + uid + ')" stroke="' + p.ink + '" stroke-width="5"/>' +
    '<text x="' + cx + '" y="' + (cy + fontSize * 0.32) + '" font-family="Bangers, cursive" font-size="' + fontSize + '" fill="' + p.ink + '" text-anchor="middle">' + escapeXML(initialsText) + "</text>"
  );
}

function buildComicSVG(ev) {
  const p = ev.palette;
  const w = 340,
    h = 460;
  const isTeam = ev.type === "pair";
  const rawTitle = isTeam ? displayName(ev.nameA) + " & " + displayName(ev.nameB) : displayName(ev.name);
  const title = escapeXML(rawTitle);
  const fontSize = titleFontSize(rawTitle);
  const images = ev.images || [];

  const photoTop = 6,
    photoBottom = h - 6,
    margin = 6;

  let badgeMarkup;
  if (isTeam) {
    const gap = 6;
    const half = (w - margin * 2 - gap) / 2;
    const xA = margin,
      xB = margin + half + gap;
    const seamCx = w / 2,
      seamCy = (photoTop + photoBottom) / 2;
    badgeMarkup =
      badgeOrPhoto(xA, photoTop, half, photoBottom - photoTop, images[0], initials(ev.nameA), ev.uid, "a", p) +
      badgeOrPhoto(xB, photoTop, half, photoBottom - photoTop, images[1], initials(ev.nameB), ev.uid, "b", p) +
      '<circle cx="' + seamCx + '" cy="' + seamCy + '" r="23" fill="' + p.accent + '" stroke="' + p.ink + '" stroke-width="4"/>' +
      '<text x="' + seamCx + '" y="' + (seamCy + 8) + '" font-family="Bangers, cursive" font-size="26" fill="' + p.ink + '" text-anchor="middle">&amp;</text>';
  } else {
    badgeMarkup = badgeOrPhoto(margin, photoTop, w - margin * 2, photoBottom - photoTop, images[0], initials(ev.name), ev.uid, "solo", p);
  }

  const star = starburstPoints(w / 2, h - 68, 88, 62, 12);

  return (
    '<svg viewBox="0 0 ' + w + " " + h + '" xmlns="http://www.w3.org/2000/svg" class="comic-cover">' +
    "<defs>" +
    '<linearGradient id="bgGrad-' + ev.uid + '" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="' + p.bg1 + '"/><stop offset="100%" stop-color="' + p.bg2 + '"/>' +
    "</linearGradient>" +
    '<pattern id="dots-' + ev.uid + '" width="9" height="9" patternUnits="userSpaceOnUse">' +
    '<circle cx="2" cy="2" r="1.1" fill="' + p.ink + '" opacity="0.16"/>' +
    "</pattern>" +
    '<radialGradient id="badgeGrad-' + ev.uid + '" cx="50%" cy="42%" r="65%">' +
    '<stop offset="0%" stop-color="' + p.accent + '"/><stop offset="100%" stop-color="' + p.bg2 + '"/>' +
    "</radialGradient>" +
    '<linearGradient id="headerFade-' + ev.uid + '" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="' + p.ink + '" stop-opacity="0.85"/>' +
    '<stop offset="100%" stop-color="' + p.ink + '" stop-opacity="0"/>' +
    "</linearGradient>" +
    '<linearGradient id="footerFade-' + ev.uid + '" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="' + p.ink + '" stop-opacity="0"/>' +
    '<stop offset="35%" stop-color="' + p.ink + '" stop-opacity="0.55"/>' +
    '<stop offset="60%" stop-color="' + p.ink + '" stop-opacity="0.92"/>' +
    '<stop offset="100%" stop-color="' + p.ink + '" stop-opacity="0.97"/>' +
    "</linearGradient>" +
    "</defs>" +
    '<rect x="0" y="0" width="' + w + '" height="' + h + '" fill="url(#bgGrad-' + ev.uid + ')"/>' +
    '<rect x="0" y="0" width="' + w + '" height="' + h + '" fill="url(#dots-' + ev.uid + ')"/>' +
    badgeMarkup +
    '<rect x="0" y="0" width="' + w + '" height="46" fill="url(#headerFade-' + ev.uid + ')"/>' +
    '<rect x="0" y="' + (h - 150) + '" width="' + w + '" height="150" fill="url(#footerFade-' + ev.uid + ')"/>' +
    '<polygon points="' + star + '" fill="' + p.accent + '" opacity="0.16"/>' +
    '<rect x="4" y="4" width="' + (w - 8) + '" height="' + (h - 8) + '" fill="none" stroke="' + p.ink + '" stroke-width="8" rx="4"/>' +
    '<g font-family="Bangers, cursive">' +
    '<text x="20" y="26" font-size="15" fill="' + p.accent + '" stroke="' + p.ink + '" stroke-width="0.5">ISSUE #' + ev.issue + "</text>" +
    '<text x="' + (w - 20) + '" y="26" font-size="15" fill="' + p.accent + '" stroke="' + p.ink + '" stroke-width="0.5" text-anchor="end">25&cent;</text>' +
    '<text x="' + w / 2 + '" y="' + (h - 96) + '" font-size="' + fontSize + '" fill="#ffffff" stroke="' + p.ink + '" stroke-width="1.2" text-anchor="middle">' + title + "</text>" +
    '<text x="' + w / 2 + '" y="' + (h - 62) + '" font-size="14" fill="' + p.accent + '" text-anchor="middle" letter-spacing="1">' + escapeXML(ev.tagline) + "</text>" +
    '<text x="' + w / 2 + '" y="' + (h - 30) + '" font-size="10" fill="#ffffff" text-anchor="middle" opacity="0.85" font-family="-apple-system, sans-serif">ALT-VERSE COMICS &middot; AI mock cover, generated live</text>' +
    "</g>" +
    "</svg>"
  );
}

// ---------- newsstand sections (click a cover to pop it open) ----------

function ensureEventImages(ev) {
  if (ev.images) return;
  const ids = ev.type === "hub" ? [ev.characterId] : [ev.characterIdA, ev.characterIdB];
  Promise.all(ids.map((id) => getCharacterImage(id))).then((images) => {
    ev.images = images;
    const el = document.querySelector('.newsstand-item[data-uid="' + ev.uid + '"]');
    if (el) {
      const captionEl = el.querySelector(".caption");
      const captionHTML = captionEl ? captionEl.outerHTML : "";
      el.innerHTML = buildComicSVG(ev) + captionHTML;
    }
    if (state.modalUid === ev.uid) {
      document.getElementById("modal-cover").innerHTML = buildComicSVG(ev);
    }
  });
}

function buildNewsstandItem(ev) {
  const item = document.createElement("div");
  item.className = "newsstand-item";
  item.dataset.uid = ev.uid;
  const caption = ev.type === "hub" ? displayName(ev.name) : displayName(ev.nameA) + " & " + displayName(ev.nameB);
  item.innerHTML = buildComicSVG(ev) + '<div class="caption">' + escapeXML(caption) + "</div>";
  item.addEventListener("click", () => openModal(ev));
  ensureEventImages(ev);
  return item;
}

// ---------- modal (enlarged comic cover) ----------

// realDegree 0 has no ratio to take — the character is going from "unconnected"
// to ev.degree connections, so ev.degree itself is how many times bigger that is.
function hubGrowthMultiplier(ev) {
  return ev.realDegree > 0 ? ev.degree / ev.realDegree : ev.degree;
}

function formatMultiplier(n) {
  const rounded = Math.round(n * 10) / 10;
  return rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1);
}

function buildModalHeadlineHTML(ev) {
  if (ev.type !== "hub") return "";
  return (
    '<span class="modal-headline-num">' + formatMultiplier(hubGrowthMultiplier(ev)) + "&times;</span>" +
    '<span class="modal-headline-label">bigger than in the real network</span>'
  );
}

function buildModalStatsHTML(ev) {
  if (ev.type === "hub") {
    return (
      '<div class="modal-stat"><span>Degree in this universe</span><b>' + ev.degree + "</b></div>" +
      '<div class="modal-stat"><span>Degree in the real network</span><b>' + ev.realDegree + "</b></div>"
    );
  }
  return (
    '<div class="modal-stat"><span>Steps apart, this universe</span><b>' + ev.newDist + "</b></div>" +
    '<div class="modal-stat"><span>Steps apart, real network</span><b>' + (ev.realDist === Infinity ? "unconnected" : ev.realDist) + "</b></div>"
  );
}

function buildModalText(ev) {
  if (ev.type === "hub") {
    return (
      displayName(ev.name) +
      " became a hub of this universe on issue #" +
      ev.issue +
      ", racking up " +
      ev.degree +
      " connections versus just " +
      ev.realDegree +
      " in the real Marvel network."
    );
  }
  const realBit = ev.realDist === Infinity ? "completely unconnected" : ev.realDist + " steps apart";
  return displayName(ev.nameA) + " and " + displayName(ev.nameB) + " got wired directly together on issue #" + ev.issue + " — despite being " + realBit + " in the real network.";
}

function openModal(ev) {
  state.modalUid = ev.uid;
  const title = ev.type === "hub" ? displayName(ev.name) : displayName(ev.nameA) + " & " + displayName(ev.nameB);
  document.getElementById("modal-eyebrow").textContent = ev.type === "hub" ? "Hub alert — issue #" + ev.issue : "Unlikely alliance — issue #" + ev.issue;
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-headline").innerHTML = buildModalHeadlineHTML(ev);
  document.getElementById("modal-stats").innerHTML = buildModalStatsHTML(ev);
  document.getElementById("modal-text").textContent = buildModalText(ev);
  document.getElementById("modal-cover").innerHTML = buildComicSVG(ev);
  document.getElementById("modal-overlay").classList.add("open");
  ensureEventImages(ev);
}

function closeModal() {
  document.getElementById("modal-overlay").classList.remove("open");
  state.modalUid = null;
}

function wireModal() {
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.modalUid) closeModal();
  });
}

function renderNewsstands(t) {
  const hubGrid = document.getElementById("hub-newsstand-grid");
  const visibleHubs = state.hubEvents.filter((ev) => ev.step < t).sort((a, b) => b.step - a.step);
  hubGrid.innerHTML = "";
  if (!visibleHubs.length) {
    hubGrid.innerHTML = '<p class="empty-note">No hubs have emerged yet.</p>';
  } else {
    visibleHubs.forEach((ev) => hubGrid.appendChild(buildNewsstandItem(ev)));
  }

  const allianceGrid = document.getElementById("alliance-newsstand-grid");
  const visiblePairs = state.pairEvents.filter((ev) => ev.step < t).sort((a, b) => b.step - a.step);
  allianceGrid.innerHTML = "";
  if (!visiblePairs.length) {
    allianceGrid.innerHTML = '<p class="empty-note">No unlikely alliances yet.</p>';
  } else {
    visiblePairs.forEach((ev) => allianceGrid.appendChild(buildNewsstandItem(ev)));
  }
}

// ---------- main render: universe state at time t ----------

// Diff the live cytoscape graph against target index t instead of tearing it
// down and rebuilding every call — that destroyed node identity/position on
// every tick (visible as layout "ghosting") and a forced fit() re-zoomed to
// fit all nodes on every render, fighting any manual pan/zoom. Growing nodes
// are added incrementally (keeping their positions) and only the nodes past t
// are removed when scrubbing backward; the view is never auto-fit, so the
// user can pan/zoom around the graph exactly like before.
function syncCyToIndex(t, opts) {
  const prevT = state.renderedT;

  if (t > prevT) {
    const toAdd = [];
    for (let i = prevT; i < t; i++) {
      const step = state.timeline[i];
      toAdd.push({ group: "nodes", data: { id: "n" + i, label: displayName(step.name), degree: 0 } });
    }
    for (let i = prevT; i < t; i++) {
      state.timeline[i].targetIndices.forEach((tg) => {
        toAdd.push({ group: "edges", data: { id: "e" + i + "_" + tg, source: "n" + i, target: "n" + tg } });
      });
    }
    state.cy.add(toAdd);
  } else if (t < prevT) {
    const toRemove = [];
    for (let i = t; i < prevT; i++) toRemove.push("#n" + i);
    if (toRemove.length) state.cy.remove(toRemove.join(","));
  }
  state.renderedT = t;

  // Degree can change for already-present nodes too (later arrivals attach
  // back to them), so refresh degree + hub-flag on everything still present.
  const degree = new Array(t).fill(0);
  for (let i = 0; i < t; i++) {
    state.timeline[i].targetIndices.forEach((tg) => {
      degree[i]++;
      degree[tg]++;
    });
  }
  const hubIndexSet = new Set(state.hubEvents.filter((ev) => ev.step < t).map((ev) => ev.index));
  for (let i = 0; i < t; i++) {
    const el = state.cy.getElementById("n" + i);
    if (!el || !el.length) continue;
    el.data("degree", degree[i]);
    if (hubIndexSet.has(i)) el.addClass("hub-flag");
    else el.removeClass("hub-flag");
  }

  document.getElementById("cy-empty").style.display = t === 0 ? "flex" : "none";

  const grew = t > prevT;
  const jumped = t - prevT > 1; // scrubbing ahead adds several nodes in one call — always lay those out, don't wait for the periodic tick below
  let layout = null;
  if (grew && (jumped || t < 60 || t % 3 === 0)) {
    layout = state.cy.layout({ name: "cose", animate: opts.animate !== false, animationDuration: 350, randomize: false, fit: false, nodeRepulsion: 6000, idealEdgeLength: 70 });
  }

  // Keep the current single biggest hub anchored in the middle of the view.
  // The cose layout recomputes the whole graph's positions as it grows, so
  // without an anchor the content drifts under a viewport that isn't moving
  // — this gives growth a stable center to radiate out from instead. Only
  // pan is touched, so any zoom level the user has set is left alone.
  //
  // A layout with animate:true computes final positions synchronously but
  // only *tweens* node.position() to them over the animation, so centering
  // immediately after starting it uses a stale, pre-animation position and
  // drifts off by however far that run moved the hub (more visible the
  // further the user is zoomed in). Centering now covers live tracking
  // while ticks keep coming; the debounced settle timer below guarantees
  // one more correct recenter ~400ms after the *last* render call (i.e.
  // once growth actually stops, whether paused or between drag events),
  // using the final settled position instead of racing any one layout's
  // own animation-complete event.
  centerOnCurrentHub();
  if (layout) layout.run();
  clearTimeout(state.centerSettleTimer);
  state.centerSettleTimer = setTimeout(centerOnCurrentHub, 400);
}

function centerOnCurrentHub() {
  const nodes = state.cy.nodes();
  if (!nodes.length) return;
  let best = null;
  let bestDeg = -1;
  nodes.forEach((n) => {
    const d = n.data("degree") || 0;
    if (d > bestDeg) {
      bestDeg = d;
      best = n;
    }
  });
  if (best) state.cy.center(best);
}

function renderAtIndex(t, opts) {
  opts = opts || {};
  t = Math.max(0, Math.min(state.N, Math.round(t)));
  state.currentT = t;

  syncCyToIndex(t, opts);
  const { nodesPresent, degree } = replayUpTo(t);

  const pct = state.N ? (t / state.N) * 100 : 0;
  document.getElementById("timebar-fill").style.width = pct + "%";
  document.getElementById("timebar-thumb").style.left = pct + "%";
  document.getElementById("timebar-thumb").setAttribute("aria-valuenow", String(t));
  document.getElementById("timebar-readout").textContent = t + " / " + state.N + " characters arrived" + (t >= state.N && state.N > 0 ? " — complete!" : "");

  renderGrowingHubList(nodesPresent, degree, t);
  renderNewsstands(t);
}

function scheduleRenderAtIndex(t, opts) {
  if (state.renderRAF) cancelAnimationFrame(state.renderRAF);
  state.renderRAF = requestAnimationFrame(() => {
    state.renderRAF = null;
    renderAtIndex(t, opts);
  });
}

// ---------- play / pause ----------

function setPlayButtonState(playing) {
  const btn = document.getElementById("play-btn");
  btn.innerHTML = playing ? "&#10074;&#10074;" : "&#9654;";
  btn.setAttribute("aria-label", playing ? "Pause" : "Play");
  btn.setAttribute("aria-pressed", String(playing));
}

function startPlaying() {
  if (state.currentT >= state.N) state.currentT = 0;
  state.playing = true;
  setPlayButtonState(true);
  clearInterval(state.playTimer);
  state.playTimer = setInterval(() => {
    const next = state.currentT + 1;
    if (next >= state.N) {
      renderAtIndex(state.N);
      stopPlaying();
      return;
    }
    renderAtIndex(next);
  }, SPEED_LEVELS_MS[state.speedLevel]);
}

function stopPlaying() {
  state.playing = false;
  setPlayButtonState(false);
  clearInterval(state.playTimer);
  state.playTimer = null;
}

function togglePlay() {
  if (state.playing) stopPlaying();
  else startPlaying();
}

function setSpeedLevel(level) {
  state.speedLevel = level;
  const medBtn = document.getElementById("speed-btn-med");
  const fastBtn = document.getElementById("speed-btn-fast");
  medBtn.classList.toggle("active", level === 1);
  medBtn.setAttribute("aria-pressed", String(level === 1));
  fastBtn.classList.toggle("active", level === 2);
  fastBtn.setAttribute("aria-pressed", String(level === 2));
  if (state.playing) startPlaying(); // restart the timer at the new speed, keeps currentT
}

function toggleSpeedLevel(level) {
  setSpeedLevel(state.speedLevel === level ? 0 : level);
}

// ---------- time bar wiring ----------

function wireTimebar() {
  const track = document.getElementById("timebar-track");
  const thumb = document.getElementById("timebar-thumb");
  const playBtn = document.getElementById("play-btn");

  playBtn.addEventListener("click", togglePlay);

  document.getElementById("speed-btn-med").addEventListener("click", () => toggleSpeedLevel(1));
  document.getElementById("speed-btn-fast").addEventListener("click", () => toggleSpeedLevel(2));

  function tFromClientX(clientX) {
    const rect = track.getBoundingClientRect();
    const frac = rect.width ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
    return Math.round(frac * state.N);
  }

  let dragging = false;

  function onPointerDown(e) {
    dragging = true;
    if (state.playing) stopPlaying();
    if (thumb.setPointerCapture && e.pointerId != null) {
      try {
        thumb.setPointerCapture(e.pointerId);
      } catch (err) {}
    }
    renderAtIndex(tFromClientX(e.clientX), { animate: false });
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerMove(e) {
    if (!dragging) return;
    scheduleRenderAtIndex(tFromClientX(e.clientX), { animate: false });
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    renderAtIndex(state.currentT, { animate: true });
  }

  thumb.addEventListener("pointerdown", onPointerDown);
  track.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);

  thumb.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      renderAtIndex(state.currentT + 1);
      e.preventDefault();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      renderAtIndex(state.currentT - 1);
      e.preventDefault();
    }
  });
}

// ---------- boot ----------

function showFallback() {
  document.getElementById("fallback-panel").style.display = "block";
  document.getElementById("main-content").style.display = "none";
}

async function boot() {
  try {
    initCytoscape();
    await loadData();
    renderRealHubList();

    const raw = sessionStorage.getItem("marvelGrowUniverse");
    if (!raw) return showFallback();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return showFallback();
    }
    if (!parsed || !Array.isArray(parsed.edges) || !Array.isArray(parsed.nodeOrder) || !parsed.nodeOrder.length) {
      return showFallback();
    }

    state.universe = parsed;
    buildTimeline();

    document.getElementById("universe-label").textContent = " " + (parsed.uniName || "Unknown universe");
    document.getElementById("fallback-panel").style.display = "none";
    document.getElementById("main-content").style.display = "block";

    wireTimebar();
    renderAtIndex(0, { animate: false });
  } catch (err) {
    console.error(err);
    showFallback();
  }
}

wireModal();
boot();
