"""Phase 4: detector D1, one-feature baselines, memorization check, round-2 feedback.

Usage:  python pipeline/04_detector.py --train-rounds 1 --name D1
Writes:
  outputs/models/D1.joblib               frozen detector (imputer + scaler + logistic regression)
  outputs/detector_D1.json               metrics, coefficients, one-feature baselines
  outputs/predictions_D1.csv             out-of-fold P(forged) for every training document
  outputs/memorization_round1.csv        verbatim overlap of forgeries (and real pages, as baseline)
  outputs/feedback_round2.json           numbers for the round-2 feedback block (not used until approved)
No model calls.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
import textstats as ts  # noqa: E402
from cleaning import clean_article  # noqa: E402

N_FOLDS = 10
NGRAM = 8
BOILERPLATE_SHARE = 0.10   # an 8-gram in >=10% of real pages counts as stock Wikipedia phrasing
FEATURES_FILE = config.OUTPUTS_DIR / "features.csv"


def make_model():
    return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(),
                         LogisticRegression(C=1.0, max_iter=2000))


def cross_validate(df: pd.DataFrame, cols: list[str]) -> np.ndarray:
    """Out-of-fold P(forged); a character's real and forged pages share a fold."""
    oof = np.zeros(len(df))
    for tr, te in GroupKFold(n_splits=N_FOLDS).split(df, df.label, groups=df.node_id):
        m = make_model().fit(df.iloc[tr][cols], df.iloc[tr].label)
        oof[te] = m.predict_proba(df.iloc[te][cols])[:, 1]
    return oof


def pair_accuracy(df: pd.DataFrame, p: np.ndarray) -> float:
    """Game metric: for how many characters does the forgery get the higher P(forged)?"""
    d = df.assign(p=p)
    wins = [g.loc[g.label == 1, "p"].max() > g.loc[g.label == 0, "p"].max()
            for _, g in d.groupby("node_id") if g.label.nunique() == 2]
    return float(np.mean(wins))


def scores(df, p) -> dict:
    return {"accuracy": float(accuracy_score(df.label, p > 0.5)), "auc": float(roc_auc_score(df.label, p)),
            "pair_accuracy": pair_accuracy(df, p)}


# ------------------------------------------------------------ memorization --
class NgramIndex:
    """8-gram index over the real pages, for verbatim-overlap measurements."""

    def __init__(self, token_lists: list[list[str]]):
        self.toks = token_lists
        self.occ: dict[tuple, list[tuple[int, int]]] = defaultdict(list)
        self.df: Counter = Counter()
        for p, tk in enumerate(token_lists):
            seen = set()
            for i in range(len(tk) - NGRAM + 1):
                g = tuple(tk[i:i + NGRAM])
                self.occ[g].append((p, i))
                seen.add(g)
            self.df.update(seen)

    def compare(self, tk: list[str], pages: set[int] | None = None, exclude: int | None = None) -> dict:
        """Longest shared token run and shared 8-grams with the allowed pages."""
        ok = (lambda p: p in pages) if pages is not None else (lambda p: p != exclude)
        longest, shared, distinctive = 0, set(), set()
        limit = BOILERPLATE_SHARE * len(self.toks)
        for i in range(len(tk) - NGRAM + 1):
            g = tuple(tk[i:i + NGRAM])
            hits = [(p, j) for p, j in self.occ.get(g, ()) if ok(p)]
            if not hits:
                continue
            shared.add(g)
            if self.df[g] < limit:
                distinctive.add(g)
            for p, j in hits:
                page = self.toks[p]
                if i > 0 and j > 0 and tk[i - 1] == page[j - 1]:
                    continue                      # not the start of a maximal run
                k = NGRAM
                while i + k < len(tk) and j + k < len(page) and tk[i + k] == page[j + k]:
                    k += 1
                longest = max(longest, k)
        return {"longest_run": longest, "shared_8grams": len(shared), "distinctive_8grams": len(distinctive)}


def memorization(sample, articles, forged: dict[str, str]) -> pd.DataFrame:
    ids = list(articles)
    pos = {n: i for i, n in enumerate(ids)}
    index = NgramIndex([ts.doc_tokens(articles[n]["clean"]) for n in ids])
    rows = []
    for ch in sample:
        nid = ch["node_id"]
        real_tk = ts.doc_tokens(ch["comparison_text"])
        base = index.compare(real_tk, exclude=pos[nid])          # Wikipedia copying itself
        rows.append({"node_id": nid, "name": ch["name"], "doc": "real (vs other real pages)",
                     "n_tokens": len(real_tk), **{f"any_{k}": v for k, v in base.items()}})
        if nid in forged:
            tk = ts.doc_tokens(forged[nid])
            own = index.compare(tk, pages={pos[nid]})
            anyp = index.compare(tk, exclude=None)
            rows.append({"node_id": nid, "name": ch["name"], "doc": "forgery", "n_tokens": len(tk),
                         **{f"own_{k}": v for k, v in own.items()}, **{f"any_{k}": v for k, v in anyp.items()}})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- feedback --
