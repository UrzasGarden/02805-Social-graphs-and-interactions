"""Phase 1: download the course data, clean the real articles, pick the sample.

Usage:  python pipeline/01_prepare.py
No API calls. Re-runnable on a fresh VM: downloads into data/raw/ if missing.

Outputs (committed):
  data/clean/articles.json    all 303 cleaned pages + network metadata
  data/clean/sample.json      60 sampled characters + 2 style references
  outputs/phase1_inspection.md  raw pages, raw-vs-clean pairs, sample table
"""
from __future__ import annotations

import csv
import json
import random
import sys
import urllib.parse
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path

import networkx as nx
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
from cleaning import clean_article, truncate_words, word_count, prose_words  # noqa: E402


# ---------------------------------------------------------------- download --
def download_raw() -> None:
    config.DATA_RAW.mkdir(parents=True, exist_ok=True)
    for name in config.RAW_FILES:
        dest = config.DATA_RAW / name
        if dest.exists() and dest.stat().st_size > 0:
            continue
        url = config.COURSE_DATA_URL + name
        print(f"downloading {url}")
        with urllib.request.urlopen(url, timeout=120) as r, open(dest, "wb") as f:
            f.write(r.read())


# -------------------------------------------------------------------- load --
def load_pages() -> dict[str, str]:
    """Loading snippet from the course data page: dict keyed by node_id."""
    with zipfile.ZipFile(config.DATA_RAW / "marvel_pages.zip") as z:
        return {
            urllib.parse.unquote(n.split("/")[-1][:-4]): z.read(n).decode("utf-8")
            for n in z.namelist()
            if n.endswith(".txt") and "README" not in n
        }


def load_network() -> tuple[pd.DataFrame, nx.DiGraph]:
    nodes = pd.read_csv(config.DATA_RAW / "week1_nodes.tsv", sep="\t", comment="#",
                        quoting=csv.QUOTE_NONE)
    edges = pd.read_csv(config.DATA_RAW / "week1_edges.tsv", sep="\t", comment="#",
                        names=["source", "target"])
    G = nx.DiGraph()
    G.add_nodes_from(nodes.node_id)
    G.add_edges_from(edges.itertuples(index=False))
    return nodes, G


# ------------------------------------------------------------------ sample --
def _systematic(rows: list[dict], k: int, rng: random.Random) -> list[dict]:
    """k rows spread evenly over an already-sorted list (random start offset)."""
    step = len(rows) / k
    start = rng.random() * step
    return [rows[min(int(start + i * step), len(rows) - 1)] for i in range(k)]


def _headings(clean: str) -> list[str]:
    return [p[3:-3] for p in clean.split("\n\n") if p.startswith("== ")]


