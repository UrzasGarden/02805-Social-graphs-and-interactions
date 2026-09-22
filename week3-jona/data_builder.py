#!/usr/bin/env python3
"""
data_builder.py — The Auditor: Enron Network Data Pipeline
==========================================================
Downloads the real Enron Email Corpus from Stanford SNAP,
computes network centrality metrics, and exports a reduced
graph suitable for browser-based visualization.

Usage:
    python data_builder.py
"""

import gzip
import json
import os
import random
import urllib.request
from io import BytesIO
from collections import defaultdict

import networkx as nx

# ── Configuration ──────────────────────────────────────────────────────────────
SNAP_URL = "https://snap.stanford.edu/data/email-Enron.txt.gz"
OUTPUT_FILE = "graph_data.json"
TARGET_NODE_COUNT = 300          # Top-N nodes by degree to keep
K_CORE_MIN = 10                  # Minimum k-core to try
RANDOM_SEED = 42

# ── Fake Name Generation ──────────────────────────────────────────────────────
FIRST_NAMES = [
    "Arthur", "Barbara", "Charles", "Diana", "Edward", "Frances", "Gerald",
    "Helen", "Irving", "Janet", "Kenneth", "Linda", "Martin", "Nancy",
    "Oliver", "Patricia", "Quentin", "Rachel", "Stanley", "Teresa",
    "Ulysses", "Victoria", "Walter", "Xena", "Yuri", "Zelda",
    "Albert", "Beatrice", "Clifford", "Dorothy", "Eugene", "Florence",
    "Harold", "Irene", "Jerome", "Katherine", "Leonard", "Margaret",
    "Norman", "Ophelia", "Percival", "Rosemary", "Samuel", "Thelma",
    "Vernon", "Wanda", "Xavier", "Yvonne", "Warren", "Mildred",
    "Chester", "Gladys", "Milton", "Doris", "Rudolph", "Ethel",
    "Horace", "Bernice", "Lester", "Phyllis", "Willard", "Lucille",
    "Marvin", "Lorraine", "Dale", "Constance", "Boyd", "Geraldine",
    "Rex", "Maxine", "Dwight", "Vivian", "Glen", "Elaine", "Clyde",
    "Marilyn", "Floyd", "Evelyn", "Lance", "Loretta", "Troy", "Darlene",
    "Brent", "Bonnie", "Craig", "Donna", "Derek", "Gail", "Grant",
    "Joyce", "Kent", "Marlene", "Ross", "Norma", "Todd", "Roberta",
    "Wade", "Sylvia", "Blake", "Candice", "Brock", "Tammy", "Vince",
]

LAST_NAMES = [
    "Pendelton", "Whitfield", "Hargrove", "Drummond", "Callister",
    "Stanton", "Blackwell", "Mercer", "Ashworth", "Prescott",
    "Thornton", "Wainwright", "Bancroft", "Holloway", "Pemberton",
    "Rutherford", "Kingsley", "Crawford", "Whitmore", "Aldridge",
    "Cartwright", "Fairchild", "Harrington", "Langford", "Montague",
    "Pembroke", "Sinclair", "Vandermeer", "Worthington", "Ashford",
    "Bradshaw", "Carmichael", "Davenport", "Fitzgerald", "Greenfield",
    "Hamilton", "Jenkinson", "Lancaster", "Mitchell", "Northcott",
    "Osbourne", "Patterson", "Richardson", "Sheffield", "Townsend",
    "Underwood", "Wakefield", "Henderson", "Rockwell", "Garfield",
    "Buchanan", "Chamberlain", "Donaldson", "Eastwood", "Fairbanks",
    "Gladstone", "Hawthorne", "Ingersoll", "Jefferson", "Kensington",
    "Livingston", "Mcallister", "Newcastle", "Ogilvie", "Pendleton",
    "Quincy", "Remington", "Stratford", "Templeton", "Vanderbilt",
    "Wellington", "Armstrong", "Bloomberg", "Covington", "Ellsworth",
    "Foxworth", "Goldstein", "Harkness", "Kensington", "Mansfield",
    "Norwood", "Pickering", "Radcliffe", "Stockwell", "Whitaker",
]

