"""Shared configuration for the Week 5 "Forger" pipeline: paths and sample sizes.

Forgeries are written by Fable subagents inside the Claude Code session, not
by an API call, so there are no keys, prices or model clients in here.
"""
from __future__ import annotations

from pathlib import Path

# ---------------------------------------------------------------- paths ----
WEEK5_DIR = Path(__file__).resolve().parent.parent
DATA_RAW = WEEK5_DIR / "data" / "raw"
DATA_CLEAN = WEEK5_DIR / "data" / "clean"
PROMPTS_DIR = WEEK5_DIR / "prompts"            # templates
OUTPUTS_DIR = WEEK5_DIR / "outputs"
RENDERED_DIR = OUTPUTS_DIR / "prompts"         # rendered prompts, exactly as sent
FORGERIES_DIR = OUTPUTS_DIR / "forgeries"      # one .txt per character, written by the forger
TRANSCRIPTS_DIR = OUTPUTS_DIR / "transcripts"  # copied forger transcripts (provenance)
USAGE_LOG = OUTPUTS_DIR / "usage_log.csv"
FIGURES_DIR = WEEK5_DIR / "figures"
GAME_DIR = WEEK5_DIR / "game"
NOTEBOOKS_DIR = WEEK5_DIR / "notebooks"

ARTICLES_FILE = DATA_CLEAN / "articles.json"   # all 303 cleaned real pages
SAMPLE_FILE = DATA_CLEAN / "sample.json"       # the 60 + 2 style references

# Claude Code keeps session transcripts here; subagent transcripts live in
# <project>/<session>/subagents/agent-<id>.jsonl
CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"

# ---------------------------------------------------------- course data ----
COURSE_DATA_URL = "https://sunelehmann.com/socialgraphs2026-web/data/"
RAW_FILES = ["marvel_pages.zip", "week1_nodes.tsv", "week1_edges.tsv"]

# ---------------------------------------------------------------- sample ----
MIN_CLEAN_WORDS = 400       # a page must have at least this many cleaned words
PER_TIER = 20               # characters per in-degree tier (high / middle / low)
MAX_TARGET_WORDS = 1500     # comparison text = first <=1500 words of the real page
N_STYLE_REFS = 2            # fixed round-3 style references, excluded from sample
STYLE_REF_WORDS = (700, 1300)   # "mid-length" window for the style references
RANDOM_SEED = 2805

# --------------------------------------------------------------- forging ----
FORGER_MODEL = "claude-fable-5-1"   # every forger transcript must show this model
FORGER_TOOL = "Write"               # the only tool a forger may call, exactly once
LENGTH_TOLERANCE = (0.7, 1.3)       # "roughly the target length" for --check
