// ============================================================
//  CONFIG — UPDATE THESE WITH YOUR GOOGLE SHEET DETAILS
// ============================================================
const CONFIG = {
  // Published CSV URL for the ClassList tab
  CLASS_LIST_CSV: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQA9w2npopIp-hfmk0ZB0__Io3PDp-Ubz32G1DPgbvioLNNmXx9rqAdn9oMkdK8DnXwZeVj_OSjYG0J/pub?gid=0&single=true&output=csv',

  // Your deployed Google Apps Script web app URL (handles both reading responses and writing)
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbzzrKpwPmurEUjwA4JjVj6Hlp7Eo2b_MNgWD6I7Wrys-2SefACRF6S7Ks9NeWH5VpP46Q/exec',
};

// ============================================================
//  STATE
// ============================================================
let classList = [];
let selectedIdentity = null;
let selectedConnections = new Set();
let submittedNames = new Set(); // names that already submitted

// ============================================================
//  DOM REFS
// ============================================================
const $ = (sel) => document.querySelector(sel);
const steps = {
  identity: $('#step-identity'),
  connections: $('#step-connections'),
  loading: $('#step-loading'),
  graph: $('#step-graph'),
  error: $('#step-error'),
};

// ============================================================
//  NAVIGATION
// ============================================================
function showStep(name) {
  Object.values(steps).forEach((s) => s.classList.remove('active'));
  steps[name].classList.add('active');
}

// ============================================================
//  GOOGLE SHEETS — READ CLASS LIST (via published CSV)
// ============================================================
function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);
  return { headers, rows };
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current.trim());
  return result;
}

async function fetchClassList() {
  console.log('Fetching class list from:', CONFIG.CLASS_LIST_CSV);
  const res = await fetch(CONFIG.CLASS_LIST_CSV);
  console.log('ClassList response status:', res.status);
  if (!res.ok) throw new Error(`Failed to fetch class list (${res.status})`);
  const text = await res.text();
  console.log('ClassList CSV first 100 chars:', text.substring(0, 100));
  return parseCSV(text);
}

// ============================================================
//  GOOGLE SHEETS — READ RESPONSES (via Apps Script GET)
// ============================================================
async function fetchResponses() {
  const res = await fetch(CONFIG.APPS_SCRIPT_URL);
  if (!res.ok) throw new Error(`Failed to fetch responses (${res.status})`);
  const json = await res.json();
  if (json.status === 'error') throw new Error(json.message || 'Unknown error');
  // Convert to the same format the rest of the code expects
  const rows = json.rows.map((r) => [r.source, r.target]);
  return { headers: ['Source', 'Target'], rows };
}

// ============================================================
//  GOOGLE SHEETS — WRITE (via Apps Script POST)
// ============================================================
async function submitConnections(source, targets) {
  const payload = { source, targets };
  const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  // Apps Script redirects to a response URL — follow it
  const json = await res.json().catch(() => ({ status: 'ok' }));
  console.log('Submit response:', json);
}

