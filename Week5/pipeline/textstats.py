"""One tokenizer and one set of preprocessing choices for every Week 5 feature.

Preprocessing (identical for real and forged text):
  * Input is text that already went through cleaning.clean_article().
  * Heading lines (== Heading ==) are dropped; only prose paragraphs are analysed.
  * Tokens: lowercase runs of letters/digits, keeping one internal apostrophe
    ("doom's" stays one token). Hyphens split ("spider-man" -> spider, man).
    Punctuation is not a token; it is counted separately on the prose text.
  * Bigrams never cross a paragraph boundary.
  * Sentences: split at . ! ? followed by whitespace and an upper-case letter,
    digit or quote, except after common abbreviations and single initials;
    paragraph ends are sentence ends. Sentence length is counted in tokens.
  * Stopwords: NLTK English list (198 words), fetched once into .cache/.
  * Length-sensitive ratios (type/token, hapax) use non-overlapping 400-token
    windows, averaged, so documents of different length are comparable.
"""
from __future__ import annotations

import io
import re
import sys
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
from cleaning import HEADING_RE  # noqa: E402

TOKEN_RE = re.compile(r"[^\W_]+(?:'[^\W_]+)?", re.UNICODE)
WINDOW = 400
NLTK_DIR = config.WEEK5_DIR / ".cache" / "nltk_data"
STOPWORDS_URL = "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/stopwords.zip"
ABBREVIATIONS = {"dr", "mr", "mrs", "ms", "st", "jr", "sr", "vs", "no", "vol", "inc", "lt", "gen", "capt",
                 "col", "sgt", "prof", "rev", "mt", "ft", "co", "corp", "ltd", "dept", "e.g", "i.e", "u.s",
                 "u.k", "approx", "fig", "nos", "pp", "ed", "eds"}

FEATURES = ["hapax_ratio", "ttr", "unseen_bigram_rate", "stopword_rate", "comma_rate", "semicolon_rate",
            "paren_rate", "dash_rate", "sent_len_mean", "sent_len_sd", "cos_corpus", "cos_neighbors"]
FEATURE_LABELS = {
    "hapax_ratio": "hapax ratio (per 400-token window)",
    "ttr": "type/token ratio (per 400-token window)",
    "unseen_bigram_rate": "share of word pairs never seen in real articles",
    "stopword_rate": "stopword share",
    "comma_rate": "commas per 100 tokens",
    "semicolon_rate": "semicolons per 100 tokens",
    "paren_rate": "parentheses per 100 tokens",
    "dash_rate": "dashes per 100 tokens",
    "sent_len_mean": "mean sentence length (tokens)",
    "sent_len_sd": "spread of sentence length (SD, tokens)",
    "cos_corpus": "word-use similarity to all real articles",
    "cos_neighbors": "word-use similarity to linked characters' articles",
}


# ------------------------------------------------------------- stopwords ---
def stopwords() -> frozenset[str]:
    """NLTK English stopwords. Fetched once with urllib (NLTK's own downloader
    refuses to run behind this VM's proxy), cached in the gitignored .cache/."""
    path = NLTK_DIR / "corpora" / "stopwords" / "english"
    if not path.exists():
        path.parent.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(STOPWORDS_URL, timeout=60) as r:
            zipfile.ZipFile(io.BytesIO(r.read())).extractall(path.parent.parent)
    return frozenset(w.strip() for w in path.read_text(encoding="utf-8").split() if w.strip())


# --------------------------------------------------------- preprocessing ---
def prose_paragraphs(clean_text: str) -> list[str]:
    return [p for p in clean_text.split("\n\n") if p.strip() and not HEADING_RE.match(p)]


