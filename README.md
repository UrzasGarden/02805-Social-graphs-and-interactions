# Social Graphs and Interactions

A week 1 exploration of network structure using a Marvel superhero link graph.
The project combines a small interactive Cytoscape.js visualization with a NetworkX/Python analysis notebook.

## Contents

- `index.html` - project overview page
- `Week1/jonathan-week1.html` - interactive Marvel character network
- `Week1/week1_nodes.tsv` - 303 characters and their metadata
- `Week1/week1_edges.tsv` - 1,784 directed article-link relationships
- `Week1/Week1_Loke.ipynb` - notebook for loading and analyzing the graph
- `Week2/week2.html` - Week 2 main page: a comic-styled tour of the Barabási–Albert model vs. the real Week 1 network
- `Week2/growuniverse.html` / `week2.css` / `week2.js` - "Grow your Marvel", the interactive Barabási–Albert growth model page linked from Week 2

## Run

Open `https://urzasgarden.github.io/02805-Social-graphs-and-interactions/index.html` in a browser, then select a week to explore.
The visualizations load Cytoscape.js from a CDN, so an internet connection may be needed.

### Run locally

Paste in terminal:

```
python -m http.server 8000
```

Then open `http://localhost:8000/index.html`.
