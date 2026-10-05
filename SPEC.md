# Week 5 Go Nuts: "The Forger"

Spec for our coding agent. Read this whole file before doing anything.

## The question

Claude Fable 5.1 forges Wikipedia articles about Marvel characters. Can a detector built only from week 5 tools (counts, hapaxes, n-grams, Bag of Words) tell the forgeries from the real articles, and does it beat humans? Then the forger gets told what gave it away and tries again. Who wins the arms race?

The deliverable is one post at `Week5/week5.html`: the question, what we did, one strong figure, a playable real-vs-forged game, what surprised us, what we checked in the text, and one limitation.

## Where this runs

You are running in Claude Code on the web (claude.ai/code), in a cloud VM with a fresh clone of the repo. That changes a few things:

- **Files you don't commit can disappear.** The VM pauses when idle and can be reclaimed. Anything that cost API money (forgeries, batch IDs, the cost log) must be committed and pushed right after it lands.
- **You can't wait long.** Commands time out after a few minutes, and the VM pauses when idle. So never poll a batch in a long loop: submit it, save the batch ID, commit, and collect it later with a separate command.
- **The forging API key is in the env var `FORGE_API_KEY`**, set in the cloud environment's settings, not in the repo. It is deliberately not called `ANTHROPIC_API_KEY`.
- **Network:** the environment allows `sunelehmann.com` (course data), PyPI, GitHub and `api.anthropic.com`. If a download is blocked, tell us the domain instead of working around it.

---

## Hard rules (never break these)

