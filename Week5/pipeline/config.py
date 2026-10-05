"""Shared configuration for the Week 5 "Forger" pipeline.

Paths, model names, price table and budget. Nothing in here touches the
network or the API key; scripts read the key themselves from the environment.
"""
from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------- paths ----
WEEK5_DIR = Path(__file__).resolve().parent.parent
DATA_RAW = WEEK5_DIR / "data" / "raw"
DATA_CLEAN = WEEK5_DIR / "data" / "clean"
PROMPTS_DIR = WEEK5_DIR / "prompts"
OUTPUTS_DIR = WEEK5_DIR / "outputs"
FORGERIES_DIR = OUTPUTS_DIR / "forgeries"
FIGURES_DIR = WEEK5_DIR / "figures"
GAME_DIR = WEEK5_DIR / "game"
NOTEBOOKS_DIR = WEEK5_DIR / "notebooks"

COST_LOG = OUTPUTS_DIR / "cost_log.csv"
BATCHES_FILE = OUTPUTS_DIR / "batches.json"
ARTICLES_FILE = DATA_CLEAN / "articles.json"   # all 303 cleaned real pages
SAMPLE_FILE = DATA_CLEAN / "sample.json"       # the 60 + 2 style references

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

# ---------------------------------------------------------------- models ----

def _env(name: str, default: str) -> str:
    """Read an env var and strip whitespace and stray commas.

    The cloud environment currently sets FORGE_MODEL / PILOT_MODEL with a
    trailing comma; the API would reject that, so sanitize here.
    """
    value = os.environ.get(name, default)
    value = value.strip().strip(",").strip()
    return value or default

FORGE_MODEL = _env("FORGE_MODEL", "claude-fable-5-1")
PILOT_MODEL = _env("PILOT_MODEL", "claude-haiku-4-5-20251001")
API_KEY_ENV = "FORGE_API_KEY"   # never read any other variable, never print it

# --------------------------------------------------------------- pricing ----
# USD per million tokens. DOUBLE-CHECK against
# https://docs.claude.com/en/docs/about-claude/pricing before any paid run.
# cache_write = 1.25 x input (5-minute TTL); cache_read is model specific.
PRICES: dict[str, dict[str, float]] = {
    "claude-fable-5-1":           {"input": 10.0, "output": 50.0, "cache_write": 12.5, "cache_read": 0.25},
    "claude-haiku-4-5-20251001":  {"input": 1.0,  "output": 5.0,  "cache_write": 1.25, "cache_read": 0.10},
    "claude-haiku-4-5":           {"input": 1.0,  "output": 5.0,  "cache_write": 1.25, "cache_read": 0.10},
}
BATCH_DISCOUNT = 0.5        # Message Batches API bills every token at half price

BUDGET_USD = float(_env("BUDGET_USD", "40"))

# ------------------------------------------------------------ generation ----
MAX_TOKENS_FACTOR = 1.4     # max_tokens ~ 1.4 x target length in tokens
WORDS_TO_TOKENS = 1.35      # rough English words -> tokens, used for dry-run estimates


def price_for(model: str) -> dict[str, float]:
    """Price row for a model; raises instead of guessing for unknown models."""
    if model in PRICES:
        return PRICES[model]
    # allow dated snapshots of a known family, e.g. claude-haiku-4-5-2025xxxx
    for known, row in PRICES.items():
        if model.startswith(known):
            return row
    raise KeyError(f"No price entry for model {model!r}; add it to config.PRICES")


def estimate_cost(model: str, input_tokens: int, output_tokens: int,
                  cache_write_tokens: int = 0, cache_read_tokens: int = 0,
                  batch: bool = False) -> float:
    """Estimated USD for one request. input_tokens = uncached input only."""
    p = price_for(model)
    usd = (input_tokens * p["input"] + output_tokens * p["output"]
           + cache_write_tokens * p["cache_write"] + cache_read_tokens * p["cache_read"]) / 1e6
    return usd * (BATCH_DISCOUNT if batch else 1.0)