DESK_LABELS = [
    "Desk 4B", "Desk 7A", "Desk 12C", "Cubicle 3", "Cubicle 9",
    "Office 101", "Office 202", "Suite 5", "Mailroom", "Annex B",
    "Terminal 6", "Station 8", "Bay 11", "Pod 2F", "Wing C",
]

TITLES = [
    "Jr.", "Sr.", "III", "IV", "II",
]


def generate_name(rng: random.Random, used: set) -> str:
    """Generate a unique fake 1990s corporate name."""
    for _ in range(500):
        roll = rng.random()
        if roll < 0.08:
            # ~8% chance of desk/location label
            name = rng.choice(DESK_LABELS)
        else:
            first = rng.choice(FIRST_NAMES)
            last = rng.choice(LAST_NAMES)
            if rng.random() < 0.06:
                name = f"{first} {rng.choice('ABCDEFGHIJKLMNOPQRSTUVWXYZ')}. {last}"
            elif rng.random() < 0.05:
                name = f"{first} {last} {rng.choice(TITLES)}"
            else:
                name = f"{first} {last}"
        if name not in used:
            used.add(name)
            return name
    # Fallback: append a number
    name = f"Employee #{rng.randint(1000, 9999)}"
    used.add(name)
    return name


# ── Main Pipeline ─────────────────────────────────────────────────────────────
def main():
    rng = random.Random(RANDOM_SEED)

    # 1. Download the dataset
    cache_path = "email-Enron.txt.gz"
    if os.path.exists(cache_path):
        print(f"[+] Using cached dataset: {cache_path}")
        with open(cache_path, "rb") as f:
            raw = f.read()
    else:
        print(f"[*] Downloading Enron email graph from SNAP...")
        print(f"    URL: {SNAP_URL}")
        response = urllib.request.urlopen(SNAP_URL)
        raw = response.read()
        with open(cache_path, "wb") as f:
            f.write(raw)
        print(f"[+] Downloaded {len(raw) / 1024:.0f} KB")

    # 2. Parse edge list into a directed graph
    print("[*] Parsing edge list...")
    G_full = nx.DiGraph()
    with gzip.open(BytesIO(raw), "rt") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) >= 2:
                src, dst = int(parts[0]), int(parts[1])
                if src != dst:  # skip self-loops
                    G_full.add_edge(src, dst)

    print(f"[+] Full graph: {G_full.number_of_nodes()} nodes, "
          f"{G_full.number_of_edges()} edges")

    # 3. Reduce the graph — two strategies, pick the best result
    print("[*] Reducing graph for browser rendering...")

    # Strategy A: k-core decomposition (undirected view)
    G_undirected = G_full.to_undirected()
    best_subgraph = None

    for k in range(30, K_CORE_MIN - 1, -1):
        core = nx.k_core(G_undirected, k=k)
        if 150 <= core.number_of_nodes() <= 500:
            print(f"    → {k}-core has {core.number_of_nodes()} nodes — using it!")
            best_subgraph = G_full.subgraph(core.nodes()).copy()
            break
        elif core.number_of_nodes() > 500:
            continue
        elif core.number_of_nodes() < 150 and k == K_CORE_MIN:
            break

    # Strategy B: Top-N by total degree (fallback)
    if best_subgraph is None:
        print(f"    → k-core didn't yield a good size; using top {TARGET_NODE_COUNT} "
              f"nodes by degree")
        degree_dict = dict(G_full.degree())
        top_nodes = sorted(degree_dict, key=degree_dict.get, reverse=True)[:TARGET_NODE_COUNT]
        best_subgraph = G_full.subgraph(top_nodes).copy()
        # Take the largest weakly connected component
        components = list(nx.weakly_connected_components(best_subgraph))
        largest_cc = max(components, key=len)
        best_subgraph = best_subgraph.subgraph(largest_cc).copy()

    G = best_subgraph
    print(f"[+] Reduced graph: {G.number_of_nodes()} nodes, "
          f"{G.number_of_edges()} edges")

    # 4. Relabel nodes to sequential IDs for clean JSON
    node_list = sorted(G.nodes())
    old_to_new = {old: i for i, old in enumerate(node_list)}
    G = nx.relabel_nodes(G, old_to_new)

    # 5. Compute centralities
    print("[*] Computing centrality measures...")

    in_deg = nx.in_degree_centrality(G)
    out_deg = nx.out_degree_centrality(G)
    print("    ✓ Degree centrality")

    betweenness = nx.betweenness_centrality(G, normalized=True)
    print("    ✓ Betweenness centrality")

    closeness = nx.closeness_centrality(G)
    print("    ✓ Closeness centrality")

    try:
        eigenvector = nx.eigenvector_centrality(G, max_iter=1000, tol=1e-06)
    except nx.PowerIterationFailedConvergence:
        print("    ⚠ Eigenvector centrality didn't converge; using PageRank as proxy")
        eigenvector = nx.pagerank(G, alpha=0.85)
    print("    ✓ Eigenvector centrality")

    # 6. Normalize each metric to [0, 1]
    def normalize(d: dict) -> dict:
        vals = list(d.values())
        lo, hi = min(vals), max(vals)
        if hi - lo < 1e-12:
            return {k: 0.5 for k in d}
        return {k: (v - lo) / (hi - lo) for k, v in d.items()}

    in_deg_n = normalize(in_deg)
    out_deg_n = normalize(out_deg)
    between_n = normalize(betweenness)
    close_n = normalize(closeness)
    eigen_n = normalize(eigenvector)

    # 7. Generate fake names
    print("[*] Generating fake employee names...")
    used_names = set()
    names = {}
    for node in sorted(G.nodes()):
        names[node] = generate_name(rng, used_names)

    # 8. Build JSON output
    print("[*] Exporting to graph_data.json...")

    nodes_out = []
    for node in sorted(G.nodes()):
        nodes_out.append({
            "id": node,
            "name": names[node],
            "metrics": {
                "in_degree":    round(in_deg_n[node], 6),
                "out_degree":   round(out_deg_n[node], 6),
                "betweenness":  round(between_n[node], 6),
                "closeness":    round(close_n[node], 6),
                "eigenvector":  round(eigen_n[node], 6),
            },
            "raw_metrics": {
                "in_degree":    round(in_deg[node], 6),
                "out_degree":   round(out_deg[node], 6),
                "betweenness":  round(betweenness[node], 6),
                "closeness":    round(closeness[node], 6),
                "eigenvector":  round(eigenvector[node], 6),
            },
        })

    edges_out = []
    for src, dst in G.edges():
        edges_out.append({"source": src, "target": dst})

    # Find the "answers" (top node for each metric) for reference
    answers = {
        "out_degree":   max(out_deg_n, key=out_deg_n.get),
        "closeness":    max(close_n, key=close_n.get),
        "betweenness":  max(between_n, key=between_n.get),
        "eigenvector":  max(eigen_n, key=eigen_n.get),
    }

    output = {
        "meta": {
            "description": "Enron Email Network — reduced subgraph with centrality metrics",
            "original_source": SNAP_URL,
            "node_count": G.number_of_nodes(),
            "edge_count": G.number_of_edges(),
            "answers_top_node": {
                k: {"id": v, "name": names[v]}
                for k, v in answers.items()
            },
        },
        "nodes": nodes_out,
        "edges": edges_out,
    }

    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), OUTPUT_FILE)
    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)

    size_kb = os.path.getsize(output_path) / 1024
    print(f"\n[✓] Exported {OUTPUT_FILE} ({size_kb:.0f} KB)")
    print(f"    Nodes: {G.number_of_nodes()}")
    print(f"    Edges: {G.number_of_edges()}")
    print(f"\n    ── Answer Key ──")
    for metric, node_id in answers.items():
        print(f"    {metric:15s} → Node {node_id:>4d}  ({names[node_id]})")
    print()


if __name__ == "__main__":
    main()
