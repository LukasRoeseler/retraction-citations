/* Retraction Citation Explorer */
(function () {
  "use strict";

  const fmt = new Intl.NumberFormat("en-US");
  const EVENT_LO = -10, EVENT_HI = 10;

  const STATE = {
    meta: null,
    aggregate: null,
    studies: {},
    index: [],
    filtered: [],
    page: 0,
    pageSize: 25,
    natureFilter: "",          // "", "Retraction", "Expression of concern", "Correction", "Reinstatement"
  };

  const TRENDS = {
    rendered: false,
    authorCache: {},           // keyed by natureFilter value
  };

  const CIT = { rendered: false };

  const TRENDS_PAGE_SIZE = 15;

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
      STATE.meta      = meta;
      STATE.aggregate = aggregate;
      STATE.studies   = retractions.studies || {};
      STATE.index     = retractions.index   || [];
    } catch (e) {
      console.error("data load failed", e);
      const err = $("#global-error");
      err.hidden   = false;
      err.textContent = "Could not load data files. Run the data pipeline first — see README.";
      $("#global-loading").hidden = true;
      return;
    }
    enrichIndex();
    renderAll();
  }

  // Stamp each index entry with the nature field from full study objects.
  function enrichIndex() {
    for (const entry of STATE.index) {
      const s = STATE.studies[entry.doi];
      if (s) entry.nature = s.nature || "";
    }
  }

  function renderAll() {
    $("#global-loading").hidden = true;
    safe("renderKPIs",   renderKPIs);
    safe("renderFooter", renderFooter);
    safe("setupTabs",    setupTabs);
    safe("setupBrowse",  setupBrowse);
    safe("renderTable",  renderTable);
  }

  function safe(label, fn) {
    try { fn(); } catch (e) { console.error(label + " failed", e); }
  }

  // ---------------------------------------------------------------- KPIs / footer
  function renderKPIs() {
    const m = STATE.meta || {};
    $("#kpi-total").textContent     = fmt.format(m.n_retractions_total || 0);
    $("#kpi-total-cit").textContent = fmt.format(m.n_citations_total   || 0);
    const d = m.last_updated ? new Date(m.last_updated) : null;
    $("#kpi-last-updated").textContent = d
      ? d.toISOString().slice(0, 10) + (m.partial_run ? " (partial)" : "")
      : "—";
  }

  function renderFooter() {
    const m = STATE.meta;
    if (!m || !m.last_updated) return;
    const el = $("#last-updated");
    if (el) el.textContent = "last updated " + new Date(m.last_updated).toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------- nature filter
  const NATURE_OPTIONS = [
    { value: "",                       label: "All" },
    { value: "Retraction",             label: "Retraction" },
    { value: "Expression of concern",  label: "Expression of Concern" },
    { value: "Correction",             label: "Correction" },
    { value: "Reinstatement",          label: "Reinstatement" },
  ];

  function setupNatureFilter(barId, onChange) {
    const bar = document.getElementById(barId);
    if (!bar) return;
    bar.innerHTML = NATURE_OPTIONS.map(o =>
      `<button class="chip${o.value === STATE.natureFilter ? " active" : ""}"
               data-nature="${esc(o.value)}">${esc(o.label)}</button>`
    ).join("");
    bar.querySelectorAll(".chip").forEach(btn => {
      btn.addEventListener("click", () => {
        STATE.natureFilter = btn.dataset.nature;
        // sync all filter bars
        document.querySelectorAll(".nature-chips .chip").forEach(b =>
          b.classList.toggle("active", b.dataset.nature === STATE.natureFilter));
        onChange();
      });
    });
  }

  // ---------------------------------------------------------------- tabs
  const ALL_TABS = ["about", "citations", "trends"];

  function showTab(tab) {
    document.querySelectorAll(".tab-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === tab);
      b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    });
    ALL_TABS.forEach(t => {
      const el = document.getElementById("tab-" + t);
      if (el) el.hidden = (t !== tab);
    });
    if (tab === "citations" && !CIT.rendered) {
      CIT.rendered = true;
      safe("renderAggregate", renderAggregate);
    }
    if (tab === "trends" && !TRENDS.rendered) {
      TRENDS.rendered = true;
      safe("renderTrends", renderTrends);
    }
  }

  function setupTabs() {
    // Nature filter on Citations tab
    setupNatureFilter("nature-chips-citations", () => {
      STATE.page = 0;
      renderTable();
      if (CIT.rendered) safe("renderDescriptive", renderDescriptive);
    });
    // Nature filter on Trends tab
    setupNatureFilter("nature-chips-trends", () => {
      TRENDS.rendered && safe("renderTrends", renderTrends);
    });

    document.querySelectorAll(".tab-btn").forEach(btn =>
      btn.addEventListener("click", () => showTab(btn.dataset.tab)));

    const hash = window.location.hash.replace("#", "");
    if (ALL_TABS.includes(hash)) showTab(hash);
  }

  // ---------------------------------------------------------------- aggregate (Citations tab)
  function getFilteredIndex() {
    const nf = STATE.natureFilter;
    if (!nf) return STATE.index;
    return STATE.index.filter(s => (s.nature || "") === nf);
  }

  // Recompute descriptive mean-citations from study timelines for the filtered set.
  function computeDescriptive(filtIdx) {
    const sums = {}, cnts = {};
    for (let t = EVENT_LO; t <= EVENT_HI; t++) { sums[t] = 0; cnts[t] = 0; }
    for (const entry of filtIdx) {
      const s = STATE.studies[entry.doi];
      if (!s || s.retraction_year == null) continue;
      const lookup = {};
      for (const t of (s.timeline || [])) lookup[t.year] = t.n;
      for (let t = EVENT_LO; t <= EVENT_HI; t++) {
        const y = s.retraction_year + t;
        sums[t] += (lookup[y] || 0);
        cnts[t]++;
      }
    }
    const event_time = [], mean_citations = [], n_units = [];
    for (let t = EVENT_LO; t <= EVENT_HI; t++) {
      event_time.push(t);
      mean_citations.push(cnts[t] > 0 ? Math.round(sums[t] / cnts[t] * 1000) / 1000 : 0);
      n_units.push(cnts[t]);
    }
    return { event_time, mean_citations, n_units };
  }

  function renderDescriptive() {
    const d = computeDescriptive(getFilteredIndex());
    if (!d.event_time.length) return;
    const traces = [
      {
        x: d.event_time, y: d.mean_citations,
        type: "scatter", mode: "lines+markers",
        line: { color: "#7a1c1c", width: 2 }, marker: { size: 6, color: "#7a1c1c" },
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
    ];
    const lay = baseLayout({
      xtitle: "Years relative to retraction",
      ytitle: "Mean citations per year",
      shapes: [vline(0, "#7a1c1c")],
      annotations: [vlabel(0, "Retracted", "#7a1c1c")],
    });
    lay.yaxis2 = { title: { text: "N studies" }, side: "right", overlaying: "y", showgrid: false };
    Plotly.react("plot-descr", traces, lay, plotCfg());
  }

  function renderAggregate() {
    const agg = STATE.aggregate || {};
    const m   = agg.model || {};

    // ATT callout (model is pre-computed over all types)
    const callout = $("#att-callout");
    if (m && typeof m.att === "number") {
      const pct = (Math.exp(m.att) - 1) * 100;
      const lo  = m.att_ci ? (Math.exp(m.att_ci[0]) - 1) * 100 : null;
      const hi  = m.att_ci ? (Math.exp(m.att_ci[1]) - 1) * 100 : null;
      const ci  = (lo !== null && hi !== null) ? ` (95% CI: ${lo.toFixed(1)}%, ${hi.toFixed(1)}%)` : "";
      callout.innerHTML =
        `<strong>Average post-retraction effect on citations:</strong> ` +
        `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%${ci} · based on ${fmt.format(m.n_units || 0)} papers` +
        `<span class="att-note"> · model covers all record types</span>`;
    } else {
      callout.textContent = "Not enough data for an aggregate effect yet.";
    }

    // Left: descriptive (filterable)
    renderDescriptive();

    // Right: event-study model (pre-computed, not filterable)
    if (m.event_time && m.event_time.length) {
      Plotly.newPlot("plot-model", [
        { x: m.event_time, y: m.ci_low,  type: "scatter", mode: "lines", line: { color: "transparent" }, showlegend: false, hoverinfo: "skip" },
        { x: m.event_time, y: m.ci_high, type: "scatter", mode: "lines", line: { color: "transparent" }, fill: "tonexty", fillcolor: "rgba(122,28,28,0.15)", showlegend: false, hoverinfo: "skip" },
        { x: m.event_time, y: m.estimate, type: "scatter", mode: "lines+markers",
          line: { color: "#7a1c1c", width: 2 }, marker: { size: 6, color: "#7a1c1c" },
          name: "Estimate", hovertemplate: "t=%{x}<br>β=%{y:.3f}<extra></extra>" },
      ], baseLayout({
        xtitle: "Years relative to retraction",
        ytitle: "log(1 + citations) — coefficient",
        shapes: [hline(0, "#aaa"), vline(0, "#7a1c1c")],
        annotations: [vlabel(0, "Retracted", "#7a1c1c")],
      }), plotCfg());
    }
  }

  function baseLayout(opts) {
    return {
      margin: { l: 60, r: 24, t: 18, b: 48 },
      paper_bgcolor: "#fdfcfa", plot_bgcolor: "#fdfcfa",
      font: { family: "Inter, system-ui, sans-serif", size: 12, color: "#1d1d1f" },
      xaxis: { title: opts.xtitle, gridcolor: "#eee", zerolinecolor: "#ddd" },
      yaxis: { title: opts.ytitle, gridcolor: "#eee", zerolinecolor: "#ddd" },
      shapes: opts.shapes || [], annotations: opts.annotations || [],
      legend: { orientation: "h", y: -0.22 },
      hovermode: "closest",
    };
  }
  function plotCfg() { return { displayModeBar: false, responsive: true }; }
  function vline(x, color) {
    return { type: "line", x0: x, x1: x, y0: 0, y1: 1, yref: "paper", line: { color, width: 1.5, dash: "dash" } };
  }
  function hline(y, color) {
    return { type: "line", x0: 0, x1: 1, xref: "paper", y0: y, y1: y, line: { color, width: 1, dash: "dot" } };
  }
  function vlabel(x, text, color) {
    return { x, y: 1, yref: "paper", text, showarrow: false, font: { color, size: 11 }, xanchor: "left", yanchor: "bottom" };
  }

  // ---------------------------------------------------------------- browse
  function setupBrowse() {
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
    const reasons = new Set();
    for (const s of STATE.index) for (const r of (s.reasons || [])) if (r) reasons.add(r);
    const selReason = $("#filter-reason");
    [...reasons].sort().forEach(r => {
      const o = document.createElement("option");
      o.value = r; o.textContent = r.length > 50 ? r.slice(0, 47) + "…" : r;
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
    const nf     = STATE.natureFilter;

    let rows = STATE.index;
    if (nf)     rows = rows.filter(r => (r.nature  || "") === nf);
    if (q)      rows = rows.filter(r =>
      (r.title   || "").toLowerCase().includes(q) ||
      (r.author  || "").toLowerCase().includes(q) ||
      (r.journal || "").toLowerCase().includes(q) ||
      (r.doi     || "").toLowerCase().includes(q));
    if (reason) rows = rows.filter(r => (r.reasons || []).includes(reason));
    if (decade) { const d = parseInt(decade, 10); rows = rows.filter(r => r.retraction_year >= d && r.retraction_year < d + 10); }

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
    const natureBadge = s.nature ? `<span class="tag" style="background:#eee;color:#555;border-color:#ddd">${esc(s.nature)}</span>` : "";
    $("#modal-body").innerHTML = `
      <h2 class="modal-title">${esc(s.title || "(untitled)")}</h2>
      <p class="modal-meta">
        ${esc(s.author || "")}${s.year ? ` · ${s.year}` : ""}
        ${s.journal ? ` · <em>${esc(s.journal)}</em>` : ""}
        ${s.doi ? `<br><a href="https://doi.org/${escA(s.doi)}" target="_blank">${esc(s.doi)}</a>` : ""}
        ${s.retraction_doi ? ` · notice: <a href="https://doi.org/${escA(s.retraction_doi)}" target="_blank">${esc(s.retraction_doi)}</a>` : ""}
      </p>
      ${natureBadge || tags ? `<div class="modal-tags">${natureBadge}${tags}</div>` : ""}
      <div class="modal-section-title">Citations per year</div>
      <div id="modal-plot" class="modal-plot"></div>
      <p class="muted small" style="margin-top:.5rem">
        ${s.nature || "Retracted"} in <strong>${s.retraction_year ?? "?"}</strong>. Total citations: <strong>${fmt.format(s.n_citations || 0)}</strong>.
      </p>`;
    $("#study-modal").hidden = false;

    const tl = s.timeline || [];
    if (!tl.length) { $("#modal-plot").innerHTML = `<p class="muted">No citations on record.</p>`; return; }
    const minY = Math.min(...tl.map(t => t.year)), maxY = Math.max(...tl.map(t => t.year));
    const lookup = Object.fromEntries(tl.map(t => [t.year, t.n]));
    const xs = [], ys = [];
    for (let y = minY; y <= maxY; y++) { xs.push(y); ys.push(lookup[y] || 0); }
    const ry = s.retraction_year;
    const colors = xs.map(y => y > ry ? "#b9442f" : y === ry ? "#7a1c1c" : "#aaa");
    Plotly.newPlot("modal-plot", [{ x: xs, y: ys, type: "bar",
      marker: { color: colors }, hovertemplate: "%{x}: %{y} citations<extra></extra>" }], {
      margin: { l: 48, r: 16, t: 16, b: 40 },
      paper_bgcolor: "#fff", plot_bgcolor: "#fff",
      font: { family: "Inter, sans-serif", size: 12 },
      xaxis: { title: "Year", gridcolor: "#eee" },
      yaxis: { title: "Citations", gridcolor: "#eee" },
      showlegend: false,
      shapes: ry ? [vline(ry, "#7a1c1c")] : [],
      annotations: ry ? [vlabel(ry, `${s.nature || "Retracted"} ${ry}`, "#7a1c1c")] : [],
    }, { displayModeBar: false, responsive: true });
  }

  function closeModal() {
    $("#study-modal").hidden = true;
    const mp = document.getElementById("modal-plot");
    if (mp && window.Plotly) Plotly.purge(mp);
  }

  // ---------------------------------------------------------------- trends tab
  function renderTrends() {
    safe("trendsByYear",   renderTrendsByYear);
    safe("trendsReasons",  renderTrendsReasons);
    safe("trendsJournals", () => renderTrendsList("journals", 0));
    safe("trendsAuthors",  () => renderTrendsList("authors",  0));
  }

  function renderTrendsByYear() {
    const counter = {};
    for (const s of getFilteredIndex()) {
      const y = s.retraction_year;
      if (y) counter[y] = (counter[y] || 0) + 1;
    }
    const years = Object.keys(counter).map(Number).sort((a, b) => a - b);
    Plotly.react("plot-by-year", [{
      x: years, y: years.map(y => counter[y]),
      type: "bar", marker: { color: "#7a1c1c" },
      hovertemplate: "%{x}: %{y}<extra></extra>",
    }], {
      margin: { l: 60, r: 16, t: 16, b: 44 },
      paper_bgcolor: "#fdfcfa", plot_bgcolor: "#fdfcfa",
      font: { family: "Inter, sans-serif", size: 12, color: "#1d1d1f" },
      xaxis: { title: "Year", gridcolor: "#eee" },
      yaxis: { title: "Papers", gridcolor: "#eee" },
      showlegend: false,
    }, plotCfg());
  }

  function renderTrendsReasons() {
    const counter = {};
    for (const s of getFilteredIndex()) {
      for (const r of (s.reasons || [])) {
        if (r) counter[r] = (counter[r] || 0) + 1;
      }
    }
    const sorted = Object.entries(counter).sort((a, b) => b[1] - a[1]).slice(0, 20);
    if (!sorted.length) { $("#plot-reasons").textContent = "No data."; return; }
    const labels = sorted.map(r => r[0]).reverse();
    const counts = sorted.map(r => r[1]).reverse();
    Plotly.react("plot-reasons", [{
      x: counts, y: labels, type: "bar", orientation: "h",
      marker: { color: "#7a1c1c" },
      hovertemplate: "%{y}: %{x}<extra></extra>",
    }], {
      margin: { l: 340, r: 32, t: 16, b: 44 },
      paper_bgcolor: "#fdfcfa", plot_bgcolor: "#fdfcfa",
      font: { family: "Inter, sans-serif", size: 12, color: "#1d1d1f" },
      xaxis: { title: "Count (one paper can have multiple reasons)", gridcolor: "#eee" },
      yaxis: { gridcolor: "#eee", tickfont: { size: 11 } },
      showlegend: false,
    }, plotCfg());
  }

  function getTopJournals() {
    const counter = {};
    for (const s of getFilteredIndex()) {
      const j = (s.journal || "").trim();
      if (j) counter[j] = (counter[j] || 0) + 1;
    }
    return Object.entries(counter).sort((a, b) => b[1] - a[1]).slice(0, 100);
  }

  function getTopAuthors() {
    const key = STATE.natureFilter || "_all";
    if (TRENDS.authorCache[key]) return TRENDS.authorCache[key];
    const counter = {};
    for (const s of getFilteredIndex()) {
      const raw = (s.author || "").replace(/,?\s*…\s*\([^)]+\)$/, "").trim();
      const names = raw.split(";").map(n => n.trim()).filter(n => n && n !== "…");
      for (const name of names) counter[name] = (counter[name] || 0) + 1;
    }
    const result = Object.entries(counter).sort((a, b) => b[1] - a[1]).slice(0, 100);
    TRENDS.authorCache[key] = result;
    return result;
  }

  function renderTrendsList(type, page) {
    const isJournal = type === "journals";
    const allRows   = isJournal ? getTopJournals() : getTopAuthors();
    const wrapId    = `trends-${type}-wrap`;
    const pagerId   = `trend-${isJournal ? "journal" : "author"}-pager`;

    const searchEl  = document.getElementById(`trends-${type}-search`);
    const q         = searchEl ? searchEl.value.trim().toLowerCase() : "";
    const rows      = q ? allRows.filter(r => r[0].toLowerCase().includes(q)) : allRows;

    const pages    = Math.max(1, Math.ceil(rows.length / TRENDS_PAGE_SIZE));
    const safePage = Math.min(page, pages - 1);
    const slice    = rows.slice(safePage * TRENDS_PAGE_SIZE, (safePage + 1) * TRENDS_PAGE_SIZE);

    const colLabel = isJournal ? "Journal" : "Author";
    const currentQ = searchEl ? searchEl.value : "";
    const countTxt = rows.length === allRows.length
      ? `${fmt.format(allRows.length)} ${colLabel.toLowerCase()}s`
      : `${fmt.format(rows.length)} of ${fmt.format(allRows.length)} ${colLabel.toLowerCase()}s`;

    const tbody = slice.map((r, i) => `<tr>
      <td class="num muted">${safePage * TRENDS_PAGE_SIZE + i + 1}</td>
      <td>${esc(r[0])}</td>
      <td class="num">${fmt.format(r[1])}</td>
    </tr>`).join("");

    document.getElementById(wrapId).innerHTML = `
      <div class="trends-search-row">
        <input id="trends-${type}-search" type="search" class="trends-search"
               placeholder="Search ${colLabel.toLowerCase()}s…" value="${esc(currentQ)}">
        <span class="trends-search-count">${countTxt}</span>
      </div>
      <div class="table-wrap">
        <table class="trends-table">
          <thead><tr><th class="num">#</th><th>${colLabel}</th><th class="num">Papers</th></tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>`;

    document.getElementById(`trends-${type}-search`).addEventListener("input",
      debounce(() => renderTrendsList(type, 0), 180));

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
    info.className = "info"; info.textContent = `${fmt.format(total)} total`;
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