// ============================================================
//  STEP 1: IDENTITY
// ============================================================
async function initIdentityStep() {
  const nameGrid = $('#name-grid');
  nameGrid.innerHTML = '<div style="color:var(--text-muted)">Loading class list…</div>';

  try {
    // Load class list
    const classData = await fetchClassList();
    classList = classData.rows.map((r) => r[0]).filter((n) => n && n.trim());

    // Render immediately — don't wait for responses
    renderNameGrid(nameGrid, classList, 'identity');

    // Load existing responses in background to mark who already submitted
    try {
      const responseData = await Promise.race([
        fetchResponses(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
      ]);
      const sources = responseData.rows.map((r) => r[0]).filter(Boolean);
      submittedNames = new Set(sources);
      // Re-render with submitted markers
      renderNameGrid(nameGrid, classList, 'identity');
    } catch (e) {
      // Responses sheet might be empty or not exist yet, that's fine
      console.log('Responses fetch skipped:', e.message);
      submittedNames = new Set();
    }
  } catch (err) {
    showError(`Could not load class list. Make sure your Google Sheet is shared as "Anyone with the link can view".\n\nError: ${err.message}`);
  }
}

function renderNameGrid(container, names, mode) {
  container.innerHTML = '';
  names.forEach((name) => {
    const chip = document.createElement('button');
    chip.className = 'name-chip';
    chip.textContent = name;
    chip.dataset.name = name;

    if (mode === 'identity') {
      // Mark already-submitted names
      if (submittedNames.has(name)) {
        chip.classList.add('submitted');
      }

      chip.addEventListener('click', () => {
        // Deselect previous
        container.querySelectorAll('.name-chip.selected').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        selectedIdentity = name;
        $('#btn-next').disabled = false;
        $('#identity-status').textContent = `Selected: ${name}`;
      });
    } else if (mode === 'connections') {
      chip.addEventListener('click', () => {
        chip.classList.toggle('selected');
        if (chip.classList.contains('selected')) {
          selectedConnections.add(name);
        } else {
          selectedConnections.delete(name);
        }
        $('#btn-submit').disabled = selectedConnections.size === 0;
        $('#connections-status').textContent = `${selectedConnections.size} connection${selectedConnections.size !== 1 ? 's' : ''} selected`;
      });
    }

    container.appendChild(chip);
  });
}

// ============================================================
//  STEP 2: CONNECTIONS
// ============================================================
function initConnectionsStep() {
  const grid = $('#connections-grid');
  const others = classList.filter((n) => n !== selectedIdentity);
  selectedConnections.clear();
  $('#btn-submit').disabled = true;
  $('#connections-status').textContent = '';
  renderNameGrid(grid, others, 'connections');
}

// ============================================================
//  SUBMIT
// ============================================================
async function handleSubmit() {
  showStep('loading');
  try {
    await submitConnections(selectedIdentity, Array.from(selectedConnections));
    // Small delay to allow Apps Script to process
    await new Promise((r) => setTimeout(r, 1500));
    await initGraph();
    showStep('graph');
  } catch (err) {
    showError(`Failed to submit. Error: ${err.message}`);
  }
}

// ============================================================
//  GRAPH
// ============================================================
let simulation = null;

async function initGraph() {
  const container = $('#graph-container');
  container.innerHTML = '';

  // Fetch all responses
  let responseData;
  try {
    responseData = await Promise.race([
      fetchResponses(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
  } catch (e) {
    // No responses yet — that's fine, we'll just show nodes with no edges
    console.log('Responses not available yet, showing nodes only:', e.message);
    responseData = { headers: ['Source', 'Target'], rows: [] };
  }

  // Build edges: each row is [Source, Target]
  const edges = [];
  const nodeNames = new Set();

  responseData.rows.forEach((row) => {
    const source = (row[0] || '').trim();
    const target = (row[1] || '').trim();
    if (source && target) {
      edges.push({ source, target });
      nodeNames.add(source);
      nodeNames.add(target);
    }
  });

  // Also add all class list names as nodes (even if no edges yet)
  classList.forEach((n) => nodeNames.add(n));

  const nodes = Array.from(nodeNames).map((name) => ({ id: name }));

  // Deduplicate edges (A→B and B→A become one undirected edge)
  const edgeSet = new Set();
  const uniqueEdges = [];
  edges.forEach(({ source, target }) => {
    const key = [source, target].sort().join('|||');
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      uniqueEdges.push({ source, target });
    }
  });

  // Count connections per node
  const connectionCount = {};
  nodes.forEach((n) => (connectionCount[n.id] = 0));
  uniqueEdges.forEach(({ source, target }) => {
    connectionCount[source] = (connectionCount[source] || 0) + 1;
    connectionCount[target] = (connectionCount[target] || 0) + 1;
  });

  // Render stats
  const totalNodes = nodes.length;
  const totalEdges = uniqueEdges.length;
  const maxConn = Math.max(0, ...Object.values(connectionCount));
  const mostConnected = Object.entries(connectionCount).filter(([, v]) => v === maxConn && v > 0).map(([k]) => k);
  const isolated = Object.entries(connectionCount).filter(([, v]) => v === 0).map(([k]) => k);

  $('#graph-stats').innerHTML = `
    <span><span class="stat-value">${totalNodes}</span> people</span>
    <span><span class="stat-value">${totalEdges}</span> connections</span>
    <span>Most connected: <span class="stat-value">${mostConnected.length > 0 ? mostConnected.join(', ') : '—'}</span> (${maxConn})</span>
    <span>Isolated: <span class="stat-value">${isolated.length}</span></span>
  `;

  // D3 force-directed graph
  const rect = container.getBoundingClientRect();
  const width = rect.width || 800;
  const height = rect.height || 500;

  const svg = d3
    .select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', [0, 0, width, height]);

  // Tooltip
  let tooltip = document.querySelector('.tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    document.body.appendChild(tooltip);
  }

  // Zoom
  const zoomGroup = svg.append('g');

  const zoom = d3.zoom()
    .scaleExtent([0.3, 4])
    .on('zoom', (event) => {
      zoomGroup.attr('transform', event.transform);
    });

  svg.call(zoom);

  // Size scale based on connections
  const radiusScale = d3.scaleSqrt()
    .domain([0, Math.max(1, maxConn)])
    .range([8, 28]);

  // Color scale
  const colorScale = d3.scaleSequential(d3.interpolateViridis)
    .domain([0, Math.max(1, maxConn)]);

  // Simulation
  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(uniqueEdges).id((d) => d.id).distance(100))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius((d) => radiusScale(connectionCount[d.id]) + 5));

  // Links
  const link = zoomGroup
    .append('g')
    .selectAll('line')
    .data(uniqueEdges)
    .join('line')
    .attr('class', 'link')
    .attr('stroke-width', 1.5);

  // Nodes
  const node = zoomGroup
    .append('g')
    .selectAll('g')
    .data(nodes)
    .join('g')
    .attr('class', 'node')
    .call(d3.drag()
      .on('start', dragStarted)
      .on('drag', dragged)
      .on('end', dragEnded));

  node
    .append('circle')
    .attr('r', (d) => radiusScale(connectionCount[d.id]))
    .attr('fill', (d) => connectionCount[d.id] > 0 ? colorScale(connectionCount[d.id]) : '#333');

  node
    .append('text')
    .text((d) => d.id)
    .attr('dy', (d) => radiusScale(connectionCount[d.id]) + 14)
    .style('font-size', '10px');

  // Hover interactions
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
    tooltip.innerHTML = `
      <div class="name">${d.id}</div>
      <div class="connections">${connNames.length > 0 ? connNames.join(', ') : 'No connections yet'}</div>
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
    link
      .attr('x1', (d) => d.source.x)
      .attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x)
      .attr('y2', (d) => d.target.y);

    node.attr('transform', (d) => `translate(${d.x},${d.y})`);
  });

  // Drag functions
  function dragStarted(event) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    event.subject.fx = event.subject.x;
    event.subject.fy = event.subject.y;
  }

  function dragged(event) {
    event.subject.fx = event.x;
    event.subject.fy = event.y;
  }

  function dragEnded(event) {
    if (!event.active) simulation.alphaTarget(0);
    event.subject.fx = null;
    event.subject.fy = null;
  }

  // Reset view button
  $('#btn-reset-view').onclick = () => {
    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
  };
}

// ============================================================
//  ERROR HANDLING
// ============================================================
function showError(msg) {
  $('#error-message').textContent = msg;
  showStep('error');
}

// ============================================================
//  EVENT LISTENERS
// ============================================================
$('#btn-next').addEventListener('click', () => {
  initConnectionsStep();
  showStep('connections');
});

$('#btn-back').addEventListener('click', () => {
  showStep('identity');
});

$('#btn-submit').addEventListener('click', handleSubmit);

$('#btn-retry').addEventListener('click', () => {
  showStep('identity');
  initIdentityStep();
});

$('#btn-refresh').addEventListener('click', async () => {
  showStep('loading');
  await initGraph();
  showStep('graph');
});

// ============================================================
//  INIT
// ============================================================
initIdentityStep();
