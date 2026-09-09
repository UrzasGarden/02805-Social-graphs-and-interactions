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

const state = {
  realNodes: new Map(), // id -> name
  realDegree: new Map(), // id -> number
  realAdj: new Map(), // id -> Set(id)
  realTopHubs: [],
  growing: {
    nodes: new Map(), // id -> {id, name, degree}
    endpointPool: [],
    remainingPool: [],
    issue: 0,
    alertedHubs: new Set(),
    alertedPairs: new Set(),
  },
  m: 2,
  mode: "preferential",
  speed: 1,
  isPlaying: false,
  modalOpen: false,
  pendingEvents: [],
  newsstand: [],
  timerId: null,
  cy: null,
  imageCache: new Map(),
  currentModalUid: null,
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

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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

// ---------- data loading ----------

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
    .slice(0, 8);
}

// ---------- cytoscape ----------

function initCytoscape() {
  state.cy = cytoscape({
    container: document.getElementById("cy"),
    elements: [],
    style: [
      {
        selector: "node",
        style: {
          label: "data(label)",
          color: "#e7ecf5",
          "font-size": "11px",
          "text-valign": "bottom",
          "text-margin-y": 5,
          "text-outline-width": 2,
          "text-outline-color": "#0f1420",
          "background-color": "mapData(degree, 0, 26, #6c8dff, #ff5b7f)",
          width: "mapData(degree, 0, 26, 12, 56)",
          height: "mapData(degree, 0, 26, 12, 56)",
          "border-width": 2,
          "border-color": "#0f1420",
        },
      },
      {
        selector: "edge",
        style: {
          width: 1.4,
          "line-color": "#2a3346",
          "curve-style": "haystack",
          "haystack-radius": 0,
          opacity: 0.55,
        },
      },
      { selector: "node.hub-flag", style: { "border-color": "#ffd23f", "border-width": 4 } },
      { selector: "node.highlight", style: { "border-color": "#7fd0ff", "border-width": 4 } },
      { selector: "edge.highlight", style: { "line-color": "#7fd0ff", opacity: 1, width: 2.4 } },
      { selector: ".fade", style: { opacity: 0.12 } },
    ],
    layout: { name: "grid" },
    wheelSensitivity: 0.25,
  });

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

// ---------- growth mechanics ----------

function sampleTargets(mWanted) {
  const existingIds = Array.from(state.growing.nodes.keys());
  const k = Math.min(mWanted, existingIds.length);
  const chosen = new Set();
  let guard = 0;
  while (chosen.size < k && guard < 4000) {
    guard++;
    let candidate;
    if (state.mode === "uniform" || state.growing.endpointPool.length === 0) {
      candidate = existingIds[Math.floor(Math.random() * existingIds.length)];
    } else {
      candidate = state.growing.endpointPool[Math.floor(Math.random() * state.growing.endpointPool.length)];
    }
    chosen.add(candidate);
  }
  return Array.from(chosen);
}

function degreeStats() {
  const degrees = Array.from(state.growing.nodes.values()).map((n) => n.degree);
  const mean = degrees.reduce((s, d) => s + d, 0) / (degrees.length || 1);
  const variance = degrees.reduce((s, d) => s + (d - mean) ** 2, 0) / (degrees.length || 1);
  return { mean, std: Math.sqrt(variance) };
}

function hubThreshold() {
  const { mean, std } = degreeStats();
  return Math.max(HUB_MIN_DEGREE, Math.round(mean + HUB_Z * std));
}

function addGrowingNode(id, name) {
  state.growing.nodes.set(id, { id, name, degree: 0 });
  state.cy.add({ group: "nodes", data: { id, label: displayName(name), degree: 0 } });
  getCharacterImage(id); // pre-warm so any later pop-up has art ready
}

function addGrowingEdge(a, b) {
  state.cy.add({ group: "edges", data: { id: a + "__" + b, source: a, target: b } });
  state.growing.nodes.get(a).degree += 1;
  state.growing.nodes.get(b).degree += 1;
  state.cy.getElementById(a).data("degree", state.growing.nodes.get(a).degree);
  state.cy.getElementById(b).data("degree", state.growing.nodes.get(b).degree);
  state.growing.endpointPool.push(a, b);
}

function checkHubEvent(id) {
  if (state.growing.nodes.size < MIN_NODES_FOR_HUB_CHECK) return null;
  if (state.growing.alertedHubs.has(id)) return null;
  const node = state.growing.nodes.get(id);
  const threshold = hubThreshold();
  if (node.degree < threshold) return null;
  state.growing.alertedHubs.add(id);
  state.cy.getElementById(id).addClass("hub-flag");
  return {
    type: "hub",
    uid: "h" + id + "-" + state.growing.issue,
    id,
    name: node.name,
    degree: node.degree,
    realDegree: state.realDegree.get(id) || 0,
    threshold,
    issue: state.growing.issue,
    palette: pickPalette(),
    tagline: pick(SOLO_TAGLINES),
  };
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

function checkPairEvent(a, b) {
  const key = [a, b].sort().join("|");
  if (state.growing.alertedPairs.has(key)) return null;
  const realDist = realShortestPath(a, b);
  if (!(realDist === Infinity || realDist >= 5)) return null;
  state.growing.alertedPairs.add(key);
  return {
    type: "pair",
    uid: "p" + key + "-" + state.growing.issue,
    a,
    b,
    nameA: state.growing.nodes.get(a).name,
    nameB: state.growing.nodes.get(b).name,
    realDist,
    newDist: 1,
    issue: state.growing.issue,
    palette: pickPalette(),
    tagline: pick(TEAM_TAGLINES),
  };
}
function growTick() {
  if (state.growing.remainingPool.length === 0) {
    finishUniverse();
    return;
  }
  const id = state.growing.remainingPool.pop();
  const name = state.realNodes.get(id);
  const existingCount = state.growing.nodes.size;
  const mWanted = existingCount === 0 ? 0 : state.m;
  const targets = existingCount === 0 ? [] : sampleTargets(mWanted);

  addGrowingNode(id, name);
  const touched = [id];
  targets.forEach((t) => {
    addGrowingEdge(id, t);
    touched.push(t);
  });
  state.growing.issue += 1;

  const events = [];
  touched.forEach((nid) => {
    const ev = checkHubEvent(nid);
    if (ev) events.push(ev);
  });
  targets.forEach((t) => {
    const ev = checkPairEvent(id, t);
    if (ev) events.push(ev);
  });

  document.getElementById("cy-empty").style.display = "none";
  updateStats();
  renderGrowingHubList();

  if (state.growing.nodes.size < 60 || state.growing.issue % 3 === 0) {
    state.cy
      .layout({ name: "cose", animate: true, animationDuration: 350, randomize: false, fit: false, nodeRepulsion: 6000, idealEdgeLength: 70 })
      .run();
  }

  if (events.length) {
    state.pendingEvents.push(...events);
    showNextEvent();
  }
}

function finishUniverse() {
  stopGrowth();
  document.getElementById("grow-toggle").disabled = true;
  document.getElementById("step-btn").disabled = true;
  document.getElementById("complete-banner").style.display = "block";
  document.getElementById("graph-status").textContent = "Universe complete — 303 / 303";
}

// ---------- UI: stats & hub lists ----------

function updateStats() {
  document.getElementById("stat-nodes").textContent = state.growing.nodes.size + " / 303";
  document.getElementById("stat-links").textContent = state.growing.endpointPool.length / 2;
  document.getElementById("threshold-val").textContent =
    state.growing.nodes.size < MIN_NODES_FOR_HUB_CHECK ? "—" : "degree ≥ " + hubThreshold();
  document.getElementById("graph-status").textContent =
    state.growing.nodes.size + " / 303 characters · " + state.growing.endpointPool.length / 2 + " links";
}

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

function renderGrowingHubList() {
  const list = document.getElementById("growing-hub-list");
  const top = Array.from(state.growing.nodes.values())
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 8);
  if (!top.length) {
    list.innerHTML = '<li class="empty-note">Nobody has arrived yet.</li>';
    return;
  }
  list.innerHTML = "";
  const max = top[0].degree;
  top.forEach((n, i) => {
    list.appendChild(renderHubRow(i + 1, n.name, n.degree, max, state.growing.alertedHubs.has(n.id)));
  });
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
    '<text x="' + (w - 20) + '" y="26" font-size="15" fill="' + p.accent + '" stroke="' + p.ink + '" stroke-width="0.5" text-anchor="end">25¢</text>' +
    '<text x="' + w / 2 + '" y="' + (h - 96) + '" font-size="' + fontSize + '" fill="#ffffff" stroke="' + p.ink + '" stroke-width="1.2" text-anchor="middle">' + title + "</text>" +
    '<text x="' + w / 2 + '" y="' + (h - 62) + '" font-size="14" fill="' + p.accent + '" text-anchor="middle" letter-spacing="1">' + escapeXML(ev.tagline) + "</text>" +
    '<text x="' + w / 2 + '" y="' + (h - 30) + '" font-size="10" fill="#ffffff" text-anchor="middle" opacity="0.85" font-family="-apple-system, sans-serif">ALT-VERSE COMICS · AI mock cover, generated live</text>' +
    "</g>" +
    "</svg>"
  );
}
// ---------- modal / newsstand ----------

