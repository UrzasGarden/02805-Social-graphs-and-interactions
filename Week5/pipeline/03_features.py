"""Phase 4: per-document features for the real comparison texts and the forgeries.

Usage:  python pipeline/03_features.py [--rounds 1 2 3]
Writes outputs/features.csv (one row per document). No model calls.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
import textstats as ts  # noqa: E402
from cleaning import clean_article  # noqa: E402

ARTICLE_RE = re.compile(r"<article>(.*?)</article>", re.S)
FEATURES_FILE = config.OUTPUTS_DIR / "features.csv"


def load_forgery(round_no: int, node_id: str) -> str | None:
    manifest = json.loads((config.RENDERED_DIR / f"round{round_no}" / "manifest.json").read_text(encoding="utf-8"))
    audit_path = config.TRANSCRIPTS_DIR / f"round{round_no}" / "audit.json"
    audit = json.loads(audit_path.read_text(encoding="utf-8")) if audit_path.exists() else {}
    for slug, m in manifest.items():
        if m["node_id"] == node_id:
            if audit.get(slug, {}).get("verdict") != "PASS":
                return None                     # only audited forgeries enter the analysis
            m_ = ARTICLE_RE.search(Path(m["output_path"]).read_text(encoding="utf-8"))
            return clean_article(m_.group(1)) if m_ else None
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, nargs="+", default=[1])
    args = ap.parse_args()

    articles = json.loads(config.ARTICLES_FILE.read_text(encoding="utf-8"))
    sample = json.loads(config.SAMPLE_FILE.read_text(encoding="utf-8"))["sample"]
    corpus = ts.RealCorpus(articles, ts.stopwords())

    rows = []
    for ch in sample:
        meta = {"node_id": ch["node_id"], "name": ch["name"], "tier": ch["tier"], "in_degree": ch["in_degree"],
                "target_words": ch["target_words"]}
        rows.append({**meta, "round": 0, "label": 0, **corpus.features(ch["comparison_text"], ch["node_id"])})
        for r in args.rounds:
            text = load_forgery(r, ch["node_id"])
            if text is None:
                print(f"  round {r}: no audited forgery for {ch['name']}, skipped")
                continue
            rows.append({**meta, "round": r, "label": 1, **corpus.features(text, ch["node_id"])})
    df = pd.DataFrame(rows)
    df.to_csv(FEATURES_FILE, index=False)
    short = df[df.n_windows == 0]
    print(f"wrote {FEATURES_FILE.relative_to(config.WEEK5_DIR)}: {len(df)} documents "
          f"({(df.label == 0).sum()} real, {(df.label == 1).sum()} forged)")
    print(f"documents shorter than one {ts.WINDOW}-token window: {len(short)} {list(short.name) if len(short) else ''}")
    print(f"characters with no network neighbours (cos_neighbors missing): "
          f"{sorted(df[df.cos_neighbors.isna()].name.unique())}")
    print("\nmedian per feature, real vs forged:")
    print(df.groupby("label")[ts.FEATURES].median().T.rename(columns={0: "real", 1: "forged"}).round(4).to_string())


if __name__ == "__main__":
    main()