def feedback(df: pd.DataFrame, oof: np.ndarray, single: pd.DataFrame, corpus: ts.RealCorpus,
             forged: dict[str, str]) -> dict:
    forg = df[df.label == 1]
    caught = int((oof[df.label.values == 1] > 0.5).sum())
    top = single.reindex(single.auc.sub(0.5).abs().sort_values(ascending=False).index).head(5)
    lines = []
    for f in top.index:
        r, g = df.loc[df.label == 0, f].median(), forg[f].median()
        if f in ("unseen_bigram_rate", "stopword_rate"):
            fmt = lambda x: f"{x:.1%}"  # noqa: E731
        elif f in ("hapax_ratio", "ttr", "cos_corpus", "cos_neighbors"):
            fmt = lambda x: f"{x:.3f}"  # noqa: E731
        else:
            fmt = lambda x: f"{x:.2f}"  # noqa: E731
        lines.append(f"- {ts.FEATURE_LABELS[f]}: real {fmt(r)}, forgeries {fmt(g)}")
    counts: Counter = Counter()
    for nid, text in forged.items():
        counts.update(set(corpus.unseen_bigrams(text, nid)))
    common = [(b, c) for b, c in counts.most_common() if c >= 3][:15]
    return {"caught": caught, "total": int(len(forg)), "feature_table": "\n".join(lines),
            "impossible_bigrams": ", ".join(f'"{a} {b}"' for (a, b), _ in common),
            "bigram_counts": [[f"{a} {b}", c] for (a, b), c in common],
            "features_used": list(top.index)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train-rounds", type=int, nargs="+", default=[1])
    ap.add_argument("--name", default="D1")
    args = ap.parse_args()

    allf = pd.read_csv(FEATURES_FILE)
    df = allf[allf["round"].isin([0, *args.train_rounds])].reset_index(drop=True)
    cols = ts.FEATURES

    oof = cross_validate(df, cols)
    res = {"name": args.name, "train_rounds": args.train_rounds, "n_docs": len(df), "n_folds": N_FOLDS,
           "features": cols, "cv": scores(df, oof)}
    single = {}
    for f in cols:
        p = cross_validate(df, [f])
        single[f] = scores(df, p)
    single = pd.DataFrame(single).T
    res["single_feature"] = single.round(4).to_dict(orient="index")

    model = make_model().fit(df[cols], df.label)
    coefs = model[-1].coef_[0]
    res["coefficients"] = dict(sorted(zip(cols, map(float, coefs)), key=lambda kv: -abs(kv[1])))
    (config.OUTPUTS_DIR / "models").mkdir(exist_ok=True)
    joblib.dump({"model": model, "features": cols, "train_rounds": args.train_rounds},
                config.OUTPUTS_DIR / "models" / f"{args.name}.joblib")
    (config.OUTPUTS_DIR / f"detector_{args.name}.json").write_text(json.dumps(res, indent=1), encoding="utf-8")
    df.assign(p_forged_oof=oof)[["node_id", "name", "tier", "in_degree", "round", "label", "p_forged_oof"]] \
        .to_csv(config.OUTPUTS_DIR / f"predictions_{args.name}.csv", index=False)

    print(f"{args.name}: {len(df)} documents, {N_FOLDS}-fold grouped CV")
    print("  accuracy {accuracy:.3f}  AUC {auc:.3f}  pair accuracy {pair_accuracy:.3f}".format(**res["cv"]))
    print("\none-feature baselines (same CV):")
    print(single.sort_values("auc", ascending=False).round(3).to_string())
    print("\ncoefficients of the frozen model (standardized; positive = looks forged):")
    for k, v in res["coefficients"].items():
        print(f"  {v:+.2f}  {k}")

    if args.train_rounds == [1]:
        articles = json.loads(config.ARTICLES_FILE.read_text(encoding="utf-8"))
        sample = json.loads(config.SAMPLE_FILE.read_text(encoding="utf-8"))["sample"]
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from importlib import import_module
        load_forgery = import_module("03_features").load_forgery
        forged = {ch["node_id"]: t for ch in sample if (t := load_forgery(1, ch["node_id"]))}
        mem = memorization(sample, articles, forged)
        mem.to_csv(config.OUTPUTS_DIR / "memorization_round1.csv", index=False)
        print("\nmemorization (median [max]):")
        for doc, g in mem.groupby("doc"):
            parts = [f"{c} {g[c].median():.0f} [{g[c].max():.0f}]" for c in g.columns
                     if c.startswith(("own_", "any_")) and g[c].notna().any()]
            print(f"  {doc}: " + ", ".join(parts))
        corpus = ts.RealCorpus(articles, ts.stopwords())
        fb = feedback(df, oof, single, corpus, forged)
        (config.OUTPUTS_DIR / "feedback_round2.json").write_text(json.dumps(fb, indent=1), encoding="utf-8")
        print(f"\nround-2 feedback: caught {fb['caught']} of {fb['total']}")
        print(fb["feature_table"])
        print("impossible bigrams:", fb["impossible_bigrams"])


if __name__ == "__main__":
    main()