function eventSubtitleAndTitle(ev) {
  if (ev.type === "hub") {
    const name = displayName(ev.name);
    const title = "In this alternative Marvel Universe, <b>" + escapeXML(name) + "</b> is a hub!";
    return { title, text: "" };
  }
  const nameA = displayName(ev.nameA);
  const nameB = displayName(ev.nameB);
  const title =
    "In this alternative Marvel Universe, <b>" + escapeXML(nameA) + "</b> and <b>" + escapeXML(nameB) +
    "</b> are strongly connected!";
  let text;
  if (ev.realDist === Infinity) {
    text =
      nameA + " and " + nameB + " aren't even in the same connected part of the real Marvel wiki-network — " +
      "there's no path between them at all. In this alternate universe, chance just wired them directly together.";
  } else {
    text =
      "In the real Marvel wiki-network, " + nameA + " and " + nameB + " are " + ev.realDist +
      " hops apart — practically strangers. In this alternate universe, chance just wired them directly together.";
  }
  return { title, text };
}
function buildModalStatsHTML(ev) {
  if (ev.type === "hub") {
    const multiplier = ev.realDegree > 0 ? ev.degree / ev.realDegree : null;
    const headline = multiplier === null ? "CONNECTED FROM SCRATCH" : multiplier.toFixed(1) + "× MORE CONNECTED";
    const headlineSub = multiplier === null ? "zero links in the real network" : "than in the real Marvel network";
    return (
      '<div class="hub-headline">' +
      '<div class="hub-headline-num">' + headline + '</div>' +
      '<div class="hub-headline-sub">' + headlineSub + '</div>' +
      "</div>" +
      '<div class="stat-compare secondary">' +
      '<div class="stat-compare-box"><div class="scb-num">' + ev.realDegree + '</div><div class="scb-lbl">Real Marvel network</div></div>' +
      '<div class="stat-compare-arrow">→</div>' +
      '<div class="stat-compare-box highlight"><div class="scb-num">' + ev.degree + '</div><div class="scb-lbl">This universe</div></div>' +
      "</div>"
    );
  }
  const realNum = ev.realDist === Infinity ? "None" : String(ev.realDist);
  return (
    '<div class="stat-compare">' +
    '<div class="stat-compare-box"><div class="scb-num">' + realNum + '</div><div class="scb-lbl">Shortest path — real network</div></div>' +
    '<div class="stat-compare-arrow">→</div>' +
    '<div class="stat-compare-box highlight"><div class="scb-num">' + ev.newDist + '</div><div class="scb-lbl">Shortest path — this universe</div></div>' +
    "</div>"
  );
}
function addToNewsstand(ev) {
  state.newsstand.unshift(ev);
  document.getElementById("newsstand-panel").style.display = "block";
  const grid = document.getElementById("newsstand-grid");
  const item = document.createElement("div");
  item.className = "newsstand-item";
  item.innerHTML = buildComicSVG(ev) + '<div class="caption">' + (ev.type === "hub" ? escapeXML(displayName(ev.name)) : escapeXML(displayName(ev.nameA) + " & " + displayName(ev.nameB))) + "</div>";
  item.addEventListener("click", () => openModal(ev, false));
  grid.insertBefore(item, grid.firstChild);
}

