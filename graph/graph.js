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
//  CLUSTER DETECTION (simple connected-components + modularity)
// ============================================================
function detectClusters(nodes, edges) {
  // Build adjacency list
  const adj = {};
  nodes.forEach((n) => (adj[n.id] = new Set()));
  edges.forEach(({ source, target }) => {
    const s = typeof source === 'object' ? source.id : source;
    const t = typeof target === 'object' ? target.id : target;
    adj[s]?.add(t);
    adj[t]?.add(s);
  });

  // BFS to find connected components
  const visited = new Set();
  const clusters = [];

  nodes.forEach((n) => {
    if (visited.has(n.id)) return;
    const cluster = [];
    const queue = [n.id];
    visited.add(n.id);
    while (queue.length > 0) {
      const current = queue.shift();
      cluster.push(current);
      adj[current]?.forEach((neighbor) => {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      });
    }
    clusters.push(cluster);
  });

  // Sort: largest clusters first, isolated nodes last
  clusters.sort((a, b) => b.length - a.length);

  return clusters;
}

// ============================================================
//  BRIDGE DETECTION
// ============================================================
function detectBridges(nodes, edges, connectionCount) {
  // A "bridge" person connects two otherwise separate clusters.
  // Simple heuristic: find nodes whose removal increases the number
  // of connected components. For performance, just check high-degree nodes.
  const adj = {};
  nodes.forEach((n) => (adj[n.id] = new Set()));
  edges.forEach(({ source, target }) => {
    const s = typeof source === 'object' ? source.id : source;
    const t = typeof target === 'object' ? target.id : target;
    adj[s]?.add(t);
    adj[t]?.add(s);
  });

  const baseClusters = detectClusters(nodes, edges).length;
  const bridges = [];

  // Only check nodes with 2+ connections (potential bridges)
  const candidates = nodes.filter((n) => (connectionCount[n.id] || 0) >= 2);

  candidates.forEach((n) => {
    // Count components without this node
    const visited = new Set([n.id]);
    let components = 0;
    nodes.forEach((other) => {
      if (visited.has(other.id)) return;
      components++;
      const queue = [other.id];
      visited.add(other.id);
      while (queue.length > 0) {
        const cur = queue.shift();
        adj[cur]?.forEach((nb) => {
          if (!visited.has(nb) && nb !== n.id) {
            visited.add(nb);
            queue.push(nb);
          }
        });
      }
    });
    if (components > baseClusters) {
      bridges.push(n.id);
    }
  });

  return bridges;
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
  const nonTrivialClusters = clusters.filter((c) => c.length > 1);

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
    ? bridges.map((name) => `
        <div class="insight-item" data-name="${name}">
          <span class="name">${name}</span>
          <span class="badge">${connectionCount[name]}</span>
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
  clEl.innerHTML = nonTrivialClusters.map((cluster, i) => {
    const color = palette[clusters.indexOf(cluster) % palette.length];
    return `
      <div class="cluster-item" data-cluster="${clusters.indexOf(cluster)}">
        <span class="cluster-dot" style="background:${color}"></span>
        <span>${cluster.slice(0, 3).join(', ')}${cluster.length > 3 ? '…' : ''}</span>
        <span class="members">${cluster.length} people</span>
      </div>`;
  }).join('') || '<div style="color:var(--text-muted);font-size:0.8rem">Not enough data</div>';

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
renderGraph();
