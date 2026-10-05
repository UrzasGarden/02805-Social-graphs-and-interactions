"""Phase 2/3/5: forge Wikipedia-style articles with Claude.

Usage
  python pipeline/02_forge.py --round 1 --pilot [--dry-run] [--characters A,B,C]
  python pipeline/02_forge.py --round N --dry-run          # estimate only, no API call
  python pipeline/02_forge.py --round N --submit           # create a Message Batch, save its id
  python pipeline/02_forge.py --round N --collect          # check the batch once, save results

Rules baked in (see SPEC.md):
  * the key is read only from the FORGE_API_KEY environment variable and never printed
  * every paid call is logged to outputs/cost_log.csv
  * hard stop if cumulative estimated spend would exceed config.BUDGET_USD
  * a character whose forgery file already exists is skipped (never pay twice)
  * missing <article> tags = failed request, reported, never guessed
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
from cleaning import clean_article, word_count  # noqa: E402

ARTICLE_RE = re.compile(r"<article>(.*?)</article>", re.S)
THINKING_HEADROOM_TOKENS = 3000   # Fable 5.1 always thinks and thinking counts against max_tokens
EXPECTED_THINKING_TOKENS = 800    # guess for the dry-run estimate at effort "low"; the pilot/round 1 calibrate it


# ---------------------------------------------------------------- helpers ---
def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_prompt(name: str) -> str:
    return (config.PROMPTS_DIR / name).read_text(encoding="utf-8")


def est_tokens(text: str) -> int:
    return int(len(text.split()) * config.WORDS_TO_TOKENS) + 1


def is_fable(model: str) -> bool:
    return "fable" in model or "mythos" in model


def get_client():
    import anthropic
    key = os.environ.get(config.API_KEY_ENV)
    if not key:
        sys.exit(f"{config.API_KEY_ENV} is not set in this environment. Add it to the cloud "
                 "environment's settings and start a new session.")
    return anthropic.Anthropic(api_key=key, max_retries=3, timeout=600.0)


def spent_so_far() -> float:
    if not config.COST_LOG.exists():
        return 0.0
    with open(config.COST_LOG, newline="", encoding="utf-8") as f:
        return sum(float(r["est_usd"]) for r in csv.DictReader(f))


COST_FIELDS = ["timestamp", "round", "mode", "model", "node_id", "input_tokens", "cache_write_tokens",
               "cache_read_tokens", "output_tokens", "est_usd", "batch_id"]


def log_cost(row: dict) -> None:
    new = not config.COST_LOG.exists()
    config.OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    with open(config.COST_LOG, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COST_FIELDS)
        if new:
            w.writeheader()
        w.writerow({k: row.get(k, "") for k in COST_FIELDS})


def usage_cost(model: str, usage, batch: bool) -> tuple[dict, float]:
    u = {
        "input_tokens": getattr(usage, "input_tokens", 0) or 0,
        "cache_write_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
        "cache_read_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
        "output_tokens": getattr(usage, "output_tokens", 0) or 0,
    }
    usd = config.estimate_cost(model, u["input_tokens"], u["output_tokens"],
                               u["cache_write_tokens"], u["cache_read_tokens"], batch=batch)
    return u, usd


# ----------------------------------------------------------------- prompts ---
def build_system(round_no: int, sample: dict) -> list[dict]:
    """System prompt as cacheable blocks: stable text first, cache marker on the last stable block."""
    blocks = [{"type": "text", "text": read_prompt("forge_system.txt").replace("{FORMAT_NOTES}", read_prompt("format_notes.txt").strip())}]
    if round_no == 3:
        refs = sample["style_references"]
        text = (read_prompt("forge_references_block.txt")
                .replace("{REF1_NAME}", refs[0]["name"]).replace("{REF1_TEXT}", refs[0]["text"])
                .replace("{REF2_NAME}", refs[1]["name"]).replace("{REF2_TEXT}", refs[1]["text"]))
        blocks.append({"type": "text", "text": text})
    blocks[-1]["cache_control"] = {"type": "ephemeral"}
    return blocks


def feedback_block(round_no: int) -> str:
    """Detector feedback for rounds 2 and 3, produced by 04_detector.py."""
    path = config.OUTPUTS_DIR / f"feedback_round{round_no}.json"
    if not path.exists():
        sys.exit(f"round {round_no} needs {path.name} (written by 04_detector.py after the previous round)")
    fb = json.loads(path.read_text(encoding="utf-8"))
    return (read_prompt("forge_feedback_block.txt")
            .replace("{CAUGHT}", str(fb["caught"])).replace("{TOTAL}", str(fb["total"]))
            .replace("{FEATURE_TABLE}", fb["feature_table"]).replace("{IMPOSSIBLE_BIGRAMS}", fb["impossible_bigrams"]))


def build_user(round_no: int, ch: dict) -> str:
    neighbors = ", ".join(ch["out_neighbors"]) if ch["out_neighbors"] else "(none)"
    user = (read_prompt("forge_user_round1.txt")
            .replace("{NAME}", ch["name"]).replace("{DESCRIPTION}", ch["description"])
            .replace("{OUT_NEIGHBORS}", neighbors).replace("{TARGET_WORDS}", str(ch["target_words"]))
            .replace("{LENGTH_NOTE}", ch["length_note"]))
    if round_no in (2, 3):
        user = feedback_block(round_no).rstrip() + "\n\n" + user
    return user


def request_params(model: str, system: list[dict], user: str, ch: dict) -> dict:
    target_tokens = int(ch["target_words"] * config.WORDS_TO_TOKENS)
    max_tokens = int(config.MAX_TOKENS_FACTOR * target_tokens)
    params = {"model": model, "max_tokens": max_tokens, "system": system,
              "messages": [{"role": "user", "content": user}]}
    if is_fable(model):
        # Thinking cannot be turned off on Fable 5.1; the lowest effort is the
        # closest thing to "no extended thinking", and the cap needs room for it.
        params["max_tokens"] = max_tokens + THINKING_HEADROOM_TOKENS
        params["output_config"] = {"effort": "low"}
    return params


# ------------------------------------------------------------------ output ---
def out_dir(round_no: int, pilot: bool) -> Path:
    d = config.FORGERIES_DIR / (f"pilot_round{round_no}" if pilot else f"round{round_no}")
    d.mkdir(parents=True, exist_ok=True)
    return d


def forgery_path(d: Path, node_id: str) -> Path:
    return d / (re.sub(r"[^A-Za-z0-9_.-]", "_", node_id) + ".json")


def parse_article(raw: str) -> tuple[str | None, str | None]:
    m = ARTICLE_RE.search(raw)
    if not m:
        return None, "missing <article></article> tags"
    return m.group(1).strip(), None


def save_result(d: Path, ch: dict, round_no: int, model: str, mode: str, params: dict, message,
                batch_id: str = "", custom_id: str = "") -> dict:
    """Parse, clean, log cost, write the per-character JSON. Returns the record."""
    raw = "".join(getattr(b, "text", "") for b in message.content if getattr(b, "type", "") == "text")
    stop = getattr(message, "stop_reason", None)
    usage, usd = usage_cost(model, message.usage, batch=(mode == "batch"))
    article, err = (None, f"stop_reason={stop}") if stop == "refusal" else parse_article(raw)
    if article is None and err is None:
        err = "empty"
    if article is not None and stop == "max_tokens":
        err = "truncated at max_tokens"
    clean = clean_article(article) if article else ""
    rec = {
        "node_id": ch["node_id"], "name": ch["name"], "round": round_no, "mode": mode, "model": model,
        "timestamp": now(), "batch_id": batch_id, "custom_id": custom_id,
        "prompt": {"system": params["system"], "user": params["messages"][0]["content"],
                   "max_tokens": params["max_tokens"], "output_config": params.get("output_config")},
        "raw_response": raw, "stop_reason": stop, "usage": usage, "est_usd": round(usd, 6),
        "ok": err is None, "error": err,
        "article_raw": article, "article_clean": clean,
        "clean_words": word_count(clean) if clean else 0, "target_words": ch["target_words"],
    }
    forgery_path(d, ch["node_id"]).write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    log_cost({"timestamp": rec["timestamp"], "round": round_no, "mode": mode, "model": model,
              "node_id": ch["node_id"], **usage, "est_usd": f"{usd:.6f}", "batch_id": batch_id})
    return rec


# ----------------------------------------------------------------- dry run ---
def dry_run(model: str, system: list[dict], todo: list[tuple[dict, str, dict]], batch: bool) -> float:
    sys_tokens = sum(est_tokens(b["text"]) for b in system)
    n = len(todo)
    user_tokens = sum(est_tokens(u) for _, u, _ in todo)
    out_tokens = sum(int(ch["target_words"] * config.WORDS_TO_TOKENS * 1.1) for ch, _, _ in todo)
    think = EXPECTED_THINKING_TOKENS * n if is_fable(model) else 0
    cap = sum(p["max_tokens"] for _, _, p in todo)
    # caching: first request writes the system prompt, the rest read it
    cache_write = sys_tokens if n else 0
    cache_read = sys_tokens * max(n - 1, 0)
    expected = config.estimate_cost(model, user_tokens, out_tokens + think, cache_write, cache_read, batch=batch)
    worst = config.estimate_cost(model, user_tokens, cap, cache_write, cache_read, batch=batch)
    uncached = config.estimate_cost(model, user_tokens + sys_tokens * n, out_tokens + think, batch=batch)
    print(f"\nDRY RUN  model={model}  mode={'batch (50% off)' if batch else 'synchronous'}  requests={n}")
    print(f"  system prompt ~{sys_tokens} tokens (cached after the first request; Haiku 4.5 needs >=4096 to cache, Fable >=512)")
    print(f"  input: ~{user_tokens} user tokens + ~{sys_tokens * n} system tokens across all requests")
    print(f"  output: ~{out_tokens} article tokens" + (f" + ~{think} thinking tokens (guess, effort=low)" if think else ""))
    print(f"  max_tokens cap summed: {cap}")
    print(f"  estimated cost: ${expected:.2f}  (worst case at the cap: ${worst:.2f}; without caching: ${uncached:.2f})")
    print(f"  spent so far: ${spent_so_far():.2f} of budget ${config.BUDGET_USD:.2f}")
    if spent_so_far() + worst > config.BUDGET_USD:
        print("  !! worst case would exceed the budget")
    return expected


def budget_guard(expected: float) -> None:
    if spent_so_far() + expected > config.BUDGET_USD:
        sys.exit(f"HARD STOP: spent ${spent_so_far():.2f} + estimated ${expected:.2f} "
                 f"exceeds BUDGET_USD={config.BUDGET_USD:.2f}")


# ---------------------------------------------------------------- selection --
def pilot_characters(sample: list[dict]) -> list[dict]:
    """One per tier: the member whose target length is the tier's median."""
    picks = []
    for tier in ("high", "middle", "low"):
        rows = sorted((c for c in sample if c["tier"] == tier), key=lambda c: c["target_words"])
        picks.append(rows[len(rows) // 2])
    return picks


# -------------------------------------------------------------------- modes --
def run_pilot(args, model, system, d, todo) -> None:
    client = get_client()
    for ch, user, params in todo:
        print(f"  forging {ch['name']} (target {ch['target_words']} words) ...", flush=True)
        message = client.messages.create(**params)
        rec = save_result(d, ch, args.round, model, "pilot", params, message)
        status = "ok" if rec["ok"] else f"FAILED: {rec['error']}"
        print(f"    {status}  words={rec['clean_words']}  stop={rec['stop_reason']}  "
              f"in={rec['usage']['input_tokens']} cw={rec['usage']['cache_write_tokens']} "
              f"cr={rec['usage']['cache_read_tokens']} out={rec['usage']['output_tokens']}  ${rec['est_usd']:.4f}")
    print(f"\nspent so far: ${spent_so_far():.2f}")


def load_batches() -> dict:
    return json.loads(config.BATCHES_FILE.read_text(encoding="utf-8")) if config.BATCHES_FILE.exists() else {}


def save_batches(b: dict) -> None:
    config.BATCHES_FILE.write_text(json.dumps(b, ensure_ascii=False, indent=1), encoding="utf-8")


def run_submit(args, model, system, d, todo) -> None:
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
    from anthropic.types.messages.batch_create_params import Request
    key = f"round{args.round}"
    batches = load_batches()
    open_batches = [b for b in batches.get(key, []) if not b.get("collected")]
    if open_batches:
        sys.exit(f"{key} already has an uncollected batch {open_batches[0]['batch_id']}; run --collect first")
    client = get_client()
    id_map = {}
    requests = []
    for i, (ch, user, params) in enumerate(todo):
        cid = f"r{args.round}-{i:03d}"
        id_map[cid] = ch["node_id"]
        requests.append(Request(custom_id=cid, params=MessageCreateParamsNonStreaming(**params)))
    batch = client.messages.batches.create(requests=requests)
    batches.setdefault(key, []).append({"batch_id": batch.id, "model": model, "submitted": now(),
                                        "n_requests": len(requests), "custom_ids": id_map, "collected": False})
    save_batches(batches)
    print(f"submitted batch {batch.id} with {len(requests)} requests (status {batch.processing_status}).")
    print(f"saved to {config.BATCHES_FILE.relative_to(config.WEEK5_DIR)} -- commit and push now.")


def run_collect(args, model, system, d, sample_by_id) -> None:
    key = f"round{args.round}"
    batches = load_batches()
    pending = [b for b in batches.get(key, []) if not b.get("collected")]
    if not pending:
        sys.exit(f"no uncollected batch for {key} in {config.BATCHES_FILE.name}")
    client = get_client()
    for entry in pending:
        batch = client.messages.batches.retrieve(entry["batch_id"])
        rc = batch.request_counts
        print(f"batch {batch.id}: status={batch.processing_status}  processing={rc.processing} "
              f"succeeded={rc.succeeded} errored={rc.errored} canceled={rc.canceled} expired={rc.expired}")
        if batch.processing_status != "ended":
            print("  not finished; ask me to collect again later.")
            continue
        ok = failed = 0
        for result in client.messages.batches.results(batch.id):
            node_id = entry["custom_ids"].get(result.custom_id)
            ch = sample_by_id.get(node_id)
            if ch is None:
                print(f"  unknown custom_id {result.custom_id}"); failed += 1; continue
            if result.result.type != "succeeded":
                err = getattr(getattr(result.result, "error", None), "type", result.result.type)
                print(f"  {ch['name']}: {result.result.type} ({err}) -- not retried"); failed += 1
                continue
            params = request_params(entry["model"], system, build_user(args.round, ch), ch)
            rec = save_result(d, ch, args.round, entry["model"], "batch", params, result.result.message,
                              batch_id=batch.id, custom_id=result.custom_id)
            if rec["ok"]:
                ok += 1
            else:
                failed += 1
                print(f"  {ch['name']}: FAILED {rec['error']}")
        entry["collected"] = True
        entry["collected_at"] = now()
        entry["ok"] = ok
        entry["failed"] = failed
        save_batches(batches)
        print(f"  saved {ok} forgeries, {failed} failures. spent so far: ${spent_so_far():.2f}. Commit and push now.")


# --------------------------------------------------------------------- main --
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--round", type=int, choices=(1, 2, 3), required=True)
    ap.add_argument("--pilot", action="store_true", help="synchronous run on 3 characters with PILOT_MODEL")
    ap.add_argument("--dry-run", action="store_true", help="estimate only, no API call")
    ap.add_argument("--submit", action="store_true", help="create the Message Batch")
    ap.add_argument("--collect", action="store_true", help="check the batch once and save results")
    ap.add_argument("--characters", help="comma-separated node_ids to restrict to")
    ap.add_argument("--retry-failed", action="store_true", help="redo characters whose existing file is a failure")
    args = ap.parse_args()
    if sum(bool(x) for x in (args.dry_run, args.submit, args.collect)) > 1:
        ap.error("pick one of --dry-run / --submit / --collect")

    sample_doc = json.loads(config.SAMPLE_FILE.read_text(encoding="utf-8"))
    sample = sample_doc["sample"]
    sample_by_id = {c["node_id"]: c for c in sample}
    model = config.PILOT_MODEL if args.pilot else config.FORGE_MODEL
    system = build_system(args.round, sample_doc)
    d = out_dir(args.round, args.pilot)

    if args.collect:
        run_collect(args, model, system, d, sample_by_id)
        return

    chars = pilot_characters(sample) if args.pilot else list(sample)
    if args.characters:
        wanted = [c.strip() for c in args.characters.split(",")]
        missing = [w for w in wanted if w not in sample_by_id]
        if missing:
            sys.exit(f"not in sample: {missing}")
        chars = [sample_by_id[w] for w in wanted]

    todo, skipped = [], []
    for ch in chars:
        p = forgery_path(d, ch["node_id"])
        if p.exists():
            prev = json.loads(p.read_text(encoding="utf-8"))
            if prev.get("ok") or not args.retry_failed:
                skipped.append(ch["name"]); continue
        user = build_user(args.round, ch)
        todo.append((ch, user, request_params(model, system, user, ch)))
    if skipped:
        print(f"skipping {len(skipped)} existing: {', '.join(skipped[:8])}{' ...' if len(skipped) > 8 else ''}")
    if not todo:
        print("nothing to do"); return
    print("characters:", ", ".join(f"{c['name']} [{c['tier']}, {c['target_words']}w]" for c, _, _ in todo[:6]),
          "..." if len(todo) > 6 else "")

    batch = not args.pilot
    expected = dry_run(model, system, todo, batch=batch)
    if args.dry_run:
        print("\n(dry run only: nothing was sent)")
        return
    budget_guard(expected)
    if args.pilot:
        run_pilot(args, model, system, d, todo)
    elif args.submit:
        run_submit(args, model, system, d, todo)
    else:
        ap.error("for a non-pilot round use --dry-run, --submit or --collect")


if __name__ == "__main__":
    main()