async function openModal(ev, isNew) {
  state.modalOpen = true;
  state.currentModalUid = ev.uid;
  document.getElementById("grow-toggle").disabled = true;
  document.getElementById("step-btn").disabled = true;

  const { title, text } = eventSubtitleAndTitle(ev);
  document.getElementById("modal-eyebrow").textContent =
    ev.type === "hub" ? "New hub detected · Issue #" + ev.issue : "Unlikely alliance · Issue #" + ev.issue;
  document.getElementById("modal-title").innerHTML = title;
  document.getElementById("modal-stats").innerHTML = buildModalStatsHTML(ev);
  document.getElementById("modal-text").textContent = text;
  document.getElementById("modal-cover").innerHTML = buildComicSVG(ev); // monogram fallback while art loads
  document.getElementById("modal-overlay").classList.add("open");

  const ids = ev.type === "hub" ? [ev.id] : [ev.a, ev.b];
  const images = await Promise.all(ids.map((id) => getCharacterImage(id)));
  ev.images = images;
  if (state.currentModalUid === ev.uid) {
    document.getElementById("modal-cover").innerHTML = buildComicSVG(ev);
  }

  if (isNew) addToNewsstand(ev);
}

function closeModalControlsIfIdle() {
  const disable = state.growing.remainingPool.length === 0;
  document.getElementById("grow-toggle").disabled = disable;
  document.getElementById("step-btn").disabled = disable;
}

