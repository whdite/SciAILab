from __future__ import annotations

import json


def render_project_trace_page(project_id: str, *, limit: int = 60) -> str:
    project_id_json = json.dumps(project_id)
    limit_json = json.dumps(limit)
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SciAILab Trace | {project_id}</title>
  <style>
    :root {{
      --bg: #f4efe4;
      --panel: rgba(255, 250, 241, 0.94);
      --ink: #1e2430;
      --muted: #5e6675;
      --line: rgba(30, 36, 48, 0.14);
      --accent: #0f766e;
      --accent-soft: rgba(15, 118, 110, 0.12);
      --warn: #b45309;
      --bad: #b91c1c;
      --ok: #166534;
      --shadow: 0 18px 50px rgba(30, 36, 48, 0.10);
      --font-sans: "IBM Plex Sans", "Segoe UI", sans-serif;
      --font-serif: "Iowan Old Style", "Palatino Linotype", serif;
      --font-mono: "IBM Plex Mono", Consolas, monospace;
    }}
    * {{
      box-sizing: border-box;
    }}
    body {{
      margin: 0;
      font-family: var(--font-sans);
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15, 118, 110, 0.14), transparent 32%),
        radial-gradient(circle at top right, rgba(180, 83, 9, 0.12), transparent 28%),
        linear-gradient(180deg, #f8f3ea 0%, var(--bg) 100%);
      min-height: 100vh;
    }}
    .shell {{
      max-width: 1320px;
      margin: 0 auto;
      padding: 28px 20px 40px;
    }}
    .hero {{
      display: grid;
      gap: 18px;
      margin-bottom: 20px;
      padding: 24px;
      background: var(--panel);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      border-radius: 24px;
    }}
    .eyebrow {{
      font-size: 12px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
    }}
    .hero h1 {{
      margin: 0;
      font-size: clamp(30px, 5vw, 54px);
      line-height: 0.94;
      font-family: var(--font-serif);
      font-weight: 700;
    }}
    .hero p {{
      margin: 0;
      max-width: 920px;
      color: var(--muted);
      font-size: 15px;
    }}
    .toolbar {{
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }}
    .toolbar button,
    .toolbar a,
    .toolbar select {{
      appearance: none;
      border: 1px solid var(--line);
      background: white;
      color: var(--ink);
      padding: 10px 14px;
      border-radius: 999px;
      font: inherit;
      text-decoration: none;
    }}
    .toolbar button,
    .toolbar a {{
      cursor: pointer;
    }}
    .grid {{
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 18px;
    }}
    .stack {{
      display: grid;
      gap: 18px;
    }}
    .card {{
      background: var(--panel);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      border-radius: 22px;
      padding: 20px;
    }}
    .card h2 {{
      margin: 0 0 14px;
      font-size: 18px;
    }}
    .card-head {{
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }}
    .metric-grid {{
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }}
    .metric {{
      background: white;
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px;
    }}
    .metric .label {{
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }}
    .metric .value {{
      margin-top: 6px;
      font-size: 30px;
      font-weight: 700;
    }}
    .pill-row {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }}
    .pill {{
      display: inline-flex;
      gap: 8px;
      align-items: center;
      padding: 8px 12px;
      border-radius: 999px;
      background: white;
      border: 1px solid var(--line);
      font-size: 13px;
    }}
    .pill strong {{
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }}
    .filters {{
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }}
    .filter label {{
      display: block;
      margin-bottom: 6px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--muted);
    }}
    .filter select {{
      width: 100%;
      appearance: none;
      border: 1px solid var(--line);
      background: white;
      color: var(--ink);
      padding: 10px 12px;
      border-radius: 14px;
      font: inherit;
    }}
    .status {{
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      background: var(--accent-soft);
      color: var(--accent);
    }}
    .status.blocked {{
      background: rgba(185, 28, 28, 0.12);
      color: var(--bad);
    }}
    .status.review_pending,
    .status.retry {{
      background: rgba(180, 83, 9, 0.12);
      color: var(--warn);
    }}
    .status.done,
    .status.idle,
    .status.complete,
    .status.ready {{
      background: rgba(22, 101, 52, 0.12);
      color: var(--ok);
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }}
    th, td {{
      text-align: left;
      padding: 10px 0;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }}
    th {{
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }}
    .mono {{
      font-family: var(--font-mono);
      font-size: 12px;
    }}
    .muted {{
      color: var(--muted);
    }}
    .empty {{
      color: var(--muted);
      font-style: italic;
    }}
    .timeline-toggle {{
      appearance: none;
      border: 1px solid var(--line);
      background: white;
      color: var(--ink);
      border-radius: 999px;
      padding: 6px 10px;
      font: inherit;
      cursor: pointer;
    }}
    .timeline-row.active {{
      background: rgba(15, 118, 110, 0.05);
    }}
    .timeline-details td {{
      padding: 0 0 14px;
    }}
    .details-box {{
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px;
      margin-top: -2px;
    }}
    .details-box h3 {{
      margin: 0 0 10px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }}
    .details-box pre {{
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font: 12px/1.5 var(--font-mono);
      color: var(--ink);
    }}
    @media (max-width: 960px) {{
      .grid {{
        grid-template-columns: 1fr;
      }}
      .metric-grid {{
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }}
      .filters {{
        grid-template-columns: 1fr;
      }}
    }}
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="eyebrow">SciAILab Runtime Trace</div>
      <h1 id="project-name">Loading project...</h1>
      <p id="project-goal">Fetching read model and timeline from the FastAPI runtime.</p>
      <div class="toolbar">
        <button id="refresh-button" type="button">Refresh</button>
        <a id="json-link" href="#">Open JSON</a>
        <span class="mono muted" id="project-id-line"></span>
      </div>
    </section>

    <div class="grid">
      <div class="stack">
        <section class="card">
          <h2>Project Summary</h2>
          <div class="metric-grid" id="metrics"></div>
        </section>
        <section class="card">
          <h2>Active Tasks</h2>
          <div id="active-tasks"></div>
        </section>
        <section class="card">
          <div class="card-head">
            <h2>Recent Timeline</h2>
            <span class="muted" id="timeline-count"></span>
          </div>
          <div class="filters">
            <div class="filter">
              <label for="event-type-filter">Event Type</label>
              <select id="event-type-filter"></select>
            </div>
            <div class="filter">
              <label for="status-filter">Status</label>
              <select id="status-filter"></select>
            </div>
            <div class="filter">
              <label for="owner-agent-filter">Owner Agent</label>
              <select id="owner-agent-filter"></select>
            </div>
          </div>
          <div id="timeline"></div>
        </section>
      </div>
      <div class="stack">
        <section class="card">
          <h2>Agent States</h2>
          <div id="agent-states" class="pill-row"></div>
        </section>
        <section class="card">
          <h2>Event Mix</h2>
          <div id="event-mix" class="pill-row"></div>
        </section>
        <section class="card">
          <h2>Latest Artifacts</h2>
          <div id="artifacts"></div>
        </section>
        <section class="card">
          <h2>Latest Packages</h2>
          <div id="packages"></div>
        </section>
      </div>
    </div>
  </div>

  <script>
    const projectId = {project_id_json};
    const limit = {limit_json};
    const apiUrl = `/v1/projects/${{encodeURIComponent(projectId)}}/read-model?limit=${{limit}}`;
    let currentReadModel = null;
    let expandedTimelineIds = new Set();

    document.getElementById("json-link").href = apiUrl;

    function escapeHtml(value) {{
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }}

    function statusClass(value) {{
      return `status ${{String(value || "").replace(/[^a-z0-9_-]/gi, "_")}}`;
    }}

    function renderMetrics(counts) {{
      const entries = Object.entries(counts || {{}});
      if (!entries.length) {{
        return '<div class="empty">No summary metrics yet.</div>';
      }}
      return entries.map(([label, value]) => `
        <div class="metric">
          <div class="label">${{escapeHtml(label.replaceAll("_", " "))}}</div>
          <div class="value">${{escapeHtml(value)}}</div>
        </div>
      `).join("");
    }}

    function renderPills(map) {{
      const entries = Object.entries(map || {{}});
      if (!entries.length) {{
        return '<div class="empty">No entries yet.</div>';
      }}
      return entries.map(([label, value]) => `
        <div class="pill">
          <strong>${{escapeHtml(label)}}</strong>
          <span>${{escapeHtml(value)}}</span>
        </div>
      `).join("");
    }}

    function renderActiveTasks(tasks) {{
      if (!tasks.length) {{
        return '<div class="empty">No active tasks. The project is currently quiescent.</div>';
      }}
      return `
        <table>
          <thead>
            <tr><th>Owner</th><th>Task</th><th>Status</th><th>Dependency</th></tr>
          </thead>
          <tbody>
            ${{tasks.map((task) => `
              <tr>
                <td class="mono">${{escapeHtml(task.owner_agent)}}</td>
                <td>
                  <div>${{escapeHtml(task.title)}}</div>
                  <div class="muted mono">${{escapeHtml(task.task_id)}}</div>
                </td>
                <td><span class="${{statusClass(task.status)}}">${{escapeHtml(task.status)}}</span></td>
                <td class="mono">${{escapeHtml(task.dependency || "-")}}</td>
              </tr>
            `).join("")}}
          </tbody>
        </table>
      `;
    }}

    function renderArtifacts(items) {{
      const entries = Object.entries(items || {{}});
      if (!entries.length) {{
        return '<div class="empty">No artifacts yet.</div>';
      }}
      return `
        <table>
          <thead>
            <tr><th>Type</th><th>Artifact</th><th>State</th></tr>
          </thead>
          <tbody>
            ${{entries.map(([kind, artifact]) => `
              <tr>
                <td class="mono">${{escapeHtml(kind)}}</td>
                <td>
                  <div>${{escapeHtml(artifact.artifact_id)}}</div>
                  <div class="muted mono">${{escapeHtml(artifact.path)}}</div>
                </td>
                <td><span class="${{statusClass(artifact.state)}}">${{escapeHtml(artifact.state)}}</span></td>
              </tr>
            `).join("")}}
          </tbody>
        </table>
      `;
    }}

    function renderPackages(items) {{
      const entries = Object.entries(items || {{}});
      if (!entries.length) {{
        return '<div class="empty">No packages yet.</div>';
      }}
      return `
        <table>
          <thead>
            <tr><th>Type</th><th>Package</th><th>State</th></tr>
          </thead>
          <tbody>
            ${{entries.map(([kind, pkg]) => `
              <tr>
                <td class="mono">${{escapeHtml(kind)}}</td>
                <td>
                  <div>${{escapeHtml(pkg.package_id)}}</div>
                  <div class="muted mono">${{escapeHtml(pkg.manifest_path)}}</div>
                </td>
                <td><span class="${{statusClass(pkg.state)}}">${{escapeHtml(pkg.state)}}</span></td>
              </tr>
            `).join("")}}
          </tbody>
        </table>
      `;
    }}

    function fillSelect(selectId, values, anyLabel) {{
      const select = document.getElementById(selectId);
      const options = [`<option value="">${{escapeHtml(anyLabel)}}</option>`]
        .concat((values || []).map((value) => `<option value="${{escapeHtml(value)}}">${{escapeHtml(value)}}</option>`));
      select.innerHTML = options.join("");
    }}

    function getTimelineFilters() {{
      return {{
        eventType: document.getElementById("event-type-filter").value,
        status: document.getElementById("status-filter").value,
        ownerAgent: document.getElementById("owner-agent-filter").value,
      }};
    }}

    function filteredTimelineItems(data) {{
      const filters = getTimelineFilters();
      const items = data?.trace?.timeline || [];
      return items.filter((item) => {{
        if (filters.eventType && String(item.event_type || "") !== filters.eventType) {{
          return false;
        }}
        if (filters.status && String(item.status || "") !== filters.status) {{
          return false;
        }}
        if (filters.ownerAgent && String(item.owner_agent || "") !== filters.ownerAgent) {{
          return false;
        }}
        return true;
      }});
    }}

    function renderTimeline(items) {{
      if (!items.length) {{
        return '<div class="empty">No timeline items match the current filters.</div>';
      }}
      return `
        <table>
          <thead>
            <tr><th></th><th>Time</th><th>Kind</th><th>Title</th><th>Summary</th><th>Status</th></tr>
          </thead>
          <tbody>
            ${{items.map((item) => {{
              const expanded = expandedTimelineIds.has(item.id);
              const details = JSON.stringify(item.details || {{}}, null, 2);
              return `
                <tr class="timeline-row${{expanded ? " active" : ""}}" data-item-id="${{escapeHtml(item.id)}}">
                  <td>
                    <button class="timeline-toggle" type="button" data-item-id="${{escapeHtml(item.id)}}">
                      ${{expanded ? "Hide" : "Show"}}
                    </button>
                  </td>
                  <td class="mono">${{escapeHtml(item.timestamp || "-")}}</td>
                  <td class="mono">${{escapeHtml(item.kind)}}</td>
                  <td>
                    <div>${{escapeHtml(item.title)}}</div>
                    <div class="muted mono">${{escapeHtml(item.id)}}</div>
                    <div class="muted mono">owner=${{escapeHtml(item.owner_agent || "-")}}${{item.event_type ? ` / event=${{escapeHtml(item.event_type)}}` : ""}}</div>
                  </td>
                  <td>${{escapeHtml(item.summary)}}</td>
                  <td><span class="${{statusClass(item.status)}}">${{escapeHtml(item.status || "-")}}</span></td>
                </tr>
                ${{expanded ? `
                  <tr class="timeline-details">
                    <td colspan="6">
                      <div class="details-box">
                        <h3>Payload / Metadata Details</h3>
                        <pre>${{escapeHtml(details)}}</pre>
                      </div>
                    </td>
                  </tr>
                ` : ""}}
              `;
            }}).join("")}}
          </tbody>
        </table>
      `;
    }}

    function renderReadModel(data) {{
      document.getElementById("project-name").textContent = data.project.name;
      document.getElementById("project-goal").textContent = data.project.goal || "No project goal recorded.";
      document.getElementById("project-id-line").textContent = `project_id=${{data.project.project_id}}`;
      document.getElementById("metrics").innerHTML = renderMetrics(data.summary.counts);
      document.getElementById("active-tasks").innerHTML = renderActiveTasks(data.read_model.active_tasks || []);
      document.getElementById("agent-states").innerHTML = renderPills(
        Object.fromEntries((data.read_model.agent_states || []).map((item) => [item.agent_id, item.state]))
      );
      document.getElementById("event-mix").innerHTML = renderPills(data.summary.event_type_counts || {{}});
      document.getElementById("artifacts").innerHTML = renderArtifacts(data.read_model.latest_artifacts || {{}});
      document.getElementById("packages").innerHTML = renderPackages(data.read_model.latest_packages || {{}});
      const timelineItems = filteredTimelineItems(data);
      document.getElementById("timeline-count").textContent =
        `${{timelineItems.length}} / ${{(data.trace.timeline || []).length}} items shown`;
      document.getElementById("timeline").innerHTML = renderTimeline(timelineItems);
    }}

    async function load() {{
      const response = await fetch(apiUrl, {{ cache: "no-store" }});
      if (!response.ok) {{
        throw new Error(`read model request failed: ${{response.status}}`);
      }}
      currentReadModel = await response.json();
      fillSelect("event-type-filter", currentReadModel.read_model.filters.event_types, "All event types");
      fillSelect("status-filter", currentReadModel.read_model.filters.statuses, "All statuses");
      fillSelect("owner-agent-filter", currentReadModel.read_model.filters.owner_agents, "All owner agents");
      renderReadModel(currentReadModel);
    }}

    function rerenderTimelineOnly() {{
      if (!currentReadModel) {{
        return;
      }}
      renderReadModel(currentReadModel);
    }}

    document.getElementById("refresh-button").addEventListener("click", () => {{
      load().catch((error) => {{
        window.alert(error.message);
      }});
    }});

    for (const id of ["event-type-filter", "status-filter", "owner-agent-filter"]) {{
      document.getElementById(id).addEventListener("change", () => {{
        expandedTimelineIds = new Set();
        rerenderTimelineOnly();
      }});
    }}

    document.getElementById("timeline").addEventListener("click", (event) => {{
      const button = event.target.closest(".timeline-toggle");
      if (!button) {{
        return;
      }}
      const itemId = button.getAttribute("data-item-id");
      if (!itemId) {{
        return;
      }}
      if (expandedTimelineIds.has(itemId)) {{
        expandedTimelineIds.delete(itemId);
      }} else {{
        expandedTimelineIds.add(itemId);
      }}
      rerenderTimelineOnly();
    }});

    load().catch((error) => {{
      document.getElementById("project-name").textContent = "Trace load failed";
      document.getElementById("project-goal").textContent = error.message;
    }});
  </script>
</body>
</html>
"""
