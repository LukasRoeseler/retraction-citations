/* Retraction Citation Explorer — frontend */
(function () {
  "use strict";

  const fmt = new Intl.NumberFormat("en-US");
  const STATE = {
    meta: null,
    aggregate: null,
    studies: {},     // doi -> full study object (lazy: comes from retractions.json)
    index: [],       // light index for table
    filtered: [],
    page: 0,
    pageSize: 25,
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ----------------------------------------------------------- data load
  async function loadJSON(url) {
    const r = await fetch(url + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }

  async function init() {
    let loaded = false;
    try {
      const [meta, aggregate, retractions] = await Promise.all([
        loadJSON("data/meta.json"),
        loadJSON("data/aggregate.json"),
        loadJSON("data/retractions.json"),
      ]);
      STATE.meta = meta;
      STATE.aggregate = aggregate;
      STATE.studies = retractions.studies || {};
      STATE.index = retractions.index || [];
      loaded = true;
    } catch (e) {
      console.error("data load failed", e);
      const err = $("#global-error");
      err.hidden = false;
      err.textContent =
        "Could not load data files. Run the data pipeline first — see README.";
      $("#global-loading").hidden = true;
      return;
    }
    if (loaded) renderAll();
  }

  // ----------------------------------------------------------- render
  function renderAll() {
    $("#global-loading").hidden = true;
    $("#aggregate").hidden = false;
    $("#browse").hidden = false;

    // Per-section guards: a failure in one block must not stop the rest.
    safe("renderKPIs",      renderKPIs);
    safe("renderFooter",    renderFooter);
    safe("renderAggregate", renderAggregate);
    safe("setupBrowse",     setupBrowse);
    safe("renderTable",     renderTable);
  }

  function safe(label, fn) {
    try { fn(); }
    catch (e) { console.error(`${label} failed`, e); }
  }

  function renderKPIs() {
    const m = STATE.meta || {};
    $("#kpi-total").textContent     = fmt.format(m.n_retractions_total || 0);
    $("#kpi-with-cit").textContent  = fmt.format(m.n_with_citations || 0);
    $("#kpi-total-cit").textContent = fmt.format(m.n_citations_total || 0);
    const d = m.last_updated ? new Date(m.last_updated) : null;
    $("#kpi-last-updated").textContent = d
      ? d.toISOString().slice(0, 10) + (m.partial_run ? " (partial)" : "")
      : "—";
  }

  function renderFooter() {
    const m = STATE.meta;
    if (!m || !m.last_updated) return;
    const d = new Date(m.last_updated);
    $("#last-updated").textContent =
      "last updated " + d.toISOString().slice(0, 10) +
      (m.partial_run ? " (partial run)" : "");
  }

  // ----------------------------------------------------------- aggregate
  function renderAggregate() {
    const agg = STATE.aggregate || {};
    const d = agg.descriptive || {};
    const m = agg.model || {};

    // ATT callout
    const callout = $("#att-callout");
    if (m && typeof m.att === "number") {
      const pct = (Math.exp(m.att) - 1) * 100;
      const lo  = m.att_ci ? (Math.exp(m.att_ci[0]) - 1) * 100 : null;
      const hi  = m.att_ci ? (Math.exp(m.att_ci[1]) - 1) * 100 : null;
      const ciTxt = (lo !== null && hi !== null)
        ? ` (95% CI: ${lo.toFixed(1)}%, ${hi.toFixed(1)}%)`
        : "";
      callout.innerHTML =
        `<strong>Average post-retraction effect on citations:</strong> ` +
        `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%${ciTxt} · based on ${fmt.format(m.n_units || 0)} retractions`;
    } else {
      callout.textContent = "Not enough data for an aggregate effect yet — try re-running the pipeline.";
    }

    // descriptive plot
    if (d.event_time && d.event_time.length) {
      const traces = [
        {
          x: d.event_time, y: d.mean_citations,
          type: "scatter", mode: "lines+markers",
          line: { color: "#7a1c1c", width: 2 },
          marker: { size: 6, color: "#7a1c1c" },
          name: "Mean citations/yr",
          hovertemplate: "t=%{x}<br>%{y:.2f} citations/yr<extra></extra>",
        },
        {
          x: d.event_time, y: d.n_units,
          type: "scatter", mode: "lines",
          line: { color: "#bbb", width: 1, dash: "dot" },
          name: "N studies",
          yaxis: "y2",
          hovertemplate: "t=%{x}<br>N=%{y}<extra></extra>",
        },
      ];
      Plotly.newPlot("plot-descr", traces, baseLayout({
        xtitle: "Years relative to retraction",
        ytitle: "Mean citations per year",
        y2: { title: "N studies", side: "right", overlaying: "y", showgrid: false },
        shapes: [vline(0, "#7a1c1c")],
        annotations: [vlabel(0, "Retracted", "#7a1c1c")],
      }), plotConfig());
    }

    // model event-study plot — confidence band via tonexty
    if (m.event_time && m.event_time.length) {
      const x = m.event_time;
      const traces = [
        {
          x, y: m.ci_low,
          type: "scatter", mode: "lines",
          line: { color: "transparent" },
          showlegend: false, hoverinfo: "skip",
        },
        {
          x, y: m.ci_high,
          type: "scatter", mode: "lines",
          line: { color: "transparent" },
          fill: "tonexty", fillcolor: "rgba(122,28,28,0.15)",
          name: "95% CI",
          showlegend: false, hoverinfo: "skip",
        },
        {
          x, y: m.estimate,
          type: "scatter", mode: "lines+markers",
          line: { color: "#7a1c1c", width: 2 },
          marker: { size: 6, color: "#7a1c1c" },
          name: "Estimate",
          hovertemplate: "t=%{x}<br>β=%{y:.3f}<extra></extra>",
        },
      ];
      Plotly.newPlot("plot-model", traces, baseLayout({
        xtitle: "Years relative to retraction",
        ytitle: "log(1 + citations) — coefficient",
        shapes: [hline(0, "#999"), vline(0, "#7a1c1c")],
        annotations: [vlabel(0, "Retracted", "#7a1c1c")],
      }), plotConfig());
    }
  }

  function baseLayout(opts) {
    const lay = {
      margin: { l: 56, r: 56, t: 18, b: 44 },
      paper_bgcolor: "#fdfcfa",
      plot_bgcolor: "#fdfcfa",
      font: { family: "Inter, system-ui, sans-serif", size: 12, color: "#1d1d1f" },
      xaxis: { title: opts.xtitle, gridcolor: "#eee", zerolinecolor: "#ddd" },
      yaxis: { title: opts.ytitle, gridcolor: "#eee", zerolinecolor: "#ddd" },
      shapes: opts.shapes || [],
      annotations: opts.annotations || [],
      legend: { orientation: "h", y: -0.2 },
      hovermode: "closest",
    };
    if (opts.y2) lay.yaxis2 = opts.y2;
    return lay;
  }

  function plotConfig() {
    return { displayModeBar: false, responsive: true };
  }

  function vline(x, color) {
    return { type: "line", x0: x, x1: x, y0: 0, y1: 1, yref: "paper",
             line: { color, width: 1.5, dash: "dash" } };
  }
  function hline(y, color) {
    return { type: "line", x0: 0, x1: 1, xref: "paper", y0: y, y1: y,
             line: { color, width: 1, dash: "dot" } };
  }
  function vlabel(x, text, color) {
    return { x, y: 1, yref: "paper", text, showarrow: false,
             font: { color, size: 11 }, xanchor: "left", yanchor: "bottom" };
  }

  // ----------------------------------------------------------- browse
  function setupBrowse() {
    // decade filter
    const years = STATE.index.map(s => s.retraction_year).filter(Boolean);
    const minY = Math.min(...years), maxY = Math.max(...years);
    const sel = $("#filter-decade");
    if (isFinite(minY) && isFinite(maxY)) {
      const startDecade = Math.floor(minY / 10) * 10;
      const endDecade = Math.floor(maxY / 10) * 10;
      for (let d = endDecade; d >= startDecade; d -= 10) {
        const o = document.createElement("option");
        o.value = String(d);
        o.textContent = `${d}s`;
        sel.appendChild(o);
      }
    }

    $("#search-input").addEventListener("input", debounce(() => {
      STATE.page = 0; renderTable();
    }, 200));
    $("#sort-by").addEventListener("change", () => { STATE.page = 0; renderTable(); });
    $("#filter-decade").addEventListener("change", () => { STATE.page = 0; renderTable(); });

    $("#modal-close").addEventListener("click", closeModal);
    $("#study-modal").addEventListener("click", (e) => {
      if (e.target.id === "study-modal") closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });
  }

  function applyFilters() {
    const q = $("#search-input").value.trim().toLowerCase();
    const decade = $("#filter-decade").value;
    const sort = $("#sort-by").value;

    let rows = STATE.index;
    if (q) {
      rows = rows.filter(r =>
        (r.title || "").toLowerCase().includes(q) ||
        (r.author || "").toLowerCase().includes(q) ||
        (r.journal || "").toLowerCase().includes(q) ||
        (r.doi || "").toLowerCase().includes(q)
      );
    }
    if (decade) {
      const d = parseInt(decade, 10);
      rows = rows.filter(r => r.retraction_year && r.retraction_year >= d && r.retraction_year < d + 10);
    }
    const cmp = {
      n_citations:    (a, b) => (b.n_citations || 0) - (a.n_citations || 0),
      year_desc:      (a, b) => (b.retraction_year || 0) - (a.retraction_year || 0),
      year_asc:       (a, b) => (a.retraction_year || 9999) - (b.retraction_year || 9999),
      orig_year_desc: (a, b) => (b.year || 0) - (a.year || 0),
      orig_year_asc:  (a, b) => (a.year || 9999) - (b.year || 9999),
    }[sort] || ((a, b) => (b.n_citations || 0) - (a.n_citations || 0));
    rows = rows.slice().sort(cmp);
    STATE.filtered = rows;
  }

  function renderTable() {
    applyFilters();
    const tbody = $("#originals-table tbody");
    tbody.innerHTML = "";

    const total = STATE.filtered.length;
    const pages = Math.max(1, Math.ceil(total / STATE.pageSize));
    if (STATE.page >= pages) STATE.page = 0;
    const start = STATE.page * STATE.pageSize;
    const slice = STATE.filtered.slice(start, start + STATE.pageSize);

    const frag = document.createDocumentFragment();
    for (const r of slice) {
      const tr = document.createElement("tr");
      tr.dataset.doi = r.doi;
      tr.innerHTML = `
        <td>
          <span class="row-title">${escapeHtml(r.title || "(untitled)")}</span>
          <span class="row-meta">${escapeHtml(r.author || "")}${r.doi ? ` · <a href="https://doi.org/${escapeAttr(r.doi)}" target="_blank" onclick="event.stopPropagation()">${escapeHtml(r.doi)}</a>` : ""}</span>
        </td>
        <td class="num">${r.year ?? ""}</td>
        <td class="num">${r.retraction_year ?? ""}</td>
        <td>${escapeHtml(r.journal || "")}</td>
        <td class="num">${fmt.format(r.n_citations || 0)}</td>
      `;
      tr.addEventListener("click", () => openModal(r.doi));
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);

    renderPagination(pages, total);
  }

  function renderPagination(pages, total) {
    const p = $("#pagination");
    p.innerHTML = "";
    const mk = (label, page, opts = {}) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (opts.active) b.classList.add("active");
      if (opts.disabled) b.disabled = true;
      b.addEventListener("click", () => { STATE.page = page; renderTable(); window.scrollTo({ top: $("#browse").offsetTop - 20, behavior: "smooth" }); });
      return b;
    };
    p.appendChild(mk("‹ Prev", Math.max(0, STATE.page - 1), { disabled: STATE.page === 0 }));
    const win = 2;
    const lo = Math.max(0, STATE.page - win);
    const hi = Math.min(pages - 1, STATE.page + win);
    if (lo > 0) {
      p.appendChild(mk("1", 0));
      if (lo > 1) {
        const s = document.createElement("span");
        s.className = "info"; s.textContent = "…";
        p.appendChild(s);
      }
    }
    for (let i = lo; i <= hi; i++) p.appendChild(mk(String(i + 1), i, { active: i === STATE.page }));
    if (hi < pages - 1) {
      if (hi < pages - 2) {
        const s = document.createElement("span");
        s.className = "info"; s.textContent = "…";
        p.appendChild(s);
      }
      p.appendChild(mk(String(pages), pages - 1));
    }
    p.appendChild(mk("Next ›", Math.min(pages - 1, STATE.page + 1), { disabled: STATE.page === pages - 1 }));

    const info = document.createElement("span");
    info.className = "info";
    const start = total === 0 ? 0 : STATE.page * STATE.pageSize + 1;
    const end = Math.min(total, (STATE.page + 1) * STATE.pageSize);
    info.textContent = `${fmt.format(start)}–${fmt.format(end)} of ${fmt.format(total)}`;
    p.appendChild(info);
  }

  // ----------------------------------------------------------- modal
  function openModal(doi) {
    const s = STATE.studies[doi];
    if (!s) return;
    const body = $("#modal-body");
    const reasonTags = (s.reasons || []).map(r => `<span class="tag">${escapeHtml(r)}</span>`).join("");
    body.innerHTML = `
      <h2 class="modal-title">${escapeHtml(s.title || "(untitled)")}</h2>
      <p class="modal-meta">
        ${escapeHtml(s.author || "")} ${s.year ? `· ${s.year}` : ""}
        ${s.journal ? ` · <em>${escapeHtml(s.journal)}</em>` : ""}
        ${s.doi ? `<br><a href="https://doi.org/${escapeAttr(s.doi)}" target="_blank">${escapeHtml(s.doi)}</a>` : ""}
        ${s.retraction_doi ? ` · retraction notice: <a href="https://doi.org/${escapeAttr(s.retraction_doi)}" target="_blank">${escapeHtml(s.retraction_doi)}</a>` : ""}
      </p>
      ${reasonTags ? `<div class="modal-section-title">Reason(s) for retraction</div><div class="modal-tags">${reasonTags}</div>` : ""}
      <div class="modal-section-title">Citations per year</div>
      <div id="modal-plot" class="modal-plot"></div>
      <p class="muted small" style="margin-top:.6rem">
        Retracted in <strong>${s.retraction_year ?? "?"}</strong>. Total citations:
        <strong>${fmt.format(s.n_citations || 0)}</strong>.
      </p>
    `;
    $("#study-modal").hidden = false;

    const tl = s.timeline || [];
    if (tl.length) {
      const years = tl.map(t => t.year);
      const counts = tl.map(t => t.n);
      const minY = Math.min(...years);
      const maxY = Math.max(...years);
      // fill gaps
      const xs = [];
      const ys = [];
      for (let y = minY; y <= maxY; y++) {
        xs.push(y);
        const e = tl.find(t => t.year === y);
        ys.push(e ? e.n : 0);
      }
      const colors = xs.map(y => {
        if (s.retraction_year && y > s.retraction_year) return "#b9442f";
        if (s.retraction_year && y === s.retraction_year) return "#7a1c1c";
        return "#888";
      });
      const trace = {
        x: xs, y: ys, type: "bar",
        marker: { color: colors },
        hovertemplate: "%{x}<br>%{y} citations<extra></extra>",
      };
      const shapes = [];
      const annotations = [];
      if (s.retraction_year) {
        shapes.push({
          type: "line", x0: s.retraction_year, x1: s.retraction_year,
          y0: 0, y1: 1, yref: "paper",
          line: { color: "#7a1c1c", width: 2, dash: "dash" },
        });
        annotations.push({
          x: s.retraction_year, y: 1, yref: "paper",
          text: `retracted ${s.retraction_year}`,
          showarrow: false, font: { color: "#7a1c1c", size: 11 },
          xanchor: "left", yanchor: "bottom",
        });
      }
      Plotly.newPlot("modal-plot", [trace], {
        margin: { l: 48, r: 16, t: 18, b: 40 },
        paper_bgcolor: "#fff", plot_bgcolor: "#fff",
        font: { family: "Inter, sans-serif", size: 12 },
        xaxis: { title: "Year", gridcolor: "#eee" },
        yaxis: { title: "Citations", gridcolor: "#eee" },
        shapes, annotations,
        showlegend: false,
      }, { displayModeBar: false, responsive: true });
    } else {
      $("#modal-plot").innerHTML = `<p class="muted">No citations on record.</p>`;
    }
  }

  function closeModal() {
    $("#study-modal").hidden = true;
    const mp = document.getElementById("modal-plot");
    if (mp && window.Plotly) Plotly.purge(mp);
  }

  // ----------------------------------------------------------- util
  function debounce(fn, ms) {
    let h; return function (...a) {
      clearTimeout(h); h = setTimeout(() => fn.apply(this, a), ms);
    };
  }
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }
  function escapeAttr(s) { return escapeHtml(s); }

  document.addEventListener("DOMContentLoaded", init);
})();