def tokens(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


def doc_tokens(clean_text: str) -> list[str]:
    return [t for p in prose_paragraphs(clean_text) for t in tokens(p)]


def paragraph_bigrams(clean_text: str) -> list[tuple[str, str]]:
    out = []
    for p in prose_paragraphs(clean_text):
        tk = tokens(p)
        out.extend(zip(tk, tk[1:]))
    return out


_BOUNDARY = re.compile(r"[.!?]['\")\]]*\s+(?=['\"(]?[A-Z0-9])")


def sentences(clean_text: str) -> list[str]:
    out = []
    for p in prose_paragraphs(clean_text):
        start = 0
        for m in _BOUNDARY.finditer(p):
            before = p[start:m.start()].split()
            last = before[-1].lower().rstrip(".") if before else ""
            if last in ABBREVIATIONS or (len(last) == 1 and last.isalpha()):
                continue
            out.append(p[start:m.end()].strip())
            start = m.end()
        if p[start:].strip():
            out.append(p[start:].strip())
    return [s for s in out if tokens(s)]


# --------------------------------------------------------------- features --
def window_ratios(tk: list[str]) -> tuple[float, float, int]:
    """Mean type/token and hapax ratio over non-overlapping 400-token windows."""
    n_win = len(tk) // WINDOW
    if n_win == 0:                      # shorter than one window: use what there is (flagged)
        wins = [tk]
    else:
        wins = [tk[i * WINDOW:(i + 1) * WINDOW] for i in range(n_win)]
    ttr, hapax = [], []
    for w in wins:
        c = Counter(w)
        ttr.append(len(c) / len(w))
        hapax.append(sum(1 for v in c.values() if v == 1) / len(w))
    return float(np.mean(ttr)), float(np.mean(hapax)), n_win


def punctuation_rates(clean_text: str, n_tokens: int) -> dict[str, float]:
    text = "\n\n".join(prose_paragraphs(clean_text))
    dashes = text.count("–") + text.count("—") + len(re.findall(r"\s-\s|--", text))
    per = 100.0 / max(n_tokens, 1)
    return {"comma_rate": text.count(",") * per, "semicolon_rate": text.count(";") * per,
            "paren_rate": text.count("(") * per, "dash_rate": dashes * per}


def basic_features(clean_text: str, sw: frozenset[str]) -> dict[str, float]:
    tk = doc_tokens(clean_text)
    ttr, hapax, n_win = window_ratios(tk)
    sent_lens = [len(tokens(s)) for s in sentences(clean_text)]
    f = {"n_tokens": len(tk), "n_windows": n_win, "ttr": ttr, "hapax_ratio": hapax,
         "stopword_rate": sum(t in sw for t in tk) / max(len(tk), 1),
         "sent_len_mean": float(np.mean(sent_lens)), "sent_len_sd": float(np.std(sent_lens)),
         "n_sentences": len(sent_lens)}
    f.update(punctuation_rates(clean_text, len(tk)))
    return f


class RealCorpus:
    """The 303 cleaned real articles, for leave-one-out reference statistics."""

    def __init__(self, articles: dict[str, dict], sw: frozenset[str]):
        self.ids = list(articles)
        self.index = {nid: i for i, nid in enumerate(self.ids)}
        self.name_to_id = {a["name"]: nid for nid, a in articles.items()}
        self.articles = articles
        self.sw = sw
        # bigram document frequency
        self.bigram_sets = [set(paragraph_bigrams(articles[n]["clean"])) for n in self.ids]
        self.bigram_df: Counter = Counter()
        for s in self.bigram_sets:
            self.bigram_df.update(s)
        # bag of words without stopwords, L2-normalised rows
        vocab: dict[str, int] = {}
        rows = []
        for n in self.ids:
            c = Counter(t for t in doc_tokens(articles[n]["clean"]) if t not in sw)
            rows.append(c)
            for t in c:
                vocab.setdefault(t, len(vocab))
        self.vocab = vocab
        self.matrix = np.vstack([self._vec(c) for c in rows])
        self.total = self.matrix.sum(axis=0)

    def _vec(self, counts: Counter) -> np.ndarray:
        v = np.zeros(len(self.vocab))
        for t, k in counts.items():
            j = self.vocab.get(t)
            if j is not None:              # words never used in any real article cannot match anyway
                v[j] = k
        n = np.linalg.norm(v)
        return v / n if n else v

    def doc_vec(self, clean_text: str) -> np.ndarray:
        return self._vec(Counter(t for t in doc_tokens(clean_text) if t not in self.sw))

    def unseen(self, bigram: tuple[str, str], exclude: str) -> bool:
        df = self.bigram_df.get(bigram, 0)
        if df and bigram in self.bigram_sets[self.index[exclude]]:
            df -= 1
        return df == 0

    def unseen_bigram_rate(self, clean_text: str, exclude: str) -> float:
        bg = paragraph_bigrams(clean_text)
        return sum(self.unseen(b, exclude) for b in bg) / max(len(bg), 1)

    def cos_corpus(self, clean_text: str, exclude: str) -> float:
        centroid = self.total - self.matrix[self.index[exclude]]
        return float(self.doc_vec(clean_text) @ centroid / np.linalg.norm(centroid))

    def neighbors(self, node_id: str) -> list[str]:
        a = self.articles[node_id]
        names = set(a["out_neighbors"]) | set(a["in_neighbors"])
        return sorted(self.name_to_id[n] for n in names if n in self.name_to_id and self.name_to_id[n] != node_id)

    def cos_neighbors(self, clean_text: str, node_id: str) -> float:
        nb = self.neighbors(node_id)
        if not nb:
            return float("nan")
        centroid = self.matrix[[self.index[n] for n in nb]].sum(axis=0)
        return float(self.doc_vec(clean_text) @ centroid / np.linalg.norm(centroid))

    def features(self, clean_text: str, node_id: str) -> dict[str, float]:
        f = basic_features(clean_text, self.sw)
        f["unseen_bigram_rate"] = self.unseen_bigram_rate(clean_text, node_id)
        f["cos_corpus"] = self.cos_corpus(clean_text, node_id)
        f["cos_neighbors"] = self.cos_neighbors(clean_text, node_id)
        return f

    # ------------------------------------------------- text inspection ---
    def highlight_unseen(self, clean_text: str, node_id: str, left: str = "«", right: str = "»") -> str:
        """Prose with every never-seen (leave-one-out) word pair wrapped in markers."""
        out = []
        for p in prose_paragraphs(clean_text):
            spans = [(m.start(), m.end(), m.group().lower()) for m in TOKEN_RE.finditer(p)]
            marked = [False] * len(spans)
            for i in range(len(spans) - 1):
                if self.unseen((spans[i][2], spans[i + 1][2]), node_id):
                    marked[i] = marked[i + 1] = True
            pieces, pos, i = [], 0, 0
            while i < len(spans):
                if not marked[i]:
                    i += 1
                    continue
                j = i
                while j + 1 < len(spans) and marked[j + 1]:
                    j += 1
                pieces.append(p[pos:spans[i][0]] + left + p[spans[i][0]:spans[j][1]] + right)
                pos = spans[j][1]
                i = j + 1
            pieces.append(p[pos:])
            out.append("".join(pieces))
        return "\n\n".join(out)

    def unseen_bigrams(self, clean_text: str, node_id: str) -> list[tuple[str, str]]:
        return [b for b in paragraph_bigrams(clean_text) if self.unseen(b, node_id)]


def excerpt(clean_text: str, target: int = 120, low: int = 90, high: int = 150) -> str:
    """Opening of the prose, about `target` tokens, cut at a sentence boundary.

    Sentences are added in order; we stop at the cut closest to `target`
    that is at least `low` tokens (the first sentence is always kept)."""
    best, best_gap, n, out = None, None, 0, []
    for p_i, p in enumerate(prose_paragraphs(clean_text)):
        for s in sentences(p):
            n += len(tokens(s))
            out.append((p_i, s))
            if n >= low or best is None:
                gap = abs(n - target)
                if best_gap is None or gap < best_gap:
                    best, best_gap = list(out), gap
            if n > high:
                break
        if n > high:
            break
    paras: dict[int, list[str]] = {}
    for p_i, s in best:
        paras.setdefault(p_i, []).append(s)
    return "\n\n".join(" ".join(v) for v in paras.values())


def segments_unseen(corpus: "RealCorpus", text: str, node_id: str) -> list[list]:
    """[[text, is_unseen], ...] covering `text`, for safe highlighting in the browser."""
    out: list[list] = []
    for k, p in enumerate(text.split("\n\n")):
        if k:
            out.append(["\n\n", False])
        spans = [(m.start(), m.end(), m.group().lower()) for m in TOKEN_RE.finditer(p)]
        marked = [False] * len(spans)
        for i in range(len(spans) - 1):
            if corpus.unseen((spans[i][2], spans[i + 1][2]), node_id):
                marked[i] = marked[i + 1] = True
        pos, i = 0, 0
        while i < len(spans):
            if not marked[i]:
                i += 1
                continue
            j = i
            while j + 1 < len(spans) and marked[j + 1]:
                j += 1
            if spans[i][0] > pos:
                out.append([p[pos:spans[i][0]], False])
            out.append([p[spans[i][0]:spans[j][1]], True])
            pos, i = spans[j][1], j + 1
        if pos < len(p):
            out.append([p[pos:], False])
    return out
