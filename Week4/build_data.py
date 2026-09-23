#!/usr/bin/env python3
"""
build_data.py — Philosophers network -> graph_data.json

Reads week4_philosophers_edges.tsv (directed, weighted) and
week4_philosophers_nodes.tsv (node metadata), builds the undirected
weighted network (summing both directions, as instructed by the
course data release), computes each node's degree/strength on that
full network, and computes Louvain communities on the full
*unweighted* network (per the assignment's drawing rules).

The disparity filter itself is NOT applied here — it runs live in
the browser so the user can drag the alpha slider. This script only
precomputes the per-node quantities (k_i, s_i) the filter formula
needs, plus community labels for coloring.

Output: graph_data.json  { "nodes": [...], "edges": [...] }
"""

import csv
import json
import pathlib

import networkx as nx

HERE = pathlib.Path(__file__).parent
EDGES_TSV = HERE / "week4_philosophers_edges.tsv"
NODES_TSV = HERE / "week4_philosophers_nodes.tsv"
OUT_JSON = HERE / "graph_data.json"


def read_tsv_rows(path):
    with open(path, encoding="utf-8") as f:
        reader = csv.reader(f, delimiter="\t")
        for row in reader:
            if not row or row[0].startswith("#"):
                continue
            yield row


def load_node_meta():
    rows = list(read_tsv_rows(NODES_TSV))
    header, rows = rows[0], rows[1:]
    idx = {name: i for i, name in enumerate(header)}
    meta = {}
    for row in rows:
        node_id = row[idx["node_id"]]
        meta[node_id] = {
            "name": row[idx["name"]],
            "wikidata_id": row[idx["wikidata_id"]],
            "url": row[idx["url"]],
            "era": row[idx["era"]],
            "subfields": row[idx["subfields"]],
            "description": row[idx["description"]],
        }
    return meta


def build_undirected_weighted(meta):
    """Sum both directions of the directed edge list into one undirected,
    weighted graph, as the data release instructs."""
    G = nx.Graph()
    G.add_nodes_from(meta.keys())

    rows = list(read_tsv_rows(EDGES_TSV))
    header, rows = rows[0], rows[1:]
    idx = {name: i for i, name in enumerate(header)}

    for row in rows:
        u = row[idx["source"]]
        v = row[idx["target"]]
        w = int(row[idx["weight"]])
        if u == v:
            continue
        if G.has_edge(u, v):
            G[u][v]["weight"] += w
        else:
            G.add_edge(u, v, weight=w)

    return G


def main():
    print("Loading node metadata...")
    meta = load_node_meta()
    print(f"  {len(meta)} philosophers")

    print("Building undirected weighted network (summing both directions)...")
    G = build_undirected_weighted(meta)
    print(f"  {G.number_of_nodes()} nodes, {G.number_of_edges()} undirected weighted edges")

    isolates = list(nx.isolates(G))
    print(f"  {len(isolates)} isolated nodes (no undirected link) -- kept in node list, "
          f"excluded from viz on the frontend")

    print("Computing Louvain communities on the full UNWEIGHTED network...")
    G_unweighted = nx.Graph()
    G_unweighted.add_nodes_from(G.nodes())
    G_unweighted.add_edges_from(G.edges())
    communities = nx.community.louvain_communities(G_unweighted, weight=None, seed=42)
    communities.sort(key=len, reverse=True)
    node_to_comm = {}
    for cid, comm in enumerate(communities):
        for n in comm:
            node_to_comm[n] = cid
    print(f"  {len(communities)} communities, sizes: {[len(c) for c in communities[:10]]}"
          f"{' ...' if len(communities) > 10 else ''}")

    # Representative name per community = highest-strength member
    strength = {n: sum(d["weight"] for _, _, d in G.edges(n, data=True)) for n in G.nodes()}
    comm_rep = {}
    for cid, comm in enumerate(communities):
        rep = max(comm, key=lambda n: strength.get(n, 0))
        comm_rep[cid] = meta[rep]["name"]

    print("Assembling node/edge records...")
    node_ids = sorted(G.nodes())
    id_to_idx = {node_id: i for i, node_id in enumerate(node_ids)}

    nodes = []
    for node_id in node_ids:
        m = meta[node_id]
        desc = m["description"]
        if len(desc) > 220:
            desc = desc[:217].rsplit(" ", 1)[0] + "..."
        cid = node_to_comm[node_id]
        nodes.append({
            "id": id_to_idx[node_id],
            "name": m["name"],
            "era": m["era"],
            "subfields": m["subfields"],
            "url": m["url"],
            "description": desc,
            "degree": G.degree(node_id),
            "strength": strength.get(node_id, 0),
            "community": cid,
            "community_label": comm_rep[cid],
        })

    edges = []
    for u, v, d in G.edges(data=True):
        edges.append({
            "source": id_to_idx[u],
            "target": id_to_idx[v],
            "weight": d["weight"],
        })

    payload = {
        "meta": {
            "description": "Pre-1900 philosophers on English Wikipedia. Directed article "
                            "links, weight = link count, summed into an undirected weighted "
                            "network. Communities via Louvain on the full unweighted network.",
            "n_communities": len(communities),
        },
        "nodes": nodes,
        "edges": edges,
    }

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Exported {len(nodes)} nodes, {len(edges)} edges -> {OUT_JSON}")
    print(f"File size: {OUT_JSON.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
