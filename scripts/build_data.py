"""
Retraction Watch x OpenCitations pipeline.

- Parses the Retraction Watch CSV dump (local).
- For each original retracted paper with a usable DOI, fetches all incoming
  citations from OpenCitations (cached on disk; resumable).
- Computes:
    * per-paper citation timeline (citations per year)
    * an event-study aggregate aligned at the retraction year
    * descriptive mean-citations-per-year aligned at the retraction year
- Writes:
    data/meta.json        small summary + counters
    data/retractions.json {index:[...], studies:{doi:{...timeline...}}}
    data/aggregate.json   event-study + descriptive trajectory

Citations are fetched ONCE (disk cache). Re-running resumes from cache.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import statsmodels.api as sm
from tqdm import tqdm

# ------------------------------------------------------------------ config
ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
CACHE_DIR = ROOT / "cache" / "oc"
DATA_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

CSV_PATH = ROOT / "retraction_watch.csv"
OC_BASE = "https://opencitations.net/index/api/v2"
OC_KEY = os.environ.get("OC_API_KEY", "").strip()
EMAIL = os.environ.get("MY_EMAIL", "retractioncitations@local").strip()

CURRENT_YEAR = datetime.now(timezone.utc).year
EVENT_WINDOW = (-10, 10)

MAX_RUNTIME_SECONDS = int(os.environ.get("MAX_RUNTIME_SECONDS", 24 * 3600))
START_TIME = time.time()
BASE_DELAY = float(os.environ.get("OC_DELAY", "0.4"))

# How often to flush the JSON outputs while fetching, in number of new DOIs.
FLUSH_EVERY = int(os.environ.get("FLUSH_EVERY", "500"))

# Optionally cap how many originals to process this run (e.g. for sampling).
MAX_DOIS = int(os.environ.get("MAX_DOIS", "0"))  # 0 = no cap

session = requests.Session()
session.headers.update({"User-Agent": f"RetractionCitations/1.0 ({EMAIL})"})
if OC_KEY:
    session.headers.update({"authorization": OC_KEY})


# ------------------------------------------------------------------ helpers
def time_left() -> float:
    return MAX_RUNTIME_SECONDS - (time.time() - START_TIME)


def should_stop(reserve_seconds: int = 300) -> bool:
    return time_left() < reserve_seconds


def doi_clean(s) -> str | None:
    if not isinstance(s, str):
        return None
    s = s.strip().lower()
    if not s or s == "nan":
        return None
    # RW marks unknown DOIs with a leading "xx"
    if s.startswith("xx"):
        return None
    s = re.sub(r"^https?://(dx\.)?doi\.org/", "", s)
    s = re.sub(r"^doi:\s*", "", s)
    s = s.strip()
    if not s or "/" not in s:
        return None
    return s


def doi_slug(doi: str) -> str:
    return hashlib.sha1(doi.encode()).hexdigest()[:16]


def cache_path(doi: str) -> Path:
    h = doi_slug(doi)
    sub = CACHE_DIR / h[:2]
    sub.mkdir(exist_ok=True)
    return sub / f"{h}.json"


def parse_year(s) -> int | None:
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return None
    m = re.search(r"\b(18|19|20)\d{2}\b", str(s))
    return int(m.group(0)) if m else None


def clean_for_json(obj):
    if isinstance(obj, dict):
        return {k: clean_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean_for_json(v) for v in obj]
    if isinstance(obj, float):
        if np.isnan(obj) or np.isinf(obj):
            return None
        return obj
    if isinstance(obj, np.floating):
        f = float(obj)
        return None if (np.isnan(f) or np.isinf(f)) else f
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.ndarray):
        return clean_for_json(obj.tolist())
    try:
        if pd.isna(obj):
            return None
    except (TypeError, ValueError):
        pass
    return obj


def short_authors(raw, max_n: int = 4) -> str:
    if not isinstance(raw, str) or not raw.strip():
        return ""
    parts = [p.strip() for p in raw.split(";") if p.strip()]
    if not parts:
        return ""
    fmt = []
    for full in parts[:max_n]:
        tokens = full.split()
        if len(tokens) >= 2:
            family = tokens[-1]
            initials = " ".join(t[0].upper() + "." for t in tokens[:-1] if t)
            fmt.append(f"{family}, {initials}")
        else:
            fmt.append(full)
    s = "; ".join(fmt)
    if len(parts) > max_n:
        s += f", … (+{len(parts) - max_n})"
    return s


def short_reasons(raw) -> list[str]:
    if not isinstance(raw, str) or not raw.strip():
        return []
    out = [r.strip(" +").strip() for r in raw.split(";")]
    return [r for r in out if r]


# ------------------------------------------------------------------ RW load
def load_retraction_watch() -> pd.DataFrame:
    print(f"Loading Retraction Watch CSV: {CSV_PATH}")
    df = pd.read_csv(CSV_PATH, low_memory=False, encoding_errors="replace")
    print(f"  {len(df):,} rows")

    out = pd.DataFrame({
        "record_id":       df["Record ID"],
        "doi":             df["OriginalPaperDOI"].map(doi_clean),
        "retraction_doi":  df["RetractionDOI"].map(doi_clean),
        "title":           df["Title"].astype(str).str.slice(0, 400),
        "author":          df["Author"].astype(str),
        "journal":         df["Journal"].astype(str).str.slice(0, 200),
        "publisher":       df["Publisher"].astype(str).str.slice(0, 200),
        "subject":         df["Subject"].astype(str),
        "country":         df["Country"].astype(str),
        "original_date":   df["OriginalPaperDate"],
        "retraction_date": df["RetractionDate"],
        "nature":          df["RetractionNature"].astype(str),
        "reason":          df["Reason"].astype(str),
    })
    out["year_o"] = out["original_date"].map(parse_year)
    out["year_r"] = out["retraction_date"].map(parse_year)

    n0 = len(out)
    out = out.dropna(subset=["doi"])
    out = out.drop_duplicates(subset=["doi"], keep="first")
    print(f"  with usable original DOI: {len(out):,} (from {n0:,})")
    return out.reset_index(drop=True)


# ------------------------------------------------------------------ OpenCitations
def fetch_oc_citations(doi: str) -> list[int] | None:
    """Return list of citing-paper years for a DOI. Cached on disk."""
    cp = cache_path(doi)
    if cp.exists():
        try:
            return json.loads(cp.read_text())
        except Exception:
            pass

    url = f"{OC_BASE}/citations/doi:{doi}"
    for attempt in (1, 2, 3):
        try:
            r = session.get(url, timeout=45)
        except requests.exceptions.RequestException as e:
            if attempt == 3:
                print(f"  ! network error {doi[:60]}: {e}")
                return None
            time.sleep(3)
            continue

        if r.status_code == 200:
            try:
                rows = r.json()
            except Exception:
                rows = []
            years = []
            for row in rows:
                creation = row.get("creation", "")
                if creation and len(creation) >= 4 and creation[:4].isdigit():
                    years.append(int(creation[:4]))
            cp.write_text(json.dumps(years))
            time.sleep(BASE_DELAY)
            return years

        if r.status_code == 404:
            cp.write_text("[]")
            time.sleep(BASE_DELAY)
            return []

        if r.status_code == 429:
            time.sleep(10 * attempt)
            continue

        if attempt == 3:
            print(f"  ! HTTP {r.status_code} for {doi[:60]}")
            return None
        time.sleep(2 * attempt)

    return None


# ------------------------------------------------------------------ build
def build_studies(rw: pd.DataFrame) -> dict:
    studies: dict = {}
    dois = rw["doi"].tolist()
    if MAX_DOIS:
        dois = dois[:MAX_DOIS]
    print(f"Fetching citations for {len(dois):,} originals…")

    by_doi = rw.set_index("doi").to_dict("index")
    n_skipped = 0
    n_new_since_flush = 0

    pbar = tqdm(dois, smoothing=0.02)
    for doi in pbar:
        if should_stop():
            print(f"⏰ stopping at {len(studies)} (time budget).")
            break
        years = fetch_oc_citations(doi)
        if years is None:
            n_skipped += 1
            continue
        meta = by_doi[doi]
        ts_counter = Counter(years)
        timeline = sorted(
            [{"year": y, "n": int(c)} for y, c in ts_counter.items()],
            key=lambda x: x["year"],
        )
        studies[doi] = {
            "doi": doi,
            "title": str(meta.get("title") or "").strip(),
            "author": short_authors(meta.get("author") or ""),
            "year": meta.get("year_o"),
            "journal": str(meta.get("journal") or "").strip(),
            "publisher": str(meta.get("publisher") or "").strip(),
            "retraction_year": meta.get("year_r"),
            "retraction_doi": meta.get("retraction_doi"),
            "nature": str(meta.get("nature") or "").strip(),
            "reasons": short_reasons(meta.get("reason")),
            "subjects": [s.strip() for s in str(meta.get("subject") or "").split(";") if s.strip()],
            "n_citations": int(sum(ts_counter.values())),
            "timeline": timeline,
        }
        n_new_since_flush += 1
        if n_new_since_flush >= FLUSH_EVERY:
            write_outputs(studies, rw, partial=True)
            n_new_since_flush = 0
            pbar.set_postfix_str(f"flushed {len(studies)}")

    if n_skipped:
        print(f"  ({n_skipped} originals skipped due to API issues; re-run to retry)")
    return studies


# ------------------------------------------------------------------ aggregates
def build_panel(studies: dict) -> pd.DataFrame:
    rows = []
    for doi, s in studies.items():
        ty = s.get("retraction_year")
        py = s.get("year")
        if ty is None or py is None:
            continue
        cite_by_year = {t["year"]: t["n"] for t in s["timeline"]}
        # window from publication year to current year (constrained to event window vs ty)
        lo_year = min(py, ty + EVENT_WINDOW[0])
        hi_year = min(CURRENT_YEAR, ty + EVENT_WINDOW[1])
        for y in range(lo_year, hi_year + 1):
            rows.append({
                "doi": doi,
                "year": y,
                "n_cit": int(cite_by_year.get(y, 0)),
                "treat_year": int(ty),
            })
    if not rows:
        return pd.DataFrame(columns=["doi", "year", "n_cit", "treat_year", "event_time"])
    df = pd.DataFrame(rows)
    df["event_time"] = df["year"] - df["treat_year"]
    return df


def event_study(panel: pd.DataFrame) -> dict:
    empty = {"event_time": [], "estimate": [], "ci_low": [], "ci_high": [],
             "att": None, "att_ci": None, "n_units": 0}
    if panel.empty:
        return empty
    lo, hi = EVENT_WINDOW
    p = panel[panel["event_time"].between(lo, hi)].copy()
    if p.empty or p["doi"].nunique() < 5:
        return empty | {"n_units": int(p["doi"].nunique())}

    p["y"] = np.log1p(p["n_cit"].astype(float))
    dummies = pd.get_dummies(p["event_time"].astype(int), prefix="et", drop_first=False)
    if "et_-1" in dummies.columns:
        dummies = dummies.drop(columns=["et_-1"])

    work_cols = ["y"] + list(dummies.columns)
    work = pd.concat([
        p[["doi", "year", "y"]].reset_index(drop=True),
        dummies.reset_index(drop=True).astype(float),
    ], axis=1)
    try:
        for _ in range(20):
            for grp in ["doi", "year"]:
                work[work_cols] = work[work_cols] - work.groupby(grp)[work_cols].transform("mean")
    except Exception as e:
        print(f"  ! demean fail: {e}")
        return empty | {"n_units": int(p["doi"].nunique())}

    X = work[list(dummies.columns)].values
    y = work["y"].values
    try:
        ols = sm.OLS(y, X).fit(cov_type="cluster", cov_kwds={"groups": p["doi"].values})
    except Exception as e:
        print(f"  ! OLS fail: {e}")
        return empty | {"n_units": int(p["doi"].nunique())}

    coef = dict(zip(dummies.columns, ols.params))
    se = dict(zip(dummies.columns, ols.bse))
    rows = []
    for t in range(lo, hi + 1):
        if t == -1:
            rows.append({"event_time": t, "estimate": 0.0, "ci_low": 0.0, "ci_high": 0.0})
            continue
        k = f"et_{t}"
        if k not in coef:
            continue
        b, s_ = float(coef[k]), float(se[k])
        rows.append({"event_time": t, "estimate": b,
                     "ci_low": b - 1.96 * s_, "ci_high": b + 1.96 * s_})

    post = [r for r in rows if r["event_time"] >= 0]
    att = float(np.mean([r["estimate"] for r in post])) if post else None
    att_ci = None
    if post:
        ses = [(r["ci_high"] - r["estimate"]) / 1.96 for r in post]
        avg_se = float(np.sqrt(np.mean(np.square(ses))) / np.sqrt(len(post)))
        att_ci = [att - 1.96 * avg_se, att + 1.96 * avg_se]
    return {
        "event_time": [r["event_time"] for r in rows],
        "estimate":   [r["estimate"]   for r in rows],
        "ci_low":     [r["ci_low"]     for r in rows],
        "ci_high":    [r["ci_high"]    for r in rows],
        "att": att, "att_ci": att_ci,
        "n_units": int(p["doi"].nunique()),
    }


def descriptive_trajectory(panel: pd.DataFrame) -> dict:
    if panel.empty:
        return {"event_time": [], "mean_citations": [], "n_units": []}
    lo, hi = EVENT_WINDOW
    p = panel[panel["event_time"].between(lo, hi)]
    g = p.groupby("event_time").agg(
        cites=("n_cit", "mean"),
        n=("doi", "nunique"),
    ).reset_index()
    return {
        "event_time":     g["event_time"].astype(int).tolist(),
        "mean_citations": g["cites"].round(3).tolist(),
        "n_units":        g["n"].tolist(),
    }


# ------------------------------------------------------------------ outputs
def write_outputs(studies: dict, rw: pd.DataFrame, partial: bool):
    panel = build_panel(studies)
    aggregate = {
        "descriptive": descriptive_trajectory(panel),
        "model":       event_study(panel),
    }

    index = []
    total_citations = 0
    reason_counter: Counter = Counter()
    journal_counter: Counter = Counter()
    for doi, s in studies.items():
        index.append({
            "doi": doi,
            "title": s["title"][:300],
            "author": s["author"],
            "year": s["year"],
            "journal": s["journal"][:120],
            "retraction_year": s["retraction_year"],
            "n_citations": s["n_citations"],
            "reasons": s["reasons"][:4],
        })
        total_citations += s["n_citations"]
        for r in s["reasons"]:
            reason_counter[r] += 1
        if s["journal"]:
            journal_counter[s["journal"]] += 1

    meta = {
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "n_retractions_total": int(len(rw)),
        "n_with_doi": int(len(rw)),
        "n_with_citations": int(len(studies)),
        "n_citations_total": int(total_citations),
        "partial_run": bool(partial),
        "top_reasons": reason_counter.most_common(20),
        "top_journals": journal_counter.most_common(20),
        "event_window": list(EVENT_WINDOW),
    }

    (DATA_DIR / "meta.json").write_text(
        json.dumps(clean_for_json(meta), indent=2, allow_nan=False))
    (DATA_DIR / "aggregate.json").write_text(
        json.dumps(clean_for_json(aggregate), indent=2, allow_nan=False))
    (DATA_DIR / "retractions.json").write_text(
        json.dumps(clean_for_json({"index": index, "studies": studies}),
                   allow_nan=False))
    print(f"✔ wrote {len(studies):,} studies ({'partial' if partial else 'complete'})")


def main():
    rw = load_retraction_watch()
    studies = {}
    partial = True
    try:
        studies = build_studies(rw)
        partial = should_stop()
    except KeyboardInterrupt:
        print("⛔ interrupted")
    finally:
        write_outputs(studies, rw, partial=partial)
    print(f"Done. {len(studies):,} studies processed.")


if __name__ == "__main__":
    main()