function showNextEvent() {
  if (!state.pendingEvents.length) return;
  const ev = state.pendingEvents.shift();
  openModal(ev, true);
}

document.getElementById("modal-continue").addEventListener("click", closeModal);
document.getElementById("modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-overlay") closeModal();
});

function closeModal() {
  document.getElementById("modal-overlay").classList.remove("open");
  if (state.pendingEvents.length) {
    showNextEvent();
    return;
  }
  state.modalOpen = false;
  closeModalControlsIfIdle();
}

// ---------- growth loop control ----------

function tickLoop() {
  if (!state.modalOpen) growTick();
}

function startGrowth() {
  state.isPlaying = true;
  clearInterval(state.timerId);
  state.timerId = setInterval(tickLoop, 1000 / state.speed);
  document.getElementById("toggle-sub").textContent = "Growing…";
}

function stopGrowth() {
  state.isPlaying = false;
  clearInterval(state.timerId);
  state.timerId = null;
  document.getElementById("toggle-sub").textContent = "Paused";
}

// ---------- wiring ----------

function wireControls() {
  const growToggle = document.getElementById("grow-toggle");
  growToggle.addEventListener("change", () => {
    if (growToggle.checked) startGrowth();
    else stopGrowth();
  });

  document.getElementById("step-btn").addEventListener("click", () => {
    if (state.modalOpen) return;
    if (state.isPlaying) {
      growToggle.checked = false;
      stopGrowth();
    }
    growTick();
  });

  document.getElementById("reset-btn").addEventListener("click", resetUniverse);

  document.getElementById("speed-range").addEventListener("input", (e) => {
    state.speed = parseFloat(e.target.value);
    document.getElementById("speed-val").textContent = state.speed.toFixed(1);
    if (state.isPlaying) startGrowth();
  });

  document.getElementById("m-segmented").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-m]");
    if (!btn) return;
    document.querySelectorAll("#m-segmented button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.m = parseInt(btn.dataset.m, 10);
  });

  document.getElementById("mode-segmented").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (!btn) return;
    document.querySelectorAll("#mode-segmented button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.mode = btn.dataset.mode;
  });
}

function resetUniverse() {
  stopGrowth();
  document.getElementById("grow-toggle").checked = false;
  state.cy.elements().remove();
  state.growing.nodes = new Map();
  state.growing.endpointPool = [];
  state.growing.issue = 0;
  state.growing.alertedHubs = new Set();
  state.growing.alertedPairs = new Set();
  state.growing.remainingPool = shuffle(Array.from(state.realNodes.keys()));
  state.pendingEvents = [];
  state.newsstand = [];
  document.getElementById("newsstand-grid").innerHTML = "";
  document.getElementById("newsstand-panel").style.display = "none";
  document.getElementById("complete-banner").style.display = "none";
  document.getElementById("cy-empty").style.display = "flex";
  document.getElementById("grow-toggle").disabled = false;
  document.getElementById("step-btn").disabled = false;
  updateStats();
  renderGrowingHubList();
}

async function boot() {
  try {
    initCytoscape();
    await loadData();
    renderRealHubList();
    state.growing.remainingPool = shuffle(Array.from(state.realNodes.keys()));
    wireControls();
    updateStats();
    renderGrowingHubList();

    document.getElementById("grow-toggle").disabled = false;
    document.getElementById("step-btn").disabled = false;
    document.getElementById("reset-btn").disabled = false;
    document.getElementById("toggle-sub").textContent = "Paused";
    document.getElementById("graph-status").textContent = "0 / 303 characters · 0 links";
  } catch (err) {
    document.getElementById("graph-status").textContent = "Error: " + err.message;
    document.getElementById("toggle-sub").textContent = "Failed to load data";
    console.error(err);
  }
}

boot();
