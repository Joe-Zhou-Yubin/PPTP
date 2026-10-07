// ============================================================
//  CONFIG (same as main app)
// ============================================================
const CONFIG = {
  CLASS_LIST_CSV: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQA9w2npopIp-hfmk0ZB0__Io3PDp-Ubz32G1DPgbvioLNNmXx9rqAdn9oMkdK8DnXwZeVj_OSjYG0J/pub?gid=0&single=true&output=csv',
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbzzrKpwPmurEUjwA4JjVj6Hlp7Eo2b_MNgWD6I7Wrys-2SefACRF6S7Ks9NeWH5VpP46Q/exec',
};

// ============================================================
//  STATE
// ============================================================
let simulation = null;
let showClusters = false;
let showLabels = true;
let clusterColors = [];
let nodeClusterMap = {};

const $ = (sel) => document.querySelector(sel);

// ============================================================
//  DATA FETCHING
// ============================================================
function parseCSV(text) {
  const lines = text.trim().split('\n');
  const rows = lines.slice(1).map((line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else current += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { result.push(current.trim()); current = ''; }
        else current += ch;
      }
    }
    result.push(current.trim());
    return result;
  });
  return rows;
}

async function fetchClassList() {
  const res = await fetch(CONFIG.CLASS_LIST_CSV);
  if (!res.ok) throw new Error(`Failed to fetch class list (${res.status})`);
  const text = await res.text();
  return parseCSV(text).map((r) => r[0]).filter((n) => n && n.trim());
}

async function fetchResponses() {
  const res = await fetch(CONFIG.APPS_SCRIPT_URL);
  if (!res.ok) throw new Error(`Failed to fetch responses (${res.status})`);
  const json = await res.json();
  return json.rows || [];
}

// ============================================================
//  CLUSTER DETECTION (label propagation → forced to k groups)
// ============================================================
const TARGET_CLUSTERS = 5;

