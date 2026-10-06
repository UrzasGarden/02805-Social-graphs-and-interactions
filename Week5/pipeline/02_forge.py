"""Render forging prompts, audit the Fable forger subagents, check their output.

Forgeries are written by Fable subagents inside the Claude Code session (see
SPEC.md, "How forging works"). This script never calls a model. It has three
modes, each for one round (or its pilot):

  python pipeline/02_forge.py --round 1 --plan             # count + total target words, writes nothing
  python pipeline/02_forge.py --round 1 --render [--pilot] # write one prompt per character
  python pipeline/02_forge.py --round 1 --audit  [--pilot] # verify each forger from its transcript
  python pipeline/02_forge.py --round 1 --check  [--pilot] # parse + length check of each forgery

Layout, with LABEL = roundN or pilot_roundN:
  outputs/prompts/LABEL/<slug>.txt       rendered prompt, exactly what the forger receives
  outputs/prompts/LABEL/manifest.json    slug -> node_id, target words, prompt and output paths
  outputs/forgeries/LABEL/<slug>.txt     written by the forger
  outputs/transcripts/LABEL/<slug>.jsonl copied forger transcript
  outputs/transcripts/LABEL/audit.json   per-forger audit verdicts
  outputs/forgeries/LABEL/check.json     per-forgery parse/length verdicts
  outputs/usage_log.csv                  token usage per forger, from the transcripts

<slug> is the node_id with every character outside [A-Za-z0-9_.-] replaced by "_".
"""
from __future__ import annotations

import argparse
import csv
import difflib
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
from cleaning import clean_article, word_count  # noqa: E402

ARTICLE_RE = re.compile(r"<article>(.*?)</article>", re.S)
# Claude Code tells every subagent to end its run by calling this tool; it is
# harness plumbing (it only carries the final reply), so the audit allows one.
HANDBACK_TOOL = "SubagentHandback"
# Attachment fields that would publish private account data in a public repo.
REDACT_ATTACHMENTS = {"session_context": "context", "credential_org": "organizationUuid"}
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")