def pick_sample(articles: dict[str, dict]) -> dict:
    rng = random.Random(config.RANDOM_SEED)
    eligible = [a for a in articles.values() if a["clean_words"] >= config.MIN_CLEAN_WORDS]
    eligible.sort(key=lambda a: (a["in_degree"], a["node_id"]))

    # Style references: mid-length, mid in-degree, textbook section structure,
    # no repeated headings, and a single character (not a team or duo).
    n = len(eligible)
    def good_ref(a):
        h = _headings(a["clean"])
        return (config.STYLE_REF_WORDS[0] <= a["clean_words"] <= config.STYLE_REF_WORDS[1]
                and {"Publication history", "Fictional character biography", "Powers and abilities"} <= set(h)
                and len(h) == len(set(h)) and " and " not in a["name"] and "team" not in a["description"].lower())
    mid_pool = [a for a in eligible[n // 3: 2 * n // 3] if good_ref(a)]
    style_refs = rng.sample(mid_pool, config.N_STYLE_REFS)
    ref_ids = {a["node_id"] for a in style_refs}
    eligible = [a for a in eligible if a["node_id"] not in ref_ids]

    # Three in-degree terciles; inside each, a systematic sample so the picks
    # cover the tier's whole range (a plain random draw tends to miss the few
    # very famous characters at the top).
    n = len(eligible)
    tiers = {"low": eligible[: n // 3], "middle": eligible[n // 3: 2 * n // 3], "high": eligible[2 * n // 3:]}
    chosen = [(tier, a) for tier in ("high", "middle", "low") for a in _systematic(tiers[tier], config.PER_TIER, rng)]
    assert len({a["node_id"] for _, a in chosen}) == 3 * config.PER_TIER
    chosen.sort(key=lambda t: -t[1]["in_degree"])

    sample = []
    for tier, a in chosen:
        comparison = truncate_words(a["clean"], config.MAX_TARGET_WORDS)
        target = word_count(comparison)
        whole = target == a["clean_words"]
        sample.append({
            "node_id": a["node_id"], "name": a["name"], "description": a["description"],
            "url": a["url"], "tier": tier, "in_degree": a["in_degree"], "out_degree": a["out_degree"],
            "clean_words": a["clean_words"], "target_words": target, "is_whole_article": whole,
            "length_note": ("This is the whole article." if whole else
                            "The real article is longer. Write its opening part and stop at a natural section boundary."),
            "out_neighbors": a["out_neighbors"], "in_neighbors": a["in_neighbors"],
            "comparison_text": comparison,
        })
    refs = [{"node_id": a["node_id"], "name": a["name"], "in_degree": a["in_degree"],
             "clean_words": a["clean_words"], "text": a["clean"]} for a in style_refs]
    return {"seed": config.RANDOM_SEED, "min_clean_words": config.MIN_CLEAN_WORDS,
            "max_target_words": config.MAX_TARGET_WORDS, "n_eligible": len(eligible) + len(refs),
            "tier_bounds": {t: [rows[0]["in_degree"], rows[-1]["in_degree"]] for t, rows in tiers.items()},
            "sample": sample, "style_references": refs}


# -------------------------------------------------------------- inspection --
def side_by_side(raw: str, clean: str, name: str) -> str:
    return (f"### {name}\n\n<table><tr><th>raw ({len(raw.split())} words)</th>"
            f"<th>cleaned ({word_count(clean)} words)</th></tr>\n<tr>\n"
            f"<td valign=top><pre>{_esc(raw)}</pre></td>\n"
            f"<td valign=top><pre>{_esc(clean)}</pre></td>\n</tr></table>\n\n")


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def write_inspection(pages, articles, sample, raw_names, pair_names) -> None:
    md = ["# Phase 1 inspection\n", "Generated by `pipeline/01_prepare.py`. Nothing here is AI-written; all text is Wikipedia (CC BY-SA 4.0).\n"]
    md.append("\n## 1. Three raw pages, verbatim\n")
    for n in raw_names:
        md.append(f"### {n} ({len(pages[n])} chars)\n\n```text\n{pages[n]}\n```\n")
    md.append("\n## 2. Raw vs cleaned\n")
    for n in pair_names:
        md.append(side_by_side(pages[n], articles[n]["clean"], n))
    md.append("\n## 3. Sample (60 characters, stratified by in-degree)\n\n")
    md.append("| # | tier | name | in-degree | clean words | target words | whole article? |\n|---|---|---|---|---|---|---|\n")
    for i, s in enumerate(sample["sample"], 1):
        md.append(f"| {i} | {s['tier']} | {s['name']} | {s['in_degree']} | {s['clean_words']} | {s['target_words']} | {'yes' if s['is_whole_article'] else 'no'} |\n")
    md.append("\n### Style references (round 3, excluded from sample)\n\n")
    for r in sample["style_references"]:
        md.append(f"- {r['name']}: in-degree {r['in_degree']}, {r['clean_words']} cleaned words\n")
    (config.OUTPUTS_DIR / "phase1_inspection.md").write_text("".join(md), encoding="utf-8")


def section_stats(articles: dict[str, dict]) -> None:
    """Print what cleaned articles look like, to write prompts/format_notes.txt from."""
    first_heading = Counter(); heading_count = Counter(); n_secs = []; para_words = []; order = Counter()
    for a in articles.values():
        heads = [ln[3:-3] for ln in a["clean"].split("\n\n") if ln.startswith("== ")]
        n_secs.append(len(heads))
        if heads: first_heading[heads[0]] += 1
        for h in heads: heading_count[h] += 1
        for i, h in enumerate(heads[:6]): order[(i, h)] += 1
        for p in a["clean"].split("\n\n"):
            if not p.startswith("== "): para_words.append(len(p.split()))
    print("\n--- cleaned-article shape ---")
    print("sections per article: median", sorted(n_secs)[len(n_secs)//2], "min", min(n_secs), "max", max(n_secs))
    print("paragraph words: median", sorted(para_words)[len(para_words)//2], "mean", round(sum(para_words)/len(para_words), 1))
    print("most common headings:", heading_count.most_common(12))
    print("most common first heading:", first_heading.most_common(5))
    for pos in range(4):
        print(f"heading at position {pos}:", [(h, c) for (p, h), c in order.most_common() if p == pos][:4])


# -------------------------------------------------------------------- main --
def main() -> None:
    download_raw()
    pages = load_pages()
    nodes, G = load_network()
    assert set(pages) == set(nodes.node_id), "pages and node file disagree"
    name_of = dict(zip(nodes.node_id, nodes.name))
    print(f"pages: {len(pages)}  graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")

    articles: dict[str, dict] = {}
    for row in nodes.itertuples(index=False):
        raw = pages[row.node_id]
        clean = clean_article(raw)
        articles[row.node_id] = {
            "node_id": row.node_id, "name": row.name, "description": row.description, "url": row.url,
            "in_degree": G.in_degree(row.node_id), "out_degree": G.out_degree(row.node_id),
            "out_neighbors": sorted(name_of[t] for t in G.successors(row.node_id)),
            "in_neighbors": sorted(name_of[s] for s in G.predecessors(row.node_id)),
            "raw_words": len(raw.split()), "clean_words": word_count(clean), "clean": clean,
        }
    config.DATA_CLEAN.mkdir(parents=True, exist_ok=True)
    config.ARTICLES_FILE.write_text(json.dumps(articles, ensure_ascii=False, indent=0), encoding="utf-8")

    kept = sum(a["clean_words"] for a in articles.values()); total = sum(a["raw_words"] for a in articles.values())
    print(f"cleaning kept {kept}/{total} words ({kept/total:.1%}); "
          f"{sum(a['clean_words'] >= config.MIN_CLEAN_WORDS for a in articles.values())} pages have >= {config.MIN_CLEAN_WORDS} cleaned words")

    sample = pick_sample(articles)
    config.SAMPLE_FILE.write_text(json.dumps(sample, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"sample: {len(sample['sample'])} characters, {sum(s['is_whole_article'] for s in sample['sample'])} whole articles, "
          f"style refs: {[r['name'] for r in sample['style_references']]}")

    by_len = sorted(articles, key=lambda k: articles[k]["clean_words"])
    raw_names = ["Ajak", by_len[len(by_len) // 2], "Spider-Man"]
    pair_names = [by_len[len(by_len) // 4], by_len[3 * len(by_len) // 4]]
    write_inspection(pages, articles, sample, raw_names, pair_names)
    section_stats(articles)


if __name__ == "__main__":
    main()
