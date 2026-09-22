/* ═══════════════════════════════════════════════════════════════════════════
   THE AUDITOR — Game Logic (app.js)
   Enron Network Investigation Terminal
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Configuration ─────────────────────────────────────────────────────────
const CONFIG = {
  dataFile: "graph_data.json",
  topPercentile: 0.05,       // Top 5% counts as a correct answer
  suspicionPerWrong: 15,     // Suspicion increase per wrong audit
  maxSuspicion: 100,
  nodeBaseRadius: 3,
  nodeMaxRadius: 8,
};

// ── Day Definitions ───────────────────────────────────────────────────────
const DAYS = [
  {
    day: 1,
    metric: "out_degree",
    title: "THE LOUDEST MOUTH",
    hudLabel: "OUT-DEGREE",
    briefing: `
      <p>Agent, welcome to your first day on the investigation.</p>
      <p>We've intercepted the internal email network of Enron Corp. Your terminal now has access to a visualization of <strong>who emails whom</strong>.</p>
      <p class="objective">▸ OBJECTIVE: Find the employee who sends emails to the <em>most different people</em>.</p>
      <p>In network science, this is measured by <span class="metric-name">Out-Degree Centrality</span> — the number of unique outgoing connections a node has, normalized by the total possible connections.</p>
      <p class="hint">HINT: Look for a node with many outgoing edges. The biggest broadcaster in the network.</p>
    `,
  },
  {
    day: 2,
    metric: "closeness",
    title: "THE FASTEST ROUTE",
    hudLabel: "CLOSENESS",
    briefing: `
      <p>Good work, Agent. Day 2.</p>
      <p>Internal Affairs needs to distribute an emergency memo that reaches <strong>every employee as quickly as possible</strong>. We need to find the optimal starting point.</p>
      <p class="objective">▸ OBJECTIVE: Find the employee who has the shortest average path to everyone else.</p>
      <p>This is measured by <span class="metric-name">Closeness Centrality</span> — the inverse of the average shortest path distance from a node to all other nodes. A high closeness score means information originating here reaches the whole network fast.</p>
      <p class="hint">HINT: This person sits "in the middle" of the network — not at the periphery. They can reach anyone in just a few hops.</p>
    `,
  },
  {
    day: 3,
    metric: "betweenness",
    title: "THE INFORMATION BROKER",
    hudLabel: "BETWEENNESS",
    briefing: `
      <p>Day 3. The plot thickens.</p>
      <p>We've identified that certain employees act as <strong>critical bridges</strong> between otherwise disconnected departments. Remove them, and information flow collapses.</p>
      <p class="objective">▸ OBJECTIVE: Find the employee who sits on the most shortest paths between other pairs of employees.</p>
      <p>This is measured by <span class="metric-name">Betweenness Centrality</span> — the fraction of all shortest paths in the network that pass through a given node. This person is the gatekeeper, the bottleneck, the broker.</p>
      <p class="hint">HINT: Look for a node that connects different clusters. Remove it, and the network fragments.</p>
    `,
  },
  {
    day: 4,
    metric: "eigenvector",
    title: "THE SHADOW BOSS",
    hudLabel: "EIGENVECTOR",
    briefing: `
      <p>Final day, Agent. This is the hard one.</p>
      <p>Some employees don't have the most connections — but they're connected to the <strong>most powerful people</strong>. They wield influence through their network of influential contacts.</p>
      <p class="objective">▸ OBJECTIVE: Find the employee whose connections are themselves highly connected and influential.</p>
      <p>This is measured by <span class="metric-name">Eigenvector Centrality</span> — a recursive measure where a node's importance depends on the importance of its neighbors. It's not about quantity of connections, but <em>quality</em>.</p>
      <p class="hint">HINT: This person may not be the most connected, but their neighbors are VIPs. Think: "It's not what you know, it's who you know."</p>
    `,
  },
];

// ── Game State ────────────────────────────────────────────────────────────
const State = {
  graphData: null,
  currentDay: 0,
  suspicion: 0,
  totalAudits: 0,
  selectedNode: null,
  adjacencyMap: null,    // node id -> Set of neighbor ids
  svg: null,
  simulation: null,
  zoom: null,
  g: null,               // main svg group (for zoom transform)
  nodeElements: null,
  edgeElements: null,
  labelElements: null,
  width: 0,
  height: 0,
};

// ── Game Module ───────────────────────────────────────────────────────────
const Game = {

  // ── Initialization ────────────────────────────────────────────────────
  async init() {
    await Game.runBootSequence();
  },

  async runBootSequence() {
    const log = document.getElementById("boot-log");
    const lines = [
      ["[SYS] Initializing secure terminal...", ""],
      ["[SYS] Loading encryption modules... ", "ok"],
      ["[NET] Connecting to Enron internal servers...", ""],
      ["[NET] Intercepting email metadata...", "ok"],
      ["[DAT] Fetching network graph data...", ""],
    ];

    for (const [text, status] of lines) {
      await Game.sleep(300 + Math.random() * 400);
      const div = document.createElement("div");
      div.className = "log-line";
      div.innerHTML = text + (status ? ` <span class="log-ok">[${status.toUpperCase()}]</span>` : "");
      log.appendChild(div);
    }

    // Actually load the data
    try {
      const resp = await fetch(CONFIG.dataFile);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      State.graphData = await resp.json();
    } catch (err) {
      const div = document.createElement("div");
      div.className = "log-line log-warn";
      div.textContent = `[ERR] Failed to load ${CONFIG.dataFile}: ${err.message}`;
      log.appendChild(div);

      const div2 = document.createElement("div");
      div2.className = "log-line log-warn";
      div2.textContent = "[ERR] Run data_builder.py first to generate graph_data.json";
      log.appendChild(div2);
      return;
    }

    // Build adjacency map (undirected for neighbor highlighting)
    State.adjacencyMap = new Map();
    for (const node of State.graphData.nodes) {
      State.adjacencyMap.set(node.id, new Set());
    }
    for (const edge of State.graphData.edges) {
      const src = typeof edge.source === "object" ? edge.source.id : edge.source;
      const tgt = typeof edge.target === "object" ? edge.target.id : edge.target;
      State.adjacencyMap.get(src)?.add(tgt);
      State.adjacencyMap.get(tgt)?.add(src);
    }

    await Game.sleep(300);
    const okLine = document.createElement("div");
    okLine.className = "log-line log-ok";
    okLine.innerHTML = `[DAT] Loaded ${State.graphData.nodes.length} employees, ${State.graphData.edges.length} connections <span class="log-ok">[OK]</span>`;
    log.appendChild(okLine);

    await Game.sleep(200);
    const readyLine = document.createElement("div");
    readyLine.className = "log-line log-ok";
    readyLine.textContent = "[SYS] Terminal ready. Awaiting operator.";
    log.appendChild(readyLine);

    await Game.sleep(400);
    document.getElementById("btn-start").classList.remove("hidden");
  },

  // ── Screen Management ─────────────────────────────────────────────────
  showScreen(id) {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById(id).classList.add("active");
  },

  startBriefing() {
    const day = DAYS[State.currentDay];
    document.getElementById("day-label").textContent = `DAY ${day.day}`;
    document.getElementById("briefing-body").innerHTML = day.briefing;
    Game.showScreen("briefing-screen");
  },

  // ── Start a Day ───────────────────────────────────────────────────────
  startDay() {
    const day = DAYS[State.currentDay];
    document.getElementById("hud-day").textContent = day.day;
    document.getElementById("hud-target").textContent = day.hudLabel;
    Game.updateSuspicionUI();
    Game.showScreen("game-screen");
    Game.closeInfoPanel();
    State.selectedNode = null;

    if (!State.svg) {
      Game.initGraph();
    } else {
      // Reset visual state for new day
      Game.resetNodeStyles();
    }
  },

  // ── D3 Graph Initialization ───────────────────────────────────────────
  initGraph() {
    const container = document.getElementById("graph-container");
    State.width = container.clientWidth;
    State.height = container.clientHeight;

    // Create SVG
    State.svg = d3.select("#graph-container")
      .append("svg")
      .attr("width", State.width)
      .attr("height", State.height);

    // Zoom behavior
    State.zoom = d3.zoom()
      .scaleExtent([0.3, 5])
      .on("zoom", (event) => {
        State.g.attr("transform", event.transform);
      });
    State.svg.call(State.zoom);

    // Click on background to deselect
    State.svg.on("click", () => {
      Game.closeInfoPanel();
    });

    // Main group for zoom/pan
    State.g = State.svg.append("g");

    // Prepare data copies for D3 — pre-position in a circle to avoid explosion
    const nodes = State.graphData.nodes.map((d, i, arr) => {
      const angle = (2 * Math.PI * i) / arr.length + (Math.random() - 0.5) * 0.5;
      const radius = 150 + Math.random() * 200;
      return {
        ...d,
        x: State.width / 2 + Math.cos(angle) * radius,
        y: State.height / 2 + Math.sin(angle) * radius,
      };
    });
    const edges = State.graphData.edges.map(d => ({
      source: d.source,
      target: d.target,
    }));

    // Store full edge list for neighbor lookups, but only render subset
    State.allEdges = edges;

    // Draw edges (all of them — but they're invisible by default via CSS)
    State.edgeElements = State.g.append("g")
      .attr("class", "edges")
      .selectAll("line")
      .data(edges)
      .join("line")
      .attr("class", "edge-line");

    // Draw nodes — size by current day's metric
    const day = DAYS[State.currentDay];
    State.nodeElements = State.g.append("g")
      .attr("class", "nodes")
      .selectAll("circle")
      .data(nodes)
      .join("circle")
      .attr("class", "node-dot")
      .attr("r", d => CONFIG.nodeBaseRadius + d.metrics[day.metric] * (CONFIG.nodeMaxRadius - CONFIG.nodeBaseRadius))
      .attr("fill", d => {
        const v = d.metrics[day.metric];
        const g = Math.floor(100 + v * 155);
        return `rgb(0, ${g}, 0)`;
      })
      .style("filter", d => {
        const v = d.metrics[day.metric];
        return v > 0.5 ? `drop-shadow(0 0 ${2 + v * 4}px rgba(51,255,51,${0.3 + v * 0.5}))` : "none";
      })
      .on("mouseover", Game.onNodeHover)
      .on("mousemove", Game.onNodeHoverMove)
      .on("mouseout", Game.onNodeHoverOut)
      .on("click", Game.onNodeClick);

    // Node labels (hidden by default, shown on hover/select)
    State.labelElements = State.g.append("g")
      .attr("class", "labels")
      .selectAll("text")
      .data(nodes)
      .join("text")
      .attr("class", "node-label")
      .attr("dx", 8)
      .attr("dy", 3)
      .text(d => d.name);

    // ── Force simulation ──────────────────────────────────────────────
    // With 17K edges, forceLink collapses everything into a blob.
    // Instead: use only charge repulsion + collision + centering.
    // We sample a small subset of edges for a gentle link force to
    // keep connected structure visible without crushing the layout.
    const maxSimLinks = 600;
    let simLinks = [];
    if (edges.length > maxSimLinks) {
      // Sample edges biased toward lower-degree nodes (more structural)
      const shuffled = edges.slice().sort(() => Math.random() - 0.5);
      simLinks = shuffled.slice(0, maxSimLinks);
    } else {
      simLinks = edges.slice();
    }

    State.simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(simLinks).id(d => d.id).distance(60).strength(0.05))
      .force("charge", d3.forceManyBody().strength(-120).distanceMax(400))
      .force("center", d3.forceCenter(State.width / 2, State.height / 2))
      .force("collision", d3.forceCollide().radius(12).strength(0.8))
      .force("x", d3.forceX(State.width / 2).strength(0.03))
      .force("y", d3.forceY(State.height / 2).strength(0.03))
      .alphaDecay(0.015)
      .velocityDecay(0.4)
      .on("tick", Game.onTick);

    // Drag behavior
    State.nodeElements.call(
      d3.drag()
        .on("start", Game.onDragStart)
        .on("drag", Game.onDrag)
        .on("end", Game.onDragEnd)
    );

    // Handle window resize
    window.addEventListener("resize", Game.onResize);
  },

  onTick() {
    State.edgeElements
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x)
      .attr("y2", d => d.target.y);

    State.nodeElements
      .attr("cx", d => d.x)
      .attr("cy", d => d.y);

    State.labelElements
      .attr("x", d => d.x)
      .attr("y", d => d.y);
  },

  // ── Drag Handlers ─────────────────────────────────────────────────────
  onDragStart(event, d) {
    if (!event.active) State.simulation.alphaTarget(0.1).restart();
    d.fx = d.x;
    d.fy = d.y;
  },
  onDrag(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  },
  onDragEnd(event, d) {
    if (!event.active) State.simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  },

  // ── Hover Handlers ────────────────────────────────────────────────────
  onNodeHover(event, d) {
    const tooltip = document.getElementById("tooltip");
    document.getElementById("tooltip-name").textContent = d.name;
    const neighbors = State.adjacencyMap.get(d.id);
    document.getElementById("tooltip-detail").textContent =
      `ID: ${d.id} | Connections: ${neighbors ? neighbors.size : 0}`;
    tooltip.style.display = "block";
    tooltip.style.left = (event.clientX + 14) + "px";
    tooltip.style.top = (event.clientY - 10) + "px";

    // Show edges for hovered node (only if nothing is selected)
    if (!State.selectedNode) {
      State.edgeElements.classed("highlighted", e => {
        const src = typeof e.source === "object" ? e.source.id : e.source;
        const tgt = typeof e.target === "object" ? e.target.id : e.target;
        return src === d.id || tgt === d.id;
      });
      State.nodeElements.classed("neighbor", n => neighbors && neighbors.has(n.id) && n.id !== d.id);
      State.labelElements.classed("visible", n => n.id === d.id || (neighbors && neighbors.has(n.id)));
    }
  },
  onNodeHoverMove(event) {
    const tooltip = document.getElementById("tooltip");
    tooltip.style.left = (event.clientX + 14) + "px";
    tooltip.style.top = (event.clientY - 10) + "px";
  },
  onNodeHoverOut() {
    document.getElementById("tooltip").style.display = "none";
    // Clear hover highlight (only if nothing is selected)
    if (!State.selectedNode) {
      State.edgeElements.classed("highlighted", false);
      State.nodeElements.classed("neighbor", false);
      State.labelElements.classed("visible", false);
    }
  },

  // ── Node Click ────────────────────────────────────────────────────────
  onNodeClick(event, d) {
    event.stopPropagation();
    State.selectedNode = d;
    Game.resetNodeStyles();
    Game.highlightNode(d);
    Game.showInfoPanel(d);
  },

  highlightNode(d) {
    const neighbors = State.adjacencyMap.get(d.id) || new Set();

    // Highlight edges connected to this node
    State.edgeElements.classed("highlighted", e => {
      const src = typeof e.source === "object" ? e.source.id : e.source;
      const tgt = typeof e.target === "object" ? e.target.id : e.target;
      return src === d.id || tgt === d.id;
    });

    // Highlight node and neighbors
    State.nodeElements
      .classed("selected", n => n.id === d.id)
      .classed("neighbor", n => neighbors.has(n.id) && n.id !== d.id);

    // Show labels for selected + neighbors
    State.labelElements
      .classed("visible", n => n.id === d.id || neighbors.has(n.id));
  },

  resetNodeStyles() {
    State.edgeElements.classed("highlighted", false);
    State.nodeElements
      .classed("selected", false)
      .classed("neighbor", false)
      .classed("winner", false);
    State.labelElements.classed("visible", false);

    // Update node sizes/colors for current day's metric
    const day = DAYS[State.currentDay];
    State.nodeElements
      .attr("r", d => CONFIG.nodeBaseRadius + d.metrics[day.metric] * (CONFIG.nodeMaxRadius - CONFIG.nodeBaseRadius))
      .attr("fill", d => {
        const v = d.metrics[day.metric];
        const g = Math.floor(100 + v * 155);
        return `rgb(0, ${g}, 0)`;
      })
      .style("filter", d => {
        const v = d.metrics[day.metric];
        return v > 0.5 ? `drop-shadow(0 0 ${2 + v * 4}px rgba(51,255,51,${0.3 + v * 0.5}))` : "none";
      });
  },

  // ── Info Panel ────────────────────────────────────────────────────────
  showInfoPanel(d) {
    const panel = document.getElementById("info-panel");
    const body = document.getElementById("info-body");
    const neighbors = State.adjacencyMap.get(d.id);
    const nCount = neighbors ? neighbors.size : 0;

    const metrics = [
      ["In-Degree",    d.metrics.in_degree],
      ["Out-Degree",   d.metrics.out_degree],
      ["Betweenness",  d.metrics.betweenness],
      ["Closeness",    d.metrics.closeness],
      ["Eigenvector",  d.metrics.eigenvector],
    ];

    body.innerHTML = `
      <div class="info-name">${d.name}</div>
      ${metrics.map(([label, val]) => `
        <div class="info-row">
          <span class="info-label">${label}</span>
          <span>
            <span class="info-val">${val.toFixed(3)}</span>
            <span class="info-bar"><span class="info-bar-fill" style="width:${val * 100}%"></span></span>
          </span>
        </div>
      `).join("")}
      <div class="info-connections">⚡ ${nCount} direct connections</div>
    `;
    panel.classList.remove("hidden");
  },

  closeInfoPanel() {
    document.getElementById("info-panel").classList.add("hidden");
    State.selectedNode = null;
    if (State.edgeElements) Game.resetNodeStyles();
  },

  // ── Audit Logic ───────────────────────────────────────────────────────
  auditSelected() {
    if (!State.selectedNode) return;

    const day = DAYS[State.currentDay];
    const metric = day.metric;
    const nodeScore = State.selectedNode.metrics[metric];

    State.totalAudits++;
    document.getElementById("hud-audits").textContent = State.totalAudits;

    // Determine threshold: top 5%
    const allScores = State.graphData.nodes.map(n => n.metrics[metric]).sort((a, b) => b - a);
    const cutoffIndex = Math.max(1, Math.floor(allScores.length * CONFIG.topPercentile));
    const threshold = allScores[cutoffIndex - 1];

    if (nodeScore >= threshold) {
      Game.winDay();
    } else {
      Game.failAudit(nodeScore, threshold);
    }
  },

  winDay() {
    const day = DAYS[State.currentDay];
    const node = State.selectedNode;

    // Highlight the winner
    State.nodeElements.classed("winner", d => d.id === node.id);

    // Show success overlay
    document.getElementById("success-msg").textContent = "ACCESS GRANTED";
    document.getElementById("success-detail").innerHTML = `
      <strong>${node.name}</strong> confirmed as target.<br/>
      ${day.hudLabel} score: <strong>${node.metrics[day.metric].toFixed(4)}</strong><br/>
      <em>Day ${day.day} complete.</em>
    `;

    // Show or hide next day button
    const btnNext = document.getElementById("btn-next-day");
    if (State.currentDay >= DAYS.length - 1) {
      btnNext.textContent = "▶ VIEW FINAL REPORT";
      btnNext.onclick = () => Game.gameOver(true);
    } else {
      btnNext.textContent = "▶ NEXT DAY";
      btnNext.onclick = () => Game.nextDay();
    }

    document.getElementById("flash-success").classList.remove("hidden");
  },

  failAudit(score, threshold) {
    State.suspicion += CONFIG.suspicionPerWrong;
    Game.updateSuspicionUI();

    const day = DAYS[State.currentDay];
    document.getElementById("fail-detail").innerHTML = `
      ${State.selectedNode.name} — ${day.hudLabel} score: ${score.toFixed(4)}<br/>
      Required: top 5% (≥ ${threshold.toFixed(4)})<br/>
      Suspicion +${CONFIG.suspicionPerWrong}%
    `;

    const overlay = document.getElementById("flash-fail");
    overlay.classList.remove("hidden");
    setTimeout(() => overlay.classList.add("hidden"), 1800);

    if (State.suspicion >= CONFIG.maxSuspicion) {
      setTimeout(() => Game.gameOver(false), 2000);
    }
  },

  updateSuspicionUI() {
    const pct = Math.min(State.suspicion, CONFIG.maxSuspicion);
    const fill = document.getElementById("suspicion-fill");
    fill.style.width = pct + "%";
    fill.className = "suspicion-fill" +
      (pct >= 80 ? " critical" : pct >= 50 ? " danger" : "");
    document.getElementById("suspicion-pct").textContent = pct + "%";
  },

  // ── Day Transitions ───────────────────────────────────────────────────
  nextDay() {
    document.getElementById("flash-success").classList.add("hidden");
    State.currentDay++;
    State.selectedNode = null;
    Game.closeInfoPanel();
    Game.startBriefing();
  },

  // ── Game Over ─────────────────────────────────────────────────────────
  gameOver(won) {
    document.getElementById("flash-success").classList.add("hidden");
    const content = document.getElementById("gameover-content");

    if (won) {
      content.innerHTML = `
        <div class="go-title win">INVESTIGATION COMPLETE</div>
        <p>Outstanding work, Agent. All targets identified.</p>
        <div class="go-stats">
          <p>Days Completed: <span>${DAYS.length}</span></p>
          <p>Total Audits: <span>${State.totalAudits}</span></p>
          <p>Final Suspicion: <span>${State.suspicion}%</span></p>
        </div>
        <br/>
        <p style="color: var(--green-dim)">You've demonstrated mastery of network centrality measures:<br/>
        Degree, Closeness, Betweenness, and Eigenvector.</p>
      `;
    } else {
      content.innerHTML = `
        <div class="go-title lose">INVESTIGATION COMPROMISED</div>
        <p style="color: var(--red)">Suspicion reached 100%. You've been detected.</p>
        <div class="go-stats">
          <p>Days Completed: <span>${State.currentDay}</span> / ${DAYS.length}</p>
          <p>Total Audits: <span>${State.totalAudits}</span></p>
        </div>
      `;
    }

    Game.showScreen("gameover-screen");
  },

  // ── Help ──────────────────────────────────────────────────────────────
  showHelp() {
    document.getElementById("help-modal").classList.remove("hidden");
  },
  closeHelp() {
    document.getElementById("help-modal").classList.add("hidden");
  },

  // ── Resize ────────────────────────────────────────────────────────────
  onResize() {
    const container = document.getElementById("graph-container");
    State.width = container.clientWidth;
    State.height = container.clientHeight;
    State.svg.attr("width", State.width).attr("height", State.height);
    State.simulation
      .force("center", d3.forceCenter(State.width / 2, State.height / 2))
      .force("x", d3.forceX(State.width / 2).strength(0.04))
      .force("y", d3.forceY(State.height / 2).strength(0.04))
      .alpha(0.3)
      .restart();
  },

  // ── Utility ───────────────────────────────────────────────────────────
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },
};

// ── Entry Point ───────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => Game.init());
