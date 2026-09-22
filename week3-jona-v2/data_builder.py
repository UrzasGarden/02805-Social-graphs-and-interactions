#!/usr/bin/env python3
"""
data_builder.py — Marvel Universe Network → graph_data.json

Usage:
    python data_builder.py                        # uses placeholder Erdős–Rényi graph
    python data_builder.py --csv edges.csv        # loads your own edge list (source,target)

Output:
    graph_data.json  with { "nodes": [...], "edges": [...] }
"""

import argparse
import json
import pathlib

import networkx as nx


# ── 1. Build / Load the graph ────────────────────────────────────────────────

def load_graph_from_csv(csv_path: str, nodes_path: str = None) -> nx.Graph:
    """
    Load an undirected graph from an edge list.

    Supports:
      - CSV  (comma-separated, source,target)
      - TSV  (tab-separated,   source\\ttarget)  — auto-detected

    If `nodes_path` is provided (a TSV with node_id \\t name \\t …),
    node IDs are mapped to human-readable display names.
    Lines starting with '#' are treated as comments and skipped.
    """
    import csv

    # Detect delimiter
    with open(csv_path, "r", encoding="utf-8") as f:
        sample = ""
        for line in f:
            if not line.startswith("#"):
                sample = line
                break
    delimiter = "\t" if "\t" in sample else ","

    # Build optional node_id → display name mapping
    id_to_name = {}
    if nodes_path:
        with open(nodes_path, "r", encoding="utf-8") as f:
            reader = csv.reader(f, delimiter="\t")
            for row in reader:
                if not row or row[0].startswith("#"):
                    continue
                # header row
                if row[0] == "node_id":
                    continue
                node_id = row[0].strip()
                display_name = row[1].strip() if len(row) > 1 else node_id
                id_to_name[node_id] = display_name

    G = nx.Graph()
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f, delimiter=delimiter)
        for row in reader:
            if not row or row[0].startswith("#"):
                continue
            # Skip header row
            if row[0].strip().lower() in ("source", "src", "from"):
                continue
            if len(row) >= 2:
                src = row[0].strip()
                tgt = row[1].strip()
                # Map to display names if available
                src_name = id_to_name.get(src, src.replace("_", " "))
                tgt_name = id_to_name.get(tgt, tgt.replace("_", " "))
                G.add_edge(src_name, tgt_name)

    return G


def build_placeholder_graph(n: int = 300, p: float = 0.015, seed: int = 42) -> nx.Graph:
    """
    Generate an Erdős–Rényi random graph as a stand-in for the Marvel
    co-appearance network.  Node names are fake "hero" labels so the
    game feels realistic while testing.
    """
    hero_prefixes = [
        "Spider", "Iron", "Captain", "Doctor", "Black", "Scarlet",
        "Silver", "Dark", "Shadow", "Storm", "Nova", "Star", "Moon",
        "Night", "Crimson", "Frost", "Thunder", "Cosmic", "Hyper", "Ultra",
    ]
    hero_suffixes = [
        "Man", "Woman", "Knight", "Hawk", "Panther", "Witch",
        "Surfer", "Blade", "Wing", "Fist", "Claw", "Lord",
        "Strike", "Bolt", "Fury", "Rider", "Flame", "Venom", "Wolf", "Eye",
    ]

    G = nx.erdos_renyi_graph(n, p, seed=seed)

    # Assign readable names
    mapping = {}
    used_names = set()
    idx = 0
    for node in G.nodes():
        while True:
            name = f"{hero_prefixes[idx % len(hero_prefixes)]}-{hero_suffixes[idx // len(hero_prefixes) % len(hero_suffixes)]}"
            if idx >= len(hero_prefixes) * len(hero_suffixes):
                name += f"-{idx}"
            idx += 1
            if name not in used_names:
                used_names.add(name)
                break
        mapping[node] = name

    G = nx.relabel_nodes(G, mapping)
    return G


# ── 2. Extract Giant Component ───────────────────────────────────────────────

def giant_component(G: nx.Graph) -> nx.Graph:
    """Return the largest connected component as a new graph."""
    largest_cc = max(nx.connected_components(G), key=len)
    return G.subgraph(largest_cc).copy()


# ── 3. Compute Centralities ─────────────────────────────────────────────────

def compute_centralities(G: nx.Graph) -> dict:
    """Return dict[node] → {degree, betweenness, closeness}."""
    deg = nx.degree_centrality(G)
    bet = nx.betweenness_centrality(G)
    clo = nx.closeness_centrality(G)

    stats = {}
    for node in G.nodes():
        stats[node] = {
            "degree": round(deg[node], 6),
            "betweenness": round(bet[node], 6),
            "closeness": round(clo[node], 6),
        }
    return stats


# ── 4. Export JSON ───────────────────────────────────────────────────────────

def export_json(G: nx.Graph, stats: dict, out_path: str = "graph_data.json"):
    """Write nodes + edges to a JSON file consumable by the web app."""
    nodes = []
    for i, node in enumerate(sorted(G.nodes())):
        nodes.append({
            "id": i,
            "name": str(node),
            "degree": stats[node]["degree"],
            "betweenness": stats[node]["betweenness"],
            "closeness": stats[node]["closeness"],
        })

    # Build name → id lookup
    name_to_id = {n["name"]: n["id"] for n in nodes}

    edges = []
    for u, v in G.edges():
        edges.append({
            "source": name_to_id[str(u)],
            "target": name_to_id[str(v)],
        })

    payload = {"nodes": nodes, "edges": edges}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    print(f"✅  Exported {len(nodes)} nodes and {len(edges)} edges → {out_path}")


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Build graph_data.json for Graphle")
    parser.add_argument(
        "--csv",
        type=str,
        default=None,
        help="Path to an edge list (CSV or TSV). If omitted, a placeholder graph is generated.",
    )
    parser.add_argument(
        "--nodes",
        type=str,
        default=None,
        help="Path to a TSV node list (node_id, name, …) for human-readable names.",
    )
    parser.add_argument(
        "-n", type=int, default=300,
        help="Number of nodes for placeholder graph (default: 300)",
    )
    parser.add_argument(
        "-p", type=float, default=0.015,
        help="Edge probability for placeholder graph (default: 0.015)",
    )
    parser.add_argument(
        "-o", "--output", type=str, default="graph_data.json",
        help="Output JSON filename (default: graph_data.json)",
    )
    args = parser.parse_args()

    # Load or generate
    if args.csv:
        print(f"📂  Loading graph from {args.csv} …")
        G = load_graph_from_csv(args.csv, nodes_path=args.nodes)
    else:
        print(f"🎲  Generating placeholder Erdős–Rényi graph (N={args.n}, p={args.p}) …")
        G = build_placeholder_graph(n=args.n, p=args.p)

    print(f"   Raw graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")

    # Giant component
    G = giant_component(G)
    print(f"   Giant component: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")

    # Centralities
    print("🔬  Computing centralities …")
    stats = compute_centralities(G)

    # Export
    out = pathlib.Path(__file__).parent / args.output
    export_json(G, stats, str(out))


if __name__ == "__main__":
    main()