function detectClusters(nodes, edges) {
  if (nodes.length === 0) return [];

  // Build adjacency list
  const adj = {};
  nodes.forEach((n) => (adj[n.id] = []));
  edges.forEach(({ source, target }) => {
    const s = typeof source === 'object' ? source.id : source;
    const t = typeof target === 'object' ? target.id : target;
    if (adj[s]) adj[s].push(t);
    if (adj[t]) adj[t].push(s);
  });

  // --- Phase 1: Label propagation ---
  // Each node starts with its own label. On each pass, adopt the most
  // common label among your neighbors. Repeat until stable.
  const label = {};
  nodes.forEach((n, i) => (label[n.id] = i));

  for (let iter = 0; iter < 20; iter++) {
    let changed = false;
    // Shuffle node order each iteration for better convergence
    const shuffled = [...nodes].sort(() => Math.random() - 0.5);

    shuffled.forEach((n) => {
      const neighbors = adj[n.id];
      if (neighbors.length === 0) return;

      // Count label frequencies among neighbors
      const freq = {};
      neighbors.forEach((nb) => {
        const l = label[nb];
        freq[l] = (freq[l] || 0) + 1;
      });

      // Pick the most common label (ties broken randomly)
      let maxCount = 0;
      let candidates = [];
      for (const [l, count] of Object.entries(freq)) {
        if (count > maxCount) { maxCount = count; candidates = [Number(l)]; }
        else if (count === maxCount) candidates.push(Number(l));
      }

      const best = candidates[Math.floor(Math.random() * candidates.length)];
      if (label[n.id] !== best) {
        label[n.id] = best;
        changed = true;
      }
    });

    if (!changed) break;
  }

  // Group nodes by label
  const groupMap = {};
  nodes.forEach((n) => {
    const l = label[n.id];
    if (!groupMap[l]) groupMap[l] = [];
    groupMap[l].push(n.id);
  });

  let groups = Object.values(groupMap);
  // Sort largest first
  groups.sort((a, b) => b.length - a.length);

  // --- Phase 2: Force exactly TARGET_CLUSTERS groups ---

  // If too many groups, merge the smallest ones into the nearest large group
  while (groups.length > TARGET_CLUSTERS) {
    const smallest = groups.pop(); // remove smallest
    // Find which remaining group the smallest has the most connections to
    let bestGroup = 0;
    let bestScore = -1;
    groups.forEach((group, gi) => {
      const groupSet = new Set(group);
      let score = 0;
      smallest.forEach((name) => {
        adj[name]?.forEach((nb) => { if (groupSet.has(nb)) score++; });
      });
      if (score > bestScore) { bestScore = score; bestGroup = gi; }
    });
    groups[bestGroup] = groups[bestGroup].concat(smallest);
    groups.sort((a, b) => b.length - a.length);
  }

  // If too few groups, split the largest
  while (groups.length < TARGET_CLUSTERS && groups[0].length >= 2) {
    const largest = groups.shift();

    // Simple bisection: BFS from a random node to split into two halves
    const half = Math.ceil(largest.length / 2);
    const visited = new Set();
    const queue = [largest[0]];
    visited.add(largest[0]);
    const groupA = [];
    const groupB = [];
    const largestSet = new Set(largest);

    while (queue.length > 0 && groupA.length < half) {
      const cur = queue.shift();
      groupA.push(cur);
      adj[cur]?.forEach((nb) => {
        if (!visited.has(nb) && largestSet.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      });
    }

    // Everything not in groupA goes to groupB
    largest.forEach((name) => {
      if (!visited.has(name)) groupB.push(name);
    });

    // If the split actually produced two groups, use them
    if (groupA.length > 0 && groupB.length > 0) {
      groups.unshift(groupA, groupB);
    } else {
      // Can't split further, put it back
      groups.unshift(largest);
      break;
    }
    groups.sort((a, b) => b.length - a.length);
  }

  return groups;
}

// ============================================================
//  BRIDGE DETECTION (second-degree ratio)
// ============================================================
function detectBridges(nodes, edges, connectionCount) {
  // A bridge connects people from different social circles.
  // We measure this via second-degree ratio:
  //   bridgeScore = unique2ndDegree / 1stDegree
  // High score = your friends don't know each other (you bridge groups)
  // Low score = your friends are all interconnected (you're inside a clique)
  //
  // We also factor in clustering coefficient (how connected your neighbors are):
  //   clusterCoeff = actual edges among neighbors / possible edges among neighbors
  // A low clustering coefficient + high degree = strong bridge signal.

  const adj = {};
  nodes.forEach((n) => (adj[n.id] = new Set()));
  edges.forEach(({ source, target }) => {
    const s = typeof source === 'object' ? source.id : source;
    const t = typeof target === 'object' ? target.id : target;
    adj[s]?.add(t);
    adj[t]?.add(s);
  });

  const scores = [];

  nodes.forEach((n) => {
    const degree = connectionCount[n.id] || 0;
    if (degree < 2) return; // need at least 2 connections to bridge

    const neighbors = adj[n.id];

    // 2nd degree: people reachable through your friends, excluding yourself and direct friends
    const secondDegree = new Set();
    neighbors.forEach((friend) => {
      adj[friend]?.forEach((fof) => {
        if (fof !== n.id && !neighbors.has(fof)) {
          secondDegree.add(fof);
        }
      });
    });

    const secondDegreeRatio = secondDegree.size / degree;

    // Clustering coefficient: how many of your neighbors are connected to each other
    let neighborEdges = 0;
    const neighborArr = Array.from(neighbors);
    for (let i = 0; i < neighborArr.length; i++) {
      for (let j = i + 1; j < neighborArr.length; j++) {
        if (adj[neighborArr[i]]?.has(neighborArr[j])) {
          neighborEdges++;
        }
      }
    }
    const possibleNeighborEdges = (degree * (degree - 1)) / 2;
    const clusterCoeff = possibleNeighborEdges > 0 ? neighborEdges / possibleNeighborEdges : 0;

    // Bridge score: high 2nd-degree ratio + low clustering = strong bridge
    const bridgeScore = secondDegreeRatio * (1 - clusterCoeff);

    scores.push({ name: n.id, bridgeScore, secondDegreeRatio, clusterCoeff, degree });
  });

  // Sort by bridge score descending, return top bridges (score > 0)
  scores.sort((a, b) => b.bridgeScore - a.bridgeScore);
  return scores.filter((s) => s.bridgeScore > 0).slice(0, 5);
}

// ============================================================
//  RENDER GRAPH
// ============================================================
async function renderGraph() {
  const container = $('#graph-container');
  container.innerHTML = '';

  // Fetch data
  let classList, responses;
  try {
    [classList, responses] = await Promise.all([fetchClassList(), fetchResponses()]);
  } catch (e) {
    container.innerHTML = `<div style="padding:2rem;color:var(--text-muted)">Failed to load data: ${e.message}</div>`;
    return;
  }

  // Build graph data
  const edges = [];
  const nodeNames = new Set();
  responses.forEach((r) => {
    const source = (r.source || '').trim();
    const target = (r.target || '').trim();
    if (source && target) {
      edges.push({ source, target });
      nodeNames.add(source);
      nodeNames.add(target);
    }
  });
  classList.forEach((n) => nodeNames.add(n));

  const nodes = Array.from(nodeNames).map((name) => ({ id: name }));

  // Deduplicate edges
  const edgeSet = new Set();
  const uniqueEdges = [];
  edges.forEach(({ source, target }) => {
    const key = [source, target].sort().join('|||');
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      uniqueEdges.push({ source, target });
    }
  });

  // Connection counts
  const connectionCount = {};
  nodes.forEach((n) => (connectionCount[n.id] = 0));
  uniqueEdges.forEach(({ source, target }) => {
    connectionCount[source] = (connectionCount[source] || 0) + 1;
    connectionCount[target] = (connectionCount[target] || 0) + 1;
  });

  // ---- ANALYTICS ----
  const totalNodes = nodes.length;
  const totalEdges = uniqueEdges.length;
  const maxPossibleEdges = (totalNodes * (totalNodes - 1)) / 2;
  const density = maxPossibleEdges > 0 ? (totalEdges / maxPossibleEdges) : 0;
  const avgConn = totalNodes > 0 ? (Object.values(connectionCount).reduce((a, b) => a + b, 0) / totalNodes) : 0;
  const maxConn = Math.max(0, ...Object.values(connectionCount));

  const sorted = Object.entries(connectionCount).sort((a, b) => b[1] - a[1]);
  const mostConnected = sorted.filter(([, v]) => v === maxConn && v > 0);
  const isolated = sorted.filter(([, v]) => v === 0);

  // Clusters
  const clusters = detectClusters(nodes, uniqueEdges);
  // Cluster color palette
  const palette = [
    '#6c63ff', '#ff6b6b', '#51cf66', '#fcc419', '#22b8cf',
    '#e599f7', '#ff922b', '#20c997', '#748ffc', '#f06595',
    '#a9e34b', '#4dabf7', '#e8590c', '#845ef7', '#15aabf',
  ];

  nodeClusterMap = {};
  clusterColors = [];
  clusters.forEach((cluster, i) => {
    const color = cluster.length > 1 ? palette[i % palette.length] : '#333';
    clusterColors.push(color);
    cluster.forEach((name) => {
      nodeClusterMap[name] = { index: i, color, size: cluster.length };
    });
  });

  // Bridges
  const bridges = detectBridges(nodes, uniqueEdges, connectionCount);

  // ---- POPULATE SIDEBAR ----
  $('#stat-nodes').textContent = totalNodes;
  $('#stat-edges').textContent = totalEdges;
  $('#stat-density').textContent = (density * 100).toFixed(1) + '%';
  $('#stat-avg').textContent = avgConn.toFixed(1);

  // Most connected
  const mcEl = $('#insight-most-connected');
  mcEl.innerHTML = mostConnected.length > 0
    ? mostConnected.map(([name, count]) => `
        <div class="insight-item" data-name="${name}">
          <span class="name">${name}</span>
          <span class="badge">${count}</span>
        </div>`).join('')
    : '<div style="color:var(--text-muted);font-size:0.8rem">No connections yet</div>';

  // Bridges
  const brEl = $('#insight-bridges');
  brEl.innerHTML = bridges.length > 0
    ? bridges.map((b) => `
        <div class="insight-item" data-name="${b.name}">
          <span class="name">${b.name}</span>
          <span class="badge" title="2nd° ratio: ${b.secondDegreeRatio.toFixed(1)} | Clustering: ${(b.clusterCoeff * 100).toFixed(0)}%">${b.bridgeScore.toFixed(1)}</span>
        </div>`).join('')
    : '<div style="color:var(--text-muted);font-size:0.8rem">None detected</div>';

  // Isolated
  const isoEl = $('#insight-isolated');
  isoEl.innerHTML = isolated.length > 0
    ? isolated.map(([name]) => `
        <div class="insight-item isolated" data-name="${name}">
          <span class="name">${name}</span>
        </div>`).join('')
    : '<div style="color:var(--text-muted);font-size:0.8rem">Everyone is connected!</div>';

  // Clusters
  const clEl = $('#insight-clusters');
  clEl.innerHTML = clusters.map((cluster, i) => {
    const color = palette[i % palette.length];
    return `
      <div class="cluster-item" data-cluster="${i}">
        <span class="cluster-dot" style="background:${color}"></span>
        <span>Group ${i + 1}: ${cluster.slice(0, 3).join(', ')}${cluster.length > 3 ? '…' : ''}</span>
        <span class="members">${cluster.length}</span>
      </div>`;
  }).join('');

  // Ranking
  const rankEl = $('#insight-ranking');
  rankEl.innerHTML = sorted.slice(0, 15).map(([name, count], i) => `
    <div class="insight-item" data-name="${name}">
      <span class="name"><span style="color:var(--text-muted);margin-right:0.4rem">${i + 1}.</span>${name}</span>
      <span class="badge">${count}</span>
    </div>`).join('');

  // ---- D3 GRAPH ----
  const rect = container.getBoundingClientRect();
  const width = rect.width || 800;
  const height = rect.height || 600;

  const svg = d3.select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', [0, 0, width, height]);

  const tooltip = $('#tooltip');
  const zoomGroup = svg.append('g');

  const zoom = d3.zoom()
    .scaleExtent([0.2, 5])
    .on('zoom', (event) => zoomGroup.attr('transform', event.transform));
  svg.call(zoom);

  const radiusScale = d3.scaleSqrt()
    .domain([0, Math.max(1, maxConn)])
    .range([8, 30]);

  const defaultColorScale = d3.scaleSequential(d3.interpolateViridis)
    .domain([0, Math.max(1, maxConn)]);

  function getNodeColor(d) {
    if (connectionCount[d.id] === 0) return '#333';
    if (showClusters) return nodeClusterMap[d.id]?.color || '#333';
    return defaultColorScale(connectionCount[d.id]);
  }

  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(uniqueEdges).id((d) => d.id).distance(100))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius((d) => radiusScale(connectionCount[d.id]) + 5));

  const link = zoomGroup.append('g')
    .selectAll('line')
    .data(uniqueEdges)
    .join('line')
    .attr('class', 'link')
    .attr('stroke-width', 1.5);

  const node = zoomGroup.append('g')
    .selectAll('g')
    .data(nodes)
    .join('g')
    .attr('class', 'node')
    .call(d3.drag()
      .on('start', (event) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      })
      .on('drag', (event) => {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
      })
      .on('end', (event) => {
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
      }));

  const circles = node.append('circle')
    .attr('r', (d) => radiusScale(connectionCount[d.id]))
    .attr('fill', getNodeColor);

  const labels = node.append('text')
    .text((d) => d.id)
    .attr('dy', (d) => radiusScale(connectionCount[d.id]) + 14)
    .style('font-size', '10px');

  // Hover
  node.on('mouseenter', (event, d) => {
    const connected = new Set();
    uniqueEdges.forEach((e) => {
      if (e.source.id === d.id) connected.add(e.target.id);
      if (e.target.id === d.id) connected.add(e.source.id);
    });
    node.classed('highlighted', (n) => n.id === d.id || connected.has(n.id));
    node.classed('dimmed', (n) => n.id !== d.id && !connected.has(n.id));
    link.classed('highlighted', (l) => l.source.id === d.id || l.target.id === d.id);
    link.classed('dimmed', (l) => l.source.id !== d.id && l.target.id !== d.id);

    const connNames = Array.from(connected);
    const clusterInfo = showClusters && nodeClusterMap[d.id]
      ? `<div style="margin-top:0.3rem;font-size:0.72rem;color:${nodeClusterMap[d.id].color}">Cluster ${nodeClusterMap[d.id].index + 1} (${nodeClusterMap[d.id].size} people)</div>`
      : '';
    tooltip.innerHTML = `
      <div class="name">${d.id}</div>
      <div class="connections">${connNames.length > 0 ? connNames.join(', ') : 'No connections yet'}</div>
      <div style="margin-top:0.2rem;font-size:0.72rem;color:var(--text-muted)">${connectionCount[d.id]} connection${connectionCount[d.id] !== 1 ? 's' : ''}</div>
      ${clusterInfo}
    `;
    tooltip.classList.add('visible');
  });

  node.on('mousemove', (event) => {
    tooltip.style.left = event.pageX + 15 + 'px';
    tooltip.style.top = event.pageY - 10 + 'px';
  });

  node.on('mouseleave', () => {
    node.classed('highlighted', false).classed('dimmed', false);
    link.classed('highlighted', false).classed('dimmed', false);
    tooltip.classList.remove('visible');
  });

  // Tick
  simulation.on('tick', () => {
    link.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
    node.attr('transform', (d) => `translate(${d.x},${d.y})`);
  });

  // ---- SIDEBAR CLICK → HIGHLIGHT NODE ----
  document.querySelectorAll('.insight-item[data-name]').forEach((el) => {
    el.addEventListener('click', () => {
      const name = el.dataset.name;
      const target = nodes.find((n) => n.id === name);
      if (!target) return;

      // Highlight this node
      const connected = new Set();
      uniqueEdges.forEach((e) => {
        if (e.source.id === name) connected.add(e.target.id);
        if (e.target.id === name) connected.add(e.source.id);
      });
      node.classed('highlighted', (n) => n.id === name || connected.has(n.id));
      node.classed('dimmed', (n) => n.id !== name && !connected.has(n.id));
      link.classed('highlighted', (l) => l.source.id === name || l.target.id === name);
      link.classed('dimmed', (l) => l.source.id !== name && l.target.id !== name);

      // Pan to the node
      const transform = d3.zoomIdentity
        .translate(width / 2, height / 2)
        .scale(1.5)
        .translate(-target.x, -target.y);
      svg.transition().duration(500).call(zoom.transform, transform);
    });
  });

  // Cluster item click → highlight cluster
  document.querySelectorAll('.cluster-item[data-cluster]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.cluster);
      const members = new Set(clusters[idx]);
      node.classed('highlighted', (n) => members.has(n.id));
      node.classed('dimmed', (n) => !members.has(n.id));
      link.classed('highlighted', (l) => members.has(l.source.id) && members.has(l.target.id));
      link.classed('dimmed', (l) => !(members.has(l.source.id) && members.has(l.target.id)));
    });
  });

  // ---- CONTROLS ----
  $('#btn-reset-view').onclick = () => {
    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
    node.classed('highlighted', false).classed('dimmed', false);
    link.classed('highlighted', false).classed('dimmed', false);
  };

  $('#btn-toggle-clusters').onclick = () => {
    showClusters = !showClusters;
    const btn = $('#btn-toggle-clusters');
    btn.textContent = showClusters ? 'Hide clusters' : 'Show clusters';
    btn.classList.toggle('active', showClusters);
    circles.transition().duration(400).attr('fill', getNodeColor);
    $('#cluster-section').style.display = showClusters ? 'block' : 'none';
  };

  $('#btn-toggle-labels').onclick = () => {
    showLabels = !showLabels;
    const btn = $('#btn-toggle-labels');
    btn.textContent = showLabels ? 'Hide labels' : 'Show labels';
    labels.transition().duration(300).style('opacity', showLabels ? 1 : 0);
  };

  $('#btn-refresh').onclick = () => renderGraph();
}

// ============================================================
//  INIT
// ============================================================
renderGraph().then(() => {
  // If ?p= param is set, highlight that person after graph loads
  const params = new URLSearchParams(window.location.search);
  const person = params.get('p');
  if (person) {
    // Wait for simulation to settle a bit, then highlight + pan
    setTimeout(() => {
      const el = document.querySelector(`.insight-item[data-name="${CSS.escape(person)}"]`);
      if (el) el.click();
    }, 1500);
  }
});
