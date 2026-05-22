# Retraction Citation Explorer

A static dashboard that combines the [Retraction Watch database](https://gitlab.com/crossref/retraction-watch-data)
with [OpenCitations](https://opencitations.net) to show how retractions affect citations.

Inspired by the [FLoRA Citation Impact Explorer](https://forrt.org/flora-explorer/).

## What's here

```
index.html                  single-page dashboard
assets/                     styles.css, app.js  (vanilla JS + Plotly)
data/                       precomputed JSON consumed by the page
  meta.json                 counters + last-updated stamp
  aggregate.json            event-study aggregate (aligned at retraction year)
  retractions.json          per-paper timelines + browse index
cache/oc/<xx>/<sha>.json    one file per DOI, list of citing-paper years
scripts/build_data.py       pipeline: RW CSV -> OC fetch -> JSON outputs
.github/workflows/          builds data in CI, commits cache, deploys Pages
retraction_watch.csv        local dump (Retraction Watch / Crossref, May 2026)
```

## How it works

1. `scripts/build_data.py` parses `retraction_watch.csv` and, for every retracted
   paper with a usable DOI, fetches incoming citations from OpenCitations.
   Each DOI is **cached on disk** in `cache/oc/` — the run is fully resumable
   and only ever hits OpenCitations once per paper.
2. Per-paper citation timelines (citations per year) are written to
   `data/retractions.json`.
3. Aggregate stats — descriptive mean citations/yr aligned at the retraction
   year, and a two-way fixed-effects event-study on `log(1 + citations)` —
   are written to `data/aggregate.json`.

The frontend is **plain HTML + JS + Plotly** — no build step, no framework.
It is hosted by GitHub Pages directly from the repo root.

## Running the pipeline

Locally (requires Python 3.10+):

```bash
pip install -r scripts/requirements.txt
python scripts/build_data.py
```

Useful env vars:

| var                   | default | what it does                                       |
|-----------------------|---------|----------------------------------------------------|
| `MAX_DOIS`            | 0       | cap originals processed this run (0 = no cap)      |
| `MAX_RUNTIME_SECONDS` | 86400   | walltime budget; flushes and exits before timeout  |
| `OC_DELAY`            | 0.4     | sleep between OpenCitations calls (s)              |
| `FLUSH_EVERY`         | 500     | re-write JSON outputs every N newly-fetched papers |
| `OC_API_KEY`          | —       | OpenCitations API key (optional, raises rate cap)  |
| `MY_EMAIL`            | —       | sent in User-Agent so OC can reach you on issues   |

### In CI (GitHub Actions)

The included workflow runs the pipeline twice a day and commits the updated
`data/` + `cache/` back to the repo. The first few runs will populate the
cache from cold (~60 K DOIs at ~0.4 s/req ≈ 6–7 h each); subsequent runs are
nearly free.

To make it work in your fork:

1. Push the repo to GitHub.
2. **Settings → Pages → Source = GitHub Actions**.
3. *(optional)* **Settings → Secrets → Actions**: add `OC_API_KEY` and
   `MY_EMAIL`. The pipeline works without them; the key just removes the rate
   cap.
4. **Actions → "build-and-deploy" → Run workflow** to kick it off.

## Data sources

- **Retraction Watch** dump (Crossref):
  <https://gitlab.com/crossref/retraction-watch-data> — the local snapshot
  used here is from 21 May 2026.
- **OpenCitations** Index v2 API: <https://opencitations.net/index/api/v2>.

Please cite both when reusing this work.
