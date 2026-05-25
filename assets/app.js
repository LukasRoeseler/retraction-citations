/* Retraction Citation Explorer */
(function () {
  "use strict";

  const fmt = new Intl.NumberFormat("en-US");

  const STATE = {
    meta: null,
    aggregate: null,
    studies: {},
    index: [],
    filtered: [],
    page: 0,
    pageSize: 25,
  };

  const TRENDS = {
    rendered: false,
    journalPage: 0,
    authorPage: 0,
    pageSize: 15,
    topAuthors: null,
  };

  const $ = (sel, root) => (root || document).querySelector(sel);

  // ---------------------------------------------------------------- data load
  async function loadJSON(url) {
    const r = await fetch(url + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }

  async function init() {
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
    } catch (e) {
      console.error("data load failed", e);
      const err = $("#global-error");
      err.hidden = false;
      err.textContent = "Could not load data files. Run the data pipeline first — see README.";
      $("#global-loading").hidden = true;
      return;
    }
    renderAll();
  }

  function renderAll() {
    $("#global-loading").hidden = true;
    safe("renderKPIs",      renderKPIs);
    safe("renderFooter",    renderFooter);
    safe("setupTabs",       setupTabs);
    // Citations tab: render eagerly so it's ready when user clicks
    safe("renderAggregate", renderAggregate);
    safe("setupBrowse",     setupBrowse);
    safe("renderTable",     renderTable);
  }

  function safe(label, fn) {
    try { fn(); } catch (e) { console.error(label + " failed", e); }
  }

  // ---------------------------------------------------------------- KPIs / footer
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
    const el = $("#last-updated");
    if (el) el.textContent = "last updated " + d.toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------- tabs
  const ALL_TABS = ["about", "citations", "trends"];

  function showTab(tab) {
    document.querySelectorAll(".tab-btn").forEach(b => {
      const active = b.dataset.tab === tab;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", String(active));
    });
    ALL_TABS.forEach(t => {
      const el = document.getElementById("tab-" + t);
      if (el) el.hidden = (t !== tab);
    });
    if (tab === "trends" && !TRENDS.rendered) {
      TRENDS.rendered = true;
      safe("renderTrends", renderTrends);
    }
  }

  function setupTabs() {
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => showTab(btn.dataset.tab));
    });
    // honour #hash in URL (e.g. #citations, #trends)
    const hash = window.location.hash.replace("#", "");
    if (ALL_TABS.includes(hash)) showTab(hash);
  }

  // ---------------------------------------------------------------- aggregate plots
  function renderAggregate() {
    const agg = STATE.aggregate || {};
    const d   = agg.descriptive || {};
    const m   = agg.model || {};

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
      callout.textContent = "Not enough data for an aggregate effect yet.";
    }

    if (d.event_time && d.event_time.length) {
      Plotly.newPlot("plot-descr", [
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
          name: "N studies", yaxis: "y2",
          hovertemplate: "t=%{x}<br>N=%{y}<extra></extra>",
        },
      ], baseLayout({
        xtitle: "Years relative to retraction",
        ytitle: "Mean citations per year",
        y2: { title: { text: "N studies" }, side: "right", overlaying: "y", showgrid: false },
        shapes: [vline(0, "#7a1c1c")],
        annotations: [vlabel(0, "Retracted", "#7a1c1c")],
      }), plotCfg());
    }

    if (m.event_time && m.event_time.length) {
      Plotly.newPlot("plot-model", [
        {
          x: m.event_time, y: m.ci_low,
          type: "scatter", mode: "lines",
          line: { color: "transparent" },
          showlegend: false, hoverinfo: "skip",
        },
        {
          x: m.event_time, y: m.ci_high,
          type: "scatter", mode: "lines",
          line: { color: "transparent" },
          fill: "tonexty", fillcolor: "rgba(122,28,28,0.15)",
          showlegend: false, hoverinfo: "skip",
        },
        {
          x: m.event_time, y: m.estimate,
          type: "scatter", mode: "lines+markers",
          line: { color: "#7a1c1c", width: 2 },
          marker: { size: 6, color: "#7a1c1c" },
          name: "Estimate",
          hovertemplate: "t=%{x}<br>β=%{y:.3f}<extra></extra>",
        },
      ], baseLayout({
        xtitle: "Years relative to retraction",
        ytitle: "log(1 + citations) — coefficient",
        shapes: [hline(0, "#999"), vline(0, "#7a1c1c")],
        annotations: [vlabel(0, "Retracted", "#7a1c1c")],
      }), plotCfg());
    }
  }

  function baseLayout(opts) {
    const lay = {
      margin: { l: 56, r: 56, t: 18, b: 44 },
      paper_bgcolor: "#fdfcfa", plot_bgcolor: "#fdfcfa",
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
  function plotCfg() { return { displayModeBar: false, responsive: true }; }
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

  // ---------------------------------------------------------------- browse
  function setupBrowse() {
    // decade filter
    const years = STATE.index.map(s => s.retraction_year).filter(Boolean);
    const minY = Math.min(...years), maxY = Math.max(...years);
    const selDec = $("#filter-decade");
    if (isFinite(minY)) {
      for (let d = Math.floor(maxY / 10) * 10; d >= Math.floor(minY / 10) * 10; d -= 10) {
        const o = document.createElement("option");
        o.value = String(d); o.textContent = `${d}s`;
        selDec.appendChild(o);
      }
    }
    // reason filter — union of all reasons across index
    const reasons = new Set();
    for (const s of STATE.index) {
      for (const r of (s.reasons || [])) { if (r) reasons.add(r); }
    }
    const selReason = $("#filter-reason");
    [...reasons].sort().forEach(r => {
      const o = document.createElement("option");
      o.value = r;
      o.textContent = r.length > 50 ? r.slice(0, 47) + "…" : r;
      selReason.appendChild(o);
    });

    const refilter = debounce(() => { STATE.page = 0; renderTable(); }, 200);
    ["#search-input", "#filter-reason", "#sort-by", "#filter-decade"]
      .forEach(sel => $(sel).addEventListener(sel === "#search-input" ? "input" : "change", refilter));

    $("#modal-close").addEventListener("click", closeModal);
    $("#study-modal").addEventListener("click", e => { if (e.target.id === "study-modal") closeModal(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
  }

  function applyFilters() {
    const q      = ($("#search-input").value || "").trim().toLowerCase();
    const reason = $("#filter-reason").value;
    const decade = $("#filter-decade").value;
    const sort   = $("#sort-by").value;

    let rows = STATE.index;
    if (q) rows = rows.filter(r =>
      (r.title   || "").toLowerCase().includes(q) ||
      (r.author  || "").toLowerCase().includes(q) ||
      (r.journal || "").toLowerCase().includes(q) ||
      (r.doi     || "").toLowerCase().includes(q));
    if (reason) rows = rows.filter(r => (r.reasons || []).includes(reason));
    if (decade) {
      const d = parseInt(decade, 10);
      rows = rows.filter(r => r.retraction_year >= d && r.retraction_year < d + 10);
    }
    const cmp = {
      n_citations:    (a, b) => (b.n_citations || 0) - (a.n_citations || 0),
      year_desc:      (a, b) => (b.retraction_year || 0) - (a.retraction_year || 0),
      year_asc:       (a, b) => (a.retraction_year || 9999) - (b.retraction_year || 9999),
      orig_year_desc: (a, b) => (b.year || 0) - (a.year || 0),
      orig_year_asc:  (a, b) => (a.year || 9999) - (b.year || 9999),
    }[sort] || ((a, b) => (b.n_citations || 0) - (a.n_citations || 0));
    STATE.filtered = rows.slice().sort(cmp);
  }

  function renderTable() {
    applyFilters();
    const tbody = $("#originals-table tbody");
    tbody.innerHTML = "";
    const total = STATE.filtered.length;
    const pages = Math.max(1, Math.ceil(total / STATE.pageSize));
    if (STATE.page >= pages) STATE.page = 0;
    const slice = STATE.filtered.slice(STATE.page * STATE.pageSize, (STATE.page + 1) * STATE.pageSize);
    const frag = document.createDocumentFragment();
    for (const r of slice) {
      const tr = document.createElement("tr");
      tr.dataset.doi = r.doi;
      tr.innerHTML = `
        <td>
          <span class="row-title">${esc(r.title || "(untitled)")}</span>
          <span class="row-meta">${esc(r.author || "")}${r.doi
            ? ` · <a href="https://doi.org/${escA(r.doi)}" target="_blank" onclick="event.stopPropagation()">${esc(r.doi)}</a>`
            : ""}</span>
        </td>
        <td class="num">${r.year ?? ""}</td>
        <td class="num">${r.retraction_year ?? ""}</td>
        <td>${esc(r.journal || "")}</td>
        <td class="num">${fmt.format(r.n_citations || 0)}</td>`;
      tr.addEventListener("click", () => openModal(r.doi));
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    renderPager("pagination", pages, total, STATE.page,
      p => { STATE.page = p; renderTable(); window.scrollTo({ top: $("#browse").offsetTop - 20, behavior: "smooth" }); });
  }

  // ---------------------------------------------------------------- modal
  function openModal(doi) {
    const s = STATE.studies[doi];
    if (!s) return;
    const tags = (s.reasons || []).map(r => `<span class="tag">${esc(r)}</span>`).join("");
    $("#modal-body").innerHTML = `
      <h2 class="modal-title">${esc(s.title || "(untitled)")}</h2>
      <p class="modal-meta">
        ${esc(s.author || "")}${s.year ? ` · ${s.year}` : ""}
        ${s.journal ? ` · <em>${esc(s.journal)}</em>` : ""}
        ${s.doi ? `<br><a href="https://doi.org/${escA(s.doi)}" target="_blank">${esc(s.doi)}</a>` : ""}
        ${s.retraction_doi ? ` · retraction: <a href="https://doi.org/${escA(s.retraction_doi)}" target="_blank">${esc(s.retraction_doi)}</a>` : ""}
      </p>
      ${tags ? `<div class="modal-section-title">Reason(s) for retraction</div><div class="modal-tags">${tags}</div>` : ""}
      <div class="modal-section-title">Citations per year</div>
      <div id="modal-plot" class="modal-plot"></div>
      <p class="muted small" style="margin-top:.5rem">
        Retracted in <strong>${s.retraction_year ?? "?"}</strong>. Total citations: <strong>${fmt.format(s.n_citations || 0)}</strong>.
      </p>`;
    $("#study-modal").hidden = false;

    const tl = s.timeline || [];
    if (!tl.length) { $("#modal-plot").innerHTML = `<p class="muted">No citations on record.</p>`; return; }

    const minY = Math.min(...tl.map(t => t.year));
    const maxY = Math.max(...tl.map(t => t.year));
    const xs = [], ys = [];
    const lookup = Object.fromEntries(tl.map(t => [t.year, t.n]));
    for (let y = minY; y <= maxY; y++) { xs.push(y); ys.push(lookup[y] || 0); }

    const ry = s.retraction_year;
    const colors = xs.map(y => y > ry ? "#b9442f" : y === ry ? "#7a1c1c" : "#aaa");

    Plotly.newPlot("modal-plot", [{ x: xs, y: ys, type: "bar",
      marker: { color: colors },
      hovertemplate: "%{x}: %{y} citations<extra></extra>" }], {
      margin: { l: 48, r: 16, t: 16, b: 40 },
      paper_bgcolor: "#fff", plot_bgcolor: "#fff",
      font: { family: "Inter, sans-serif", size: 12 },
      xaxis: { title: "Year", gridcolor: "#eee" },
      yaxis: { title: "Citations", gridcolor: "#eee" },
      showlegend: false,
      shapes: ry ? [vline(ry, "#7a1c1c")] : [],
      annotations: ry ? [vlabel(ry, `retracted ${ry}`, "#7a1c1c")] : [],
    }, { displayModeBar: false, responsive: true });
  }

  function closeModal() {
    $("#study-modal").hidden = true;
    const mp = document.getElementById("modal-plot");
    if (mp && window.Plotly) Plotly.purge(mp);
  }

  // ---------------------------------------------------------------- trends tab
  function renderTrends() {
    safe("trendsByYear",    renderTrendsByYear);
    safe("trendsReasons",   renderTrendsReasons);
    safe("trendsJournals",  () => renderTrendsList("journals", 0));
    safe("trendsAuthors",   () => renderTrendsList("authors",  0));
  }

  function renderTrendsByYear() {
    const counter = {};
    for (const s of STATE.index) {
      const y = s.retraction_year;
      if (y) counter[y] = (counter[y] || 0) + 1;
    }
    const years = Object.keys(counter).map(Number).sort((a, b) => a - b);
    Plotly.newPlot("plot-by-year", [{
      x: years, y: years.map(y => counter[y]),
      type: "bar",
      marker: { color: "#7a1c1c" },
      hovertemplate: "%{x}: %{y} retractions<extra></extra>",
    }], {
      margin: { l: 56, r: 16, t: 16, b: 44 },
      paper_bgcolor: "#fdfcfa", plot_bgcolor: "#fdfcfa",
      font: { family: "Inter, sans-serif", size: 12, color: "#1d1d1f" },
      xaxis: { title: "Year", gridcolor: "#eee" },
      yaxis: { title: "Retractions", gridcolor: "#eee" },
      showlegend: false,
    }, plotCfg());
  }

  function renderTrendsReasons() {
    const top = (STATE.meta && STATE.meta.top_reasons) ? STATE.meta.top_reasons : [];
    if (!top.length) { $("#plot-reasons").textContent = "No reason data available."; return; }
    const labels = top.map(r => r[0]).reverse();
    const counts = top.map(r => r[1]).reverse();
    Plotly.newPlot("plot-reasons", [{
      x: counts, y: labels, type: "bar", orientation: "h",
      marker: { color: "#7a1c1c" },
      hovertemplate: "%{y}: %{x}<extra></extra>",
    }], {
      margin: { l: 340, r: 32, t: 16, b: 44 },
      paper_bgcolor: "#fdfcfa", plot_bgcolor: "#fdfcfa",
      font: { family: "Inter, sans-serif", size: 12, color: "#1d1d1f" },
      xaxis: { title: "Count (papers can have multiple reasons)", gridcolor: "#eee" },
      yaxis: { gridcolor: "#eee", tickfont: { size: 11 } },
      showlegend: false,
    }, plotCfg());
  }

  function getTopJournals() {
    return (STATE.meta && STATE.meta.top_journals) ? STATE.meta.top_journals : [];
  }

  function getTopAuthors() {
    if (TRENDS.topAuthors) return TRENDS.topAuthors;
    const counter = {};
    for (const s of STATE.index) {
      const raw = (s.author || "").replace(/,?\s*…\s*\([^)]+\)$/, "").trim();
      const names = raw.split(";").map(n => n.trim()).filter(n => n && n !== "…");
      for (const name of names) { counter[name] = (counter[name] || 0) + 1; }
    }
    TRENDS.topAuthors = Object.entries(counter).sort((a, b) => b[1] - a[1]).slice(0, 100);
    return TRENDS.topAuthors;
  }

  function renderTrendsList(type, page) {
    const isJournal = type === "journals";
    const allRows = isJournal ? getTopJournals() : getTopAuthors();
    const searchId = `trends-${type}-search`;
    const wrapId   = `trends-${type}-wrap`;
    const pagerId  = `trend-${isJournal ? "journal" : "author"}-pager`;

    // Apply search filter if the input exists and has a value
    const searchEl = document.getElementById(searchId);
    const q = searchEl ? searchEl.value.trim().toLowerCase() : "";
    const rows = q ? allRows.filter(r => r[0].toLowerCase().includes(q)) : allRows;

    const pages  = Math.max(1, Math.ceil(rows.length / TRENDS.pageSize));
    const safePage = Math.min(page, pages - 1);
    const slice  = rows.slice(safePage * TRENDS.pageSize, (safePage + 1) * TRENDS.pageSize);

    if (isJournal) TRENDS.journalPage = safePage;
    else           TRENDS.authorPage  = safePage;

    const tbody = slice.map((r, i) => {
      const rank = page * TRENDS.pageSize + i + 1;
      const name = r[0], count = r[1];
      return `<tr>
        <td class="num muted">${rank}</td>
        <td>${esc(name)}</td>
        <td class="num">${fmt.format(count)}</td>
      </tr>`;
    }).join("");

    const colLabel = isJournal ? "Journal" : "Author";
    const placeholder = isJournal ? "Search journals…" : "Search authors…";
    const currentQ = searchEl ? searchEl.value : "";

    document.getElementById(wrapId).innerHTML = `
      <div class="trends-search-row">
        <input id="${searchId}" type="search" class="trends-search" placeholder="${placeholder}" value="${esc(currentQ)}">
        <span class="trends-search-count">${fmt.format(rows.length)} ${rows.length === allRows.length ? "" : `of ${fmt.format(allRows.length)} `}${colLabel.toLowerCase()}s</span>
      </div>
      <div class="table-wrap">
        <table class="trends-table">
          <thead><tr><th class="num">#</th><th>${colLabel}</th><th class="num">Retractions</th></tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>`;

    // Re-attach search listener after innerHTML replacement
    document.getElementById(searchId).addEventListener("input", debounce(() => {
      renderTrendsList(type, 0);
    }, 180));

    renderPager(pagerId, pages, rows.length, safePage,
      p => renderTrendsList(type, p));
  }

  // ---------------------------------------------------------------- shared pager
  function renderPager(id, pages, total, current, onPage) {
    const p = document.getElementById(id);
    if (!p) return;
    p.innerHTML = "";
    const mk = (label, page, opts = {}) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (opts.active)   b.classList.add("active");
      if (opts.disabled) b.disabled = true;
      b.addEventListener("click", () => onPage(page));
      return b;
    };
    p.appendChild(mk("‹ Prev", Math.max(0, current - 1), { disabled: current === 0 }));
    const lo = Math.max(0, current - 2), hi = Math.min(pages - 1, current + 2);
    if (lo > 0) { p.appendChild(mk("1", 0)); if (lo > 1) { const s = document.createElement("span"); s.className = "info"; s.textContent = "…"; p.appendChild(s); } }
    for (let i = lo; i <= hi; i++) p.appendChild(mk(String(i + 1), i, { active: i === current }));
    if (hi < pages - 1) { if (hi < pages - 2) { const s = document.createElement("span"); s.className = "info"; s.textContent = "…"; p.appendChild(s); } p.appendChild(mk(String(pages), pages - 1)); }
    p.appendChild(mk("Next ›", Math.min(pages - 1, current + 1), { disabled: current === pages - 1 }));
    const info = document.createElement("span");
    info.className = "info";
    const start = total === 0 ? 0 : current * STATE.pageSize + 1;
    info.textContent = `${fmt.format(total)} total`;
    p.appendChild(info);
  }

  // ---------------------------------------------------------------- utils
  function debounce(fn, ms) {
    let h; return function (...a) { clearTimeout(h); h = setTimeout(() => fn.apply(this, a), ms); };
  }
  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function escA(s) { return esc(s); }

  document.addEventListener("DOMContentLoaded", init);
})();