**1. Folder containment.**
- Every file you create or modify lives inside `Week5/`. No exceptions.
- You may READ anything in the repo (e.g. `Week3/week3.html`, `Week4/week4.html` to copy the site's look), but never write outside `Week5/`.
- Do not edit `index.html` or the other weeks' nav bars. At the very end, print the exact snippets we need to add there and we will do it ourselves.
- All links and fetches inside the site use relative paths, so the page works at `.../02805-Social-graphs-and-interactions/Week5/week5.html` on GitHub Pages.

**2. The API key never touches the repo. This repo is public.**
- Read the key only from `os.environ["FORGE_API_KEY"]` and pass it explicitly: `anthropic.Anthropic(api_key=...)`.
- Never print it, echo it, dump the environment (`env`, `printenv`, `os.environ` prints), write it into any file, or put it in HTML or JS. To check it exists, use something like `test -n "$FORGE_API_KEY" && echo "key is set"`.
- The website never calls the API. All generation happens offline in Python. The game only reads precomputed JSON.
- Create `Week5/.gitignore` containing at least: `.env`, `data/raw/`, `.cache/`, `__pycache__/`, `.ipynb_checkpoints/`.

**2b. Git.**
- Work on the session's branch. Commit and push at the end of every phase, and immediately after any paid API results land.
- Before every commit, check the diff for anything that looks like a key (`sk-ant-`). If you find one, stop and tell us.
- Never merge to `main`. We review the pull request and merge it ourselves.

**3. Budget. We have $100 total and want to spend under $40.**
- The forging model comes from env var `FORGE_MODEL` (default `claude-fable-5-1`). Pilots use `PILOT_MODEL` (default `claude-haiku-4-5-20251001`).
- Price table lives in `Week5/pipeline/config.py`. Defaults: Fable 5.1 at $10 / $50 per million input / output tokens, batch at half price. Tell us to double-check against https://docs.claude.com/en/docs/about-claude/pricing.
- Log every API call (model, input tokens, cached tokens, output tokens, estimated $) to `Week5/outputs/cost_log.csv`.
- Hard stop if cumulative estimated spend would exceed `BUDGET_USD` (default 40).
- **Before every Fable run, do a dry run first:** print the number of requests and the estimated input tokens, output tokens and cost. Then STOP and wait for us to type "go". Never start a paid Fable run without that.
- Full runs use the Message Batches API (half price), in two steps. `02_forge.py --round N --submit` creates the batch, writes its ID to `outputs/batches.json`, and you commit and push. `02_forge.py --round N --collect` checks the status once. If the batch has ended, it saves the results and logs the cost, and you commit and push. If not, it says so and exits; we will ask you to collect again later.
- Pilots use normal synchronous calls.
- No extended thinking. Set `max_tokens` to about 1.4 × the target length in tokens.
- Put the stable parts of the prompt first and mark them with prompt caching (`cache_control`). Look up the current syntax in the Anthropic docs rather than guessing.
- Scripts are resumable: if a forgery file already exists, skip it. Never pay twice for the same request.

**4. When in doubt, stop and ask.** Each phase below ends with a checkpoint. Show us the result and wait.

---

## Folder layout

```
Week5/
  SPEC.md              this file
  AI_METHODS.md        what the AI did, prompts used, what we verified (course requirement)
  .gitignore
  requirements.txt
  data/
    raw/               marvel_pages.zip, week1_nodes.tsv, week1 edge list (gitignored, re-downloadable)
    clean/             cleaned real articles + sample list (committed)
  prompts/             the prompt templates below, one file each
  pipeline/
    config.py          paths, models, prices, budget
    01_prepare.py
    02_forge.py        --round {1,2,3} --pilot --dry-run
    03_features.py
    04_detector.py
    05_game_data.py
  outputs/
    forgeries/round1/ round2/ round3/   one JSON per character: prompt, raw response, usage
    batches.json       batch IDs per round, so a new session can collect them
    cost_log.csv
  notebooks/
    analysis.ipynb     all figures and every text inspection
  figures/
  game/
    game_data.json
    game.js
    game.css
  week5.html           the post, with the game embedded
```

---

## Phase 0: Look around (no API calls)

1. Read `Week3/week3.html` and `Week4/week4.html` to learn the site's style and nav structure. Do not modify them.
2. Create the folder layout, `.gitignore`, `requirements.txt`, and install the requirements.
3. Check the environment without spending money: confirm `FORGE_API_KEY` is set (without printing it), and that `https://sunelehmann.com/socialgraphs2026-web/data/` is reachable.
4. **Checkpoint:** show us the tree and your plan, then commit and push.

## Phase 1: Data and cleaning (no API calls)

1. Read the course data page (`https://sunelehmann.com/socialgraphs2026-web/data/`) and download into `Week5/data/raw/`: `marvel_pages.zip`, `week1_nodes.tsv` (has a `description` column), and the week 1 edge list. Load the pages with the loading snippet from that page (dict keyed by `node_id`). Write the download into `01_prepare.py` so a fresh VM can redo it.
2. **Inspect the raw format before cleaning.** Look for section headings, reference remnants, "See also", "References", "External links", infobox leftovers and anything else that is formatting rather than prose. Print three raw pages for us.
3. Write ONE cleaning function. It keeps the prose and turns headings into a single consistent form, and it will later be applied identically to real and forged text. Otherwise the detector learns formatting instead of language. That is exactly the trap the week 5 page warns about.
4. Write `prompts/format_notes.txt`: a short, plain description of what a cleaned real article looks like (heading style, typical section order, paragraph style). This gets inserted into the forging prompt.
5. Pick the sample: 60 characters stratified by in-degree (20 high, 20 middle, 20 low), only among pages with at least 400 cleaned words. Also pick 2 extra characters with mid-length pages as the fixed round-3 style references. Exclude those 2 from the sample. Save to `data/clean/sample.json`.
6. For each sampled character: target length = min(real cleaned word count, 1500). If the real page is longer than 1500 words, the comparison text is its first 1500 words, cut at a paragraph boundary.
7. **Checkpoint:** show us the sample (name, in-degree, word count), two cleaned pages side by side with their raw versions, and the format notes.

## Phase 2: Pilot (cheap model, about 3 requests)

Run `02_forge.py --round 1 --pilot` on 3 characters (one per in-degree tier) with `PILOT_MODEL`. Show us the outputs next to the real cleaned pages. **Checkpoint:** we fix the prompt before spending Fable money.

## Phase 3: Round 1 with Fable

Dry run, then wait for "go", then `--submit` all 60, commit and push. When we say "collect", run `--collect`. Once it's done, check that each output parses (article inside `<article>` tags) and has roughly the target length, then commit and push. Report any failures instead of silently retrying.

## Phase 4: Features and detector (no API calls)

Use one tokenizer and one set of preprocessing choices for everything, and write the choices down in the notebook (week 5 cares about this). Compute these per document, on the comparison text:

| Feature | Notes |
|---|---|
| hapax ratio | on fixed 400-token windows, averaged. Raw type/token and hapax ratios depend on length (Heaps' law), so never compare unequal lengths |
| type/token ratio | same 400-token windows |
| unseen-bigram rate | share of the doc's bigrams that never occur in the real corpus. **Leave-one-out:** the reference corpus excludes this character's own real page, otherwise real pages trivially score 0 |
| stopword rate | NLTK English stopwords |
| punctuation profile | commas, semicolons, parentheses, dashes (incl. em dashes) per 100 tokens |
| sentence length | mean and standard deviation |
| cosine to corpus | Bag-of-Words (stopwords removed) cosine to the leave-one-out corpus centroid |
| cosine to neighbors | BoW cosine to the real pages of the character's network neighbors |

Detector: standardized features plus logistic regression, evaluated with grouped cross-validation by character (a character's real and forged page always land in the same fold). Also report each feature alone as a one-feature baseline. Freeze this model as **D1** and save it.

Memorization check: for each forgery, the longest shared token run and the number of shared 8-grams with (a) its own real page and (b) any real page. This is the week's "Wikipedia copying itself" opener aimed at the forger.

**Text inspection (required):** in the notebook, print the 5 forgeries D1 is most sure about and the 5 it gets most wrong, with the impossible bigrams highlighted. We read these ourselves before believing any number.

Execute the notebook in place (`jupyter nbconvert --to notebook --execute --inplace`) so outputs and figures are saved and readable on GitHub. Save figures as PNG/SVG in `figures/` too.

**Checkpoint:** D1 accuracy, feature plot (real vs forged distributions), memorization results. Commit and push.

### Minimum shippable version
If we are short on time, skip to Phase 6 after this point with round 1 only. Rounds 2 and 3 are the extension.

## Phase 5: Arms race

- **Round 2:** prompt gets the D1 feedback block (below), with numbers filled in from Phase 4. Score with frozen D1 (did evasion work?), then retrain on rounds 1+2 as **D2** (can counting catch up?).
- **Round 3:** prompt gets the feedback block plus the 2 real style-reference articles, cached because they are identical in every request. Score with frozen D2, then retrain as **D3**.
- Same dry-run, "go", batch procedure for each round.
- **Main figure:** detection accuracy per round, frozen vs retrained detector, plus human accuracy from the game (we add those numbers by hand). Secondary figure: detection probability vs in-degree (is Fable a better forger of famous characters?).

## Phase 6: Game and post

**Game** (inside `week5.html`, logic in `game/game.js`, data in `game/game_data.json`):
- Each turn shows two excerpts about the same character: the real article's opening and the forgery's opening, about 120 words each, cut at sentence boundaries, in random order. The player picks the real one.
- Difficulty = forger round (Round 1 / 2 / 3), selectable.
- After each guess, reveal: the answer, the detector's probability for both full documents, impossible bigrams highlighted in the forged excerpt, and a link to the real Wikipedia article.
- 10 turns per game. End screen: player score vs detector score on the same 10 pairs, plus a "copy results" button that copies a small JSON (round, picks, score) so classmates can paste results to us in Teams. No backend. localStorage only for a personal best, wrapped in try/catch.
- Match the existing site's header, nav and fonts.

**Post** (`week5.html`), in this order: the question; what we did (short); the main figure; the game; what surprised us; what we checked in the underlying text, with 2–3 concrete examples; one limitation (small sample, Fable has likely read Wikipedia, excerpt vs full-page mismatch, etc.).
- Credit: real article text is from Wikipedia under CC BY-SA 4.0, linked.
- Every forgery is clearly labeled as AI-generated wherever it appears.
- Before handing over, serve `Week5/` with `python -m http.server` and fetch the page and `game/game_data.json` with curl to confirm the paths resolve. (Opening via file:// breaks the JSON fetch, so tell us to test the same way if we pull the branch locally.)

## Phase 7: Wrap up

1. Write `AI_METHODS.md`: models used, the exact prompt templates, total spend from `cost_log.csv`, what we verified by hand, and known failure modes.
2. Print the snippets for us to add outside the folder: the Week 5 card and nav link for `index.html`, and the nav link for the other week pages.
3. Run `git status`, confirm everything is committed and nothing secret is in the history, push, and give us the branch name so we can open the pull request.

---

## The forging prompts

Save each block below as its own file in `prompts/`. Placeholders are in `{CURLY_CAPS}`. Stable content comes first so it can be cached, and the per-character content comes last.

### `prompts/forge_system.txt` (all rounds, cached)

```
You are an experienced English Wikipedia editor who writes articles about Marvel Comics characters. You write in Wikipedia's house style: neutral point of view, encyclopedic register, publication history in the past tense, and the fictional character's story described as fiction ("In the storyline ..., X ..."). No fan language, no hype, no rhetorical flourishes.

You are taking part in a university research experiment (DTU course 02805, Social Graphs and Interactions) on whether simple word statistics can tell real Wikipedia articles apart from AI-written ones. Your article will be shown next to the real Wikipedia article about the same character in a public guessing game, clearly labeled as AI-generated once revealed. Your goal is an article that a careful reader cannot tell apart from the real one.

Rules:
- Write in your own words. Do not reproduce sentences from Wikipedia or any other source verbatim. We measure verbatim overlap and report it.
- Follow the format in <format> exactly. Plain text only: no Markdown, no bullet points, no tables, no citation markers such as [1].
- Use what you know about the character.
- Output only the article, inside <article></article> tags. No preamble and no notes afterwards.

<format>
{FORMAT_NOTES}
</format>
```

### `prompts/forge_user_round1.txt`

```
<character>
Name: {NAME}
Short description: {DESCRIPTION}
The real article links to these characters (mention them where it is natural): {OUT_NEIGHBORS}
</character>

<length>
Write about {TARGET_WORDS} words. {LENGTH_NOTE}
</length>
```

`{LENGTH_NOTE}` is either "This is the whole article." or "The real article is longer. Write its opening part and stop at a natural section boundary."

### `prompts/forge_feedback_block.txt` (rounds 2 and 3, inserted into the user message before `<character>`)

```
<detector_feedback>
In the previous round, a detector built only from simple word counts caught {CAUGHT} of {TOTAL} forgeries. These statistics gave the forgeries away (typical real-article value vs. typical forgery value):
{FEATURE_TABLE}

Examples of word pairs the forgeries used that never occur anywhere in about 300 real Marvel Wikipedia articles:
{IMPOSSIBLE_BIGRAMS}

Write so that these statistics look like those of a real article, without making the text worse to read.
</detector_feedback>
```

`{FEATURE_TABLE}`: the 4–5 most discriminative features from the detector, aggregated over all forgeries (never per character). `{IMPOSSIBLE_BIGRAMS}`: about 15 frequent unseen bigrams pooled across forgeries.

### `prompts/forge_references_block.txt` (round 3 only, appended to the system prompt, cached)

```
<style_references>
Two real Wikipedia articles about other Marvel characters, for style reference only. Do not copy their wording or their facts.
<reference name="{REF1_NAME}">
{REF1_TEXT}
</reference>
<reference name="{REF2_NAME}">
{REF2_TEXT}
</reference>
</style_references>
```

### Parsing
Extract the text between `<article>` and `</article>`, then apply the same cleaning function as for the real pages. If the tags are missing, mark the request as failed and report it. Do not guess.