# ---------------------------------------------------------------- helpers ---
def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def slug(node_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", node_id)


def label_for(round_no: int, pilot: bool) -> str:
    return f"pilot_round{round_no}" if pilot else f"round{round_no}"


def template(name: str) -> str:
    return (config.PROMPTS_DIR / name).read_text(encoding="utf-8").rstrip("\n")


def load_sample() -> dict:
    return json.loads(config.SAMPLE_FILE.read_text(encoding="utf-8"))


def pilot_characters(sample: list[dict]) -> list[dict]:
    """One per in-degree tier: the member whose target length is the tier's median."""
    picks = []
    for tier in ("high", "middle", "low"):
        rows = sorted((c for c in sample if c["tier"] == tier), key=lambda c: c["target_words"])
        picks.append(rows[len(rows) // 2])
    return picks


def select(args, sample_doc: dict) -> list[dict]:
    sample = sample_doc["sample"]
    by_id = {c["node_id"]: c for c in sample}
    chars = pilot_characters(sample) if args.pilot else list(sample)
    if args.characters:
        wanted = [c.strip() for c in args.characters.split(",")]
        missing = [w for w in wanted if w not in by_id]
        if missing:
            sys.exit(f"not in sample: {missing}")
        chars = [by_id[w] for w in wanted]
    return chars


def dirs(label: str) -> tuple[Path, Path, Path]:
    return config.RENDERED_DIR / label, config.FORGERIES_DIR / label, config.TRANSCRIPTS_DIR / label


def load_manifest(label: str) -> dict:
    p = config.RENDERED_DIR / label / "manifest.json"
    if not p.exists():
        sys.exit(f"no rendered prompts for {label}; run --render first")
    return json.loads(p.read_text(encoding="utf-8"))


def load_audit(label: str) -> dict:
    p = config.TRANSCRIPTS_DIR / label / "audit.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


# ----------------------------------------------------------------- render ---
def feedback_block(round_no: int) -> str:
    """Detector feedback for rounds 2 and 3, written by 04_detector.py."""
    path = config.OUTPUTS_DIR / f"feedback_round{round_no}.json"
    if not path.exists():
        sys.exit(f"round {round_no} needs {path.relative_to(config.WEEK5_DIR)} (written by 04_detector.py)")
    fb = json.loads(path.read_text(encoding="utf-8"))
    return (template("forge_feedback_block.txt")
            .replace("{CAUGHT}", str(fb["caught"])).replace("{TOTAL}", str(fb["total"]))
            .replace("{FEATURE_TABLE}", fb["feature_table"]).replace("{IMPOSSIBLE_BIGRAMS}", fb["impossible_bigrams"]))


def render_prompt(round_no: int, ch: dict, sample_doc: dict, output_path: Path) -> str:
    """instructions -> (r3) style references -> (r2-3) feedback -> character/length/output."""
    parts = [template("forge_instructions.txt").replace("{FORMAT_NOTES}", template("format_notes.txt"))]
    if round_no == 3:
        r1, r2 = sample_doc["style_references"]
        parts.append(template("forge_references_block.txt")
                     .replace("{REF1_NAME}", r1["name"]).replace("{REF1_TEXT}", r1["text"])
                     .replace("{REF2_NAME}", r2["name"]).replace("{REF2_TEXT}", r2["text"]))
    if round_no in (2, 3):
        parts.append(feedback_block(round_no))
    neighbors = ", ".join(ch["out_neighbors"]) if ch["out_neighbors"] else "(none)"
    parts.append(template("forge_character.txt")
                 .replace("{NAME}", ch["name"]).replace("{DESCRIPTION}", ch["description"])
                 .replace("{OUT_NEIGHBORS}", neighbors).replace("{TARGET_WORDS}", str(ch["target_words"]))
                 .replace("{LENGTH_NOTE}", ch["length_note"]).replace("{OUTPUT_PATH}", str(output_path)))
    text = "\n\n".join(parts)
    leftover = re.findall(r"\{[A-Z0-9_]+\}", text)
    if leftover:
        sys.exit(f"unfilled placeholders in prompt for {ch['node_id']}: {leftover}")
    return text


def do_plan(args, sample_doc) -> None:
    chars = select(args, sample_doc)
    total = sum(c["target_words"] for c in chars)
    print(f"{label_for(args.round, args.pilot)}: {len(chars)} forgeries, {total} target words in total "
          f"(min {min(c['target_words'] for c in chars)}, max {max(c['target_words'] for c in chars)})")


def do_render(args, sample_doc) -> None:
    label = label_for(args.round, args.pilot)
    pdir, fdir, _ = dirs(label)
    pdir.mkdir(parents=True, exist_ok=True)
    fdir.mkdir(parents=True, exist_ok=True)
    audit = load_audit(label)
    manifest_path = pdir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    chars = select(args, sample_doc)
    pending, done, changed = [], [], []
    for ch in chars:
        s = slug(ch["node_id"])
        out = (fdir / f"{s}.txt").resolve()
        text = render_prompt(args.round, ch, sample_doc, out)
        ppath = pdir / f"{s}.txt"
        if ppath.exists() and ppath.read_text(encoding="utf-8") != text:
            changed.append(ch["name"])
        ppath.write_text(text, encoding="utf-8")   # no trailing newline: the file is the prompt, byte for byte
        manifest[s] = {"node_id": ch["node_id"], "name": ch["name"], "tier": ch["tier"],
                       "in_degree": ch["in_degree"], "target_words": ch["target_words"],
                       "prompt_path": str(ppath.relative_to(config.WEEK5_DIR)), "output_path": str(out),
                       "rendered_at": now()}
        (done if audit.get(s, {}).get("verdict") == "PASS" and out.exists() else pending).append(s)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    total = sum(c["target_words"] for c in chars)
    print(f"rendered {len(chars)} prompts for {label} into {pdir.relative_to(config.WEEK5_DIR)}  "
          f"({total} target words in total)")
    if changed:
        print(f"!! prompt text changed for: {', '.join(changed)} -- earlier forgeries used the old prompt")
    print(f"already done and audited: {len(done)}; to spawn: {len(pending)}")
    for s in pending:
        print(f"  {manifest[s]['prompt_path']}")


# ------------------------------------------------------------------ audit ---
def _blocks(content) -> list[dict]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [b for b in (content or []) if isinstance(b, dict)]


def read_transcript(path: Path) -> dict:
    """Prompt, models, tool calls, usage and final text of one subagent transcript."""
    records = [json.loads(ln) for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    prompt = None
    models, tools, final_text = set(), [], ""
    usage_by_msg: dict[str, dict] = {}
    for r in records:
        msg = r.get("message")
        if not isinstance(msg, dict):
            continue
        if r.get("type") == "user" and prompt is None:
            texts = [b.get("text", "") for b in _blocks(msg.get("content")) if b.get("type") == "text"]
            if texts:
                prompt = "".join(texts)
        if r.get("type") == "assistant":
            if msg.get("model"):
                models.add(msg["model"])
            for b in _blocks(msg.get("content")):
                if b.get("type") == "tool_use":
                    tools.append({"name": b.get("name"), "input": b.get("input", {})})
                    if b.get("name") == HANDBACK_TOOL:
                        final_text = str((b.get("input") or {}).get("message", "")).strip()
                elif b.get("type") == "text" and b.get("text", "").strip() and not final_text:
                    final_text = b["text"].strip()
            if msg.get("usage") and msg.get("id"):
                usage_by_msg[msg["id"]] = msg["usage"]   # one API message can span several records
    # Claude Code stores the usage block from the START of each streamed reply: the
    # input side (uncached, cache write, cache read) is final, the output side is not.
    usage = {"input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
             "output_tokens_at_stream_start": 0, "api_calls": len(usage_by_msg)}
    for u in usage_by_msg.values():
        for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"):
            usage[k] += u.get(k) or 0
        usage["output_tokens_at_stream_start"] += u.get("output_tokens") or 0
    written = "".join(str(c["input"].get("content", "")) for c in tools if c["name"] == config.FORGER_TOOL)
    usage["article_tokens_est"] = int(len(written.split()) * 1.35)
    stamps = sorted(r["timestamp"] for r in records if r.get("timestamp"))
    if len(stamps) >= 2:
        t0, t1 = (datetime.fromisoformat(x.replace("Z", "+00:00")) for x in (stamps[0], stamps[-1]))
        usage["duration_s"] = round((t1 - t0).total_seconds())
    return {"prompt": prompt, "models": sorted(models), "tools": tools, "final_text": final_text,
            "usage": usage, "n_records": len(records)}


def read_meta(path: Path) -> dict:
    meta = path.with_name(path.name.replace(".jsonl", ".meta.json"))
    return json.loads(meta.read_text(encoding="utf-8")) if meta.exists() else {}


def copy_redacted(src: Path, dest: Path) -> dict:
    """Copy a transcript, blanking the user's email and org id; return provenance."""
    raw = src.read_bytes()
    out_lines, redacted = [], []
    for line in raw.decode("utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        a = r.get("attachment")
        if isinstance(a, dict) and a.get("type") in REDACT_ATTACHMENTS:
            field = REDACT_ATTACHMENTS[a["type"]]
            if field in a:
                a[field] = "[redacted before publishing]"
                redacted.append(f"{a['type']}.{field}")
            if "rendered" in r:                       # the same text, as shown to the model
                r["rendered"] = "[redacted before publishing]"
                redacted.append(f"{a['type']}.rendered")
        line = json.dumps(r, ensure_ascii=False)
        if isinstance(a, dict) and EMAIL_RE.search(line):  # belt and braces, harness records only
            line = EMAIL_RE.sub("[email redacted]", line)
            redacted.append(f"{a.get('type')}:email")
        out_lines.append(line)
    dest.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    return {"source": src.name, "source_sha256": hashlib.sha256(raw).hexdigest(), "redacted": redacted}


def find_subagent_transcripts() -> list[Path]:
    return sorted(config.CLAUDE_PROJECTS_DIR.glob("*/*/subagents/agent-*.jsonl"),
                  key=lambda p: p.stat().st_mtime)


def write_usage_log(rows: list[dict]) -> None:
    fields = ["label", "slug", "node_id", "agent_file", "model", "api_calls", "input_tokens",
              "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens_at_stream_start",
              "article_tokens_est", "duration_s", "verdict", "audited_at"]
    existing = []
    if config.USAGE_LOG.exists():
        with open(config.USAGE_LOG, newline="", encoding="utf-8") as f:
            existing = list(csv.DictReader(f))
    keys = {(r["label"], r["agent_file"]) for r in rows}
    merged = [r for r in existing if (r["label"], r["agent_file"]) not in keys] + rows
    with open(config.USAGE_LOG, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in merged:
            w.writerow({k: r.get(k, "") for k in fields})


def do_audit(args, sample_doc) -> None:
    label = label_for(args.round, args.pilot)
    pdir, fdir, tdir = dirs(label)
    manifest = load_manifest(label)
    tdir.mkdir(parents=True, exist_ok=True)
    transcripts = find_subagent_transcripts()
    if not transcripts:
        sys.exit(f"STOP: no subagent transcripts under {config.CLAUDE_PROJECTS_DIR}/*/*/subagents/. "
                 "The audit cannot run; tell the user.")
    parsed = {}
    for t in transcripts:
        try:
            parsed[t] = read_transcript(t)
        except Exception as e:  # noqa: BLE001
            print(f"  unreadable transcript {t.name}: {e}")
    audit = load_audit(label)
    usage_rows = []
    for s, m in manifest.items():
        rendered = (pdir / f"{s}.txt").read_text(encoding="utf-8")
        out = Path(m["output_path"])
        # transcripts whose prompt is this rendered prompt, or that wrote this output path
        exact = [t for t, d in parsed.items() if d["prompt"] == rendered]
        near = [t for t, d in parsed.items() if t not in exact and d["prompt"] and
                (m["output_path"] in d["prompt"] or any(c["input"].get("file_path") == m["output_path"] for c in d["tools"]))]
        if not exact and not near:
            if audit.get(s, {}).get("verdict") == "PASS" and out.exists():
                continue                              # audited earlier; transcript already copied
            audit[s] = {"verdict": "NOT_SPAWNED" if not out.exists() else "NO_TRANSCRIPT", "audited_at": now()}
            continue
        t = (exact or near)[-1]                       # latest spawn wins
        d = parsed[t]
        problems = []
        if t not in exact:
            diff = list(difflib.unified_diff(rendered.splitlines(), (d["prompt"] or "").splitlines(),
                                             "rendered", "received", lineterm="", n=0))
            problems.append("prompt differs from rendered file: " + " | ".join(diff[2:8]))
        if d["models"] != [config.FORGER_MODEL]:
            problems.append(f"model(s) {d['models']} != {config.FORGER_MODEL}")
        names = [c["name"] for c in d["tools"]]
        forbidden = [n for n in names if n not in (config.FORGER_TOOL, HANDBACK_TOOL)]
        contaminated = bool(forbidden)
        if forbidden:
            problems.append(f"forbidden tool calls: {forbidden}")
        if names.count(HANDBACK_TOOL) > 1:
            problems.append(f"{names.count(HANDBACK_TOOL)} {HANDBACK_TOOL} calls (expected at most 1)")
        meta = read_meta(t)
        if meta and meta.get("agentType") != "general-purpose":
            problems.append(f"agent type {meta.get('agentType')!r}, expected 'general-purpose'")
        writes = [c for c in d["tools"] if c["name"] == config.FORGER_TOOL]
        if len(writes) != 1:
            problems.append(f"{len(writes)} Write calls (expected exactly 1)")
        elif writes[0]["input"].get("file_path") != m["output_path"]:
            problems.append(f"Write to {writes[0]['input'].get('file_path')!r}, expected {m['output_path']!r}")
        elif not out.exists():
            problems.append("output file missing on disk")
        elif out.read_text(encoding="utf-8") != writes[0]["input"].get("content"):
            problems.append("file on disk differs from what the forger wrote")
        if d["final_text"].strip().lower().rstrip(".") != "done":
            problems.append(f"final reply was {d['final_text'][:60]!r}, not 'done' (noted, not fatal)")
        fatal = [p for p in problems if "not fatal" not in p]
        verdict = "CONTAMINATED" if contaminated else ("FAIL" if fatal else "PASS")
        if verdict == "PASS":
            provenance = copy_redacted(t, tdir / f"{s}.jsonl")
        else:
            rej = tdir / "rejected"
            rej.mkdir(exist_ok=True)
            provenance = copy_redacted(t, rej / f"{s}__{t.stem}.jsonl")
            if contaminated and out.exists():
                out.unlink()                           # spec: delete a contaminated forgery and re-spawn
                problems.append("forgery deleted; re-spawn this forger")
        audit[s] = {"verdict": verdict, "problems": problems, "agent_file": t.name,
                    "agent_meta": meta, "models": d["models"], "tool_calls": names,
                    "final_reply": d["final_text"][:200], "usage": d["usage"],
                    "prompt_identical": t in exact, "transcript": provenance, "audited_at": now()}
        usage_rows.append({"label": label, "slug": s, "node_id": m["node_id"], "agent_file": t.name,
                           "model": ",".join(d["models"]), **d["usage"], "verdict": verdict, "audited_at": now()})
    (tdir / "audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=1), encoding="utf-8")
    if usage_rows:
        write_usage_log(usage_rows)
    print(f"audit of {label}: {len(transcripts)} subagent transcripts found")
    for s in manifest:
        a = audit.get(s, {})
        u = a.get("usage", {})
        extra = (f"  in={u.get('input_tokens')} cache_w={u.get('cache_creation_input_tokens')} "
                 f"cache_r={u.get('cache_read_input_tokens')} article~{u.get('article_tokens_est')} tok "
                 f"{u.get('duration_s')}s") if u else ""
        print(f"  {a.get('verdict', '?'):13s} {manifest[s]['name']}{extra}")
        for p in a.get("problems", []):
            print(f"      - {p}")


# ------------------------------------------------------------------ check ---
def parse_forgery(path: Path) -> tuple[str | None, str | None]:
    if not path.exists():
        return None, "missing file"
    m = ARTICLE_RE.search(path.read_text(encoding="utf-8"))
    if not m:
        return None, "missing <article></article> tags"
    return m.group(1).strip(), None


def do_check(args, sample_doc) -> None:
    label = label_for(args.round, args.pilot)
    pdir, fdir, _ = dirs(label)
    manifest = load_manifest(label)
    lo, hi = config.LENGTH_TOLERANCE
    results, failures = {}, 0
    for s, m in manifest.items():
        article, err = parse_forgery(Path(m["output_path"]))
        rec = {"node_id": m["node_id"], "target_words": m["target_words"], "ok": False, "error": err}
        if article is not None:
            clean = clean_article(article)
            n = word_count(clean)
            ratio = n / m["target_words"]
            rec.update(clean_words=n, ratio=round(ratio, 3),
                       headings=[p[3:-3] for p in clean.split("\n\n") if p.startswith("== ")])
            if not lo <= ratio <= hi:
                rec["error"] = f"length {n} words is {ratio:.2f}x the target {m['target_words']}"
            else:
                rec["ok"] = True
        failures += not rec["ok"]
        results[s] = rec
        print(f"  {'ok  ' if rec['ok'] else 'FAIL'} {m['name']:32s} target {m['target_words']:5d}  "
              f"got {rec.get('clean_words', '-'):>5}  {rec.get('ratio', '')}  {rec['error'] or ''}")
    (fdir / "check.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"check of {label}: {len(results) - failures} ok, {failures} failed")
    if args.compare:
        write_comparison(label, manifest, results)


def write_comparison(label: str, manifest: dict, results: dict) -> None:
    arts = json.loads(config.ARTICLES_FILE.read_text(encoding="utf-8"))
    sample = {c["node_id"]: c for c in load_sample()["sample"]}
    esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")  # noqa: E731
    md = [f"# {label}: forgeries next to the real cleaned pages\n\n",
          "Left: the real Wikipedia article (CC BY-SA 4.0), cleaned comparison text. "
          "Right: **AI-generated forgery** by a Claude Fable 5.1 subagent, after the same cleaning.\n\n"]
    for s, m in manifest.items():
        art, _ = parse_forgery(Path(m["output_path"]))
        forged = clean_article(art) if art else "(no forgery)"
        real = sample[m["node_id"]]["comparison_text"]
        r = results.get(s, {})
        md.append(f"## {m['name']} ({m['tier']} tier, in-degree {m['in_degree']})\n\n"
                  f"Target {m['target_words']} words; forgery {r.get('clean_words', '-')} words. "
                  f"Real article: {arts[m['node_id']]['url']}\n\n"
                  f"<table><tr><th>real (cleaned)</th><th>AI-generated forgery (cleaned)</th></tr>\n<tr>\n"
                  f"<td valign=top><pre>{esc(real)}</pre></td>\n<td valign=top><pre>{esc(forged)}</pre></td>\n"
                  f"</tr></table>\n\n")
    out = config.OUTPUTS_DIR / f"{label}_comparison.md"
    out.write_text("".join(md), encoding="utf-8")
    print(f"wrote {out.relative_to(config.WEEK5_DIR)}")


# ------------------------------------------------------------------- main ---
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--round", type=int, choices=(1, 2, 3), required=True)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--plan", action="store_true", help="print count and total target words only")
    mode.add_argument("--render", action="store_true", help="write one prompt per character")
    mode.add_argument("--audit", action="store_true", help="verify forgers from their transcripts")
    mode.add_argument("--check", action="store_true", help="parse and length-check the forgeries")
    ap.add_argument("--pilot", action="store_true", help="3 characters, one per in-degree tier")
    ap.add_argument("--characters", help="comma-separated node_ids to restrict --plan/--render to")
    ap.add_argument("--compare", action="store_true", help="with --check: write a real-vs-forged markdown file")
    args = ap.parse_args()
    sample_doc = load_sample()
    {"plan": do_plan, "render": do_render, "audit": do_audit, "check": do_check}[
        next(k for k in ("plan", "render", "audit", "check") if getattr(args, k))](args, sample_doc)


if __name__ == "__main__":
    import signal
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)   # quiet when piped into head
    main()
