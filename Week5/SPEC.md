# Week 5 Go Nuts: "The Forger"

Spec for our coding agent. Read this whole file before doing anything.

> **Change in this version:** there is no API key. Our Fable access is through our claude.ai account, so forgeries are written by **Fable subagents inside this session**, not by a Python script calling the API. If you already built API-calling code in `02_forge.py`, replace it with the `--render`, `--audit` and `--check` modes described below and drop the `anthropic` dependency.

## The question

Claude Fable 5.1 forges Wikipedia articles about Marvel characters. Can a detector built only from week 5 tools (counts, hapaxes, n-grams, Bag of Words) tell the forgeries from the real articles, and does it beat humans? Then the forger gets told what gave it away and tries again. Who wins the arms race?

The deliverable is one post at `Week5/week5.html`: the question, what we did, one strong figure, a playable real-vs-forged game, what surprised us, what we checked in the text, and one limitation.

## Where this runs

You are running in Claude Code on the web (claude.ai/code), in a cloud VM with a fresh clone of the repo.

- **Files you don't commit can disappear.** The VM pauses when idle and can be reclaimed. Commit and push forgeries as soon as each chunk lands.
- **Network:** the environment allows `sunelehmann.com` (course data), PyPI and GitHub. If a download is blocked, tell us the domain instead of working around it.
- **Usage:** every subagent counts against our claude.ai usage credits. Fable is the expensive part. The main session (you) may run on a cheaper model; only the forger subagents must be Fable.

---

## Hard rules (never break these)

**1. Folder containment.**
- Every file you create or modify lives inside `Week5/`. No exceptions.
- You may READ anything in the repo (e.g. `Week3/week3.html`, `Week4/week4.html` to copy the site's look), but never write outside `Week5/`.
- Do not edit `index.html` or the other weeks' nav bars. At the very end, print the exact snippets we need to add there and we will do it ourselves.
- All links and fetches inside the site use relative paths, so the page works at `.../02805-Social-graphs-and-interactions/Week5/week5.html` on GitHub Pages.

**2. No secrets, no live AI on the site.**
- The website never calls any API. The game only reads precomputed JSON.
- Create `Week5/.gitignore` containing at least: `data/raw/`, `.cache/`, `__pycache__/`, `.ipynb_checkpoints/`.

**3. Git.**
- Work on the session's branch. Commit and push at the end of every phase, and after every chunk of forgeries.
- Never merge to `main`. We review the pull request and merge it ourselves.

**4. Usage.**
- Never spawn Fable subagents for a full round without us typing "go" first.
- Before each round, report the number of forgeries and the total target words, then stop.
- Always do the 3-forgery pilot first and stop afterwards, so we can check how much credit it used before approving a round.
- Spawn forgers in chunks of at most 10 in parallel. Commit and push after each chunk.
- Resumable: never re-spawn a forger whose output file already exists and passed the audit.

**5. When in doubt, stop and ask.** Each phase ends with a checkpoint. Show us the result and wait.

---

## How forging works

The point of the experiment is that the forger is **isolated**. It gets only a character's name, the short description, the network neighbors and the instructions. It must never see the real article, the detector code, or this conversation. Subagents start with a fresh context, which gives us that, as long as the forger doesn't go and read files itself.

**1. Render.** `pipeline/02_forge.py --round N --render` fills in the templates at the bottom of this file and writes one prompt per character to `outputs/prompts/roundN/<node_id>.txt`. Each prompt names its own output path: `outputs/forgeries/roundN/<node_id>.txt`.

**2. Spawn.** For each rendered prompt, spawn a `general-purpose` subagent with `model: claude-fable-5-1` set on the invocation, and pass **the exact file contents as the prompt, verbatim**. Do not summarize, shorten, paraphrase or add to it. The subagent writes the article file and replies "done".

**3. Audit.** After each chunk, `02_forge.py --round N --audit` checks every forger. First inspect where Claude Code stores subagent transcripts in this VM (the docs say `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`) and what they contain. Then, per forger:
- The prompt it received is identical to the rendered file.
- The model was Fable.
- Its only tool call was a single Write to its own output path. Any Read, Bash, Grep, Glob, WebFetch or WebSearch call means the forgery is contaminated: delete it and re-spawn.

Copy each forger's transcript to `outputs/transcripts/roundN/<node_id>.jsonl`. Record any token usage the transcripts show in `outputs/usage_log.csv`. If transcripts aren't where expected, or don't show the prompt or tool calls, **stop and tell us** rather than skipping the audit.

**4. Check.** `02_forge.py --round N --check` confirms each output parses (article inside `<article>` tags) and is roughly the target length. Report failures instead of silently retrying.

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
  prompts/             the templates below, one file each
  pipeline/
    config.py          paths, sample sizes
    01_prepare.py
    02_forge.py        --round {1,2,3} --render | --audit | --check  [--pilot]
    03_features.py
    04_detector.py
    05_game_data.py
  outputs/
    prompts/round1/ round2/ round3/      rendered prompts, exactly as sent
    forgeries/round1/ round2/ round3/    one .txt per character, written by the forger
    transcripts/round1/ round2/ round3/  copied forger transcripts (provenance)
    usage_log.csv
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

## Phase 0: Look around

1. Read `Week3/week3.html` and `Week4/week4.html` to learn the site's style and nav structure. Do not modify them.
2. Create the folder layout, `.gitignore`, `requirements.txt`, and install the requirements.
3. Check that `https://sunelehmann.com/socialgraphs2026-web/data/` is reachable.
4. **Checkpoint:** show us the tree and your plan, then commit and push.

## Phase 1: Data and cleaning

1. Read the course data page (`https://sunelehmann.com/socialgraphs2026-web/data/`) and download into `Week5/data/raw/`: `marvel_pages.zip`, `week1_nodes.tsv` (has a `description` column), and the week 1 edge list. Load the pages with the loading snippet from that page (dict keyed by `node_id`). Put the download in `01_prepare.py` so a fresh VM can redo it.
2. **Inspect the raw format before cleaning.** Look for section headings, reference remnants, "See also", "References", "External links", infobox leftovers and anything else that is formatting rather than prose. Print three raw pages for us.
3. Write ONE cleaning function. It keeps the prose and turns headings into a single consistent form, and it will later be applied identically to real and forged text. Otherwise the detector learns formatting instead of language. That is exactly the trap the week 5 page warns about.
4. Write `prompts/format_notes.txt`: a short, plain description of what a cleaned real article looks like (heading style, typical section order, paragraph style). This gets inserted into the forging prompt.
5. Pick the sample: 60 characters stratified by in-degree (20 high, 20 middle, 20 low), only among pages with at least 400 cleaned words. Also pick 2 extra characters with mid-length pages as the fixed round-3 style references, and exclude those 2 from the sample. Save to `data/clean/sample.json`.
6. For each sampled character: target length = min(real cleaned word count, 1500). If the real page is longer than 1500 words, the comparison text is its first 1500 words, cut at a paragraph boundary.
7. **Checkpoint:** show us the sample (name, in-degree, word count), two cleaned pages side by side with their raw versions, and the format notes.

## Phase 2: Pilot (3 Fable forgers)

Render round 1 for 3 characters (one per in-degree tier) with `--pilot`. Spawn, audit, check, commit and push. Show us the 3 forgeries next to the real cleaned pages, plus the audit result.

**Checkpoint:** we check how much credit the pilot used and fix the prompt if needed before approving round 1.

## Phase 3: Round 1

Report the count and total target words, wait for "go", then render, spawn in chunks of 10, and audit, check, commit and push after each chunk.

## Phase 4: Features and detector

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

- **Round 2:** the prompt gets the D1 feedback block (below), with numbers filled in from Phase 4. Score with frozen D1 (did evasion work?), then retrain on rounds 1+2 as **D2** (can counting catch up?).
- **Round 3:** the prompt gets the feedback block plus the 2 real style-reference articles. Score with frozen D2, then retrain as **D3**.
- Same procedure for each round: report, wait for "go", render, spawn in chunks, audit, check, commit.
- **Main figure:** detection accuracy per round, frozen vs retrained detector, plus human accuracy from the game (we add those numbers by hand). Secondary figure: detection probability vs in-degree (is Fable a better forger of famous characters?).

## Phase 6: Game and post

**Game** (inside `week5.html`, logic in `game/game.js`, data in `game/game_data.json`):
- Each turn shows two excerpts about the same character: the real article's opening and the forgery's opening, about 120 words each, cut at sentence boundaries, in random order. The player picks the real one.
- Difficulty = forger round (Round 1 / 2 / 3), selectable.
- After each guess, reveal: the answer, the detector's probability for both full documents, impossible bigrams highlighted in the forged excerpt, and a link to the real Wikipedia article.
- 10 turns per game. End screen: player score vs detector score on the same 10 pairs, plus a "copy results" button that copies a small JSON (round, picks, score) so classmates can paste results to us in Teams. No backend. localStorage only for a personal best, wrapped in try/catch.
- Match the existing site's header, nav and fonts.

**Post** (`week5.html`), in this order: the question; what we did (short); the main figure; the game; what surprised us; what we checked in the underlying text, with 2–3 concrete examples; one limitation (small sample, Fable has likely read Wikipedia, excerpt vs full-page mismatch, forgers ran inside Claude Code rather than a bare API call, etc.).
- Credit: real article text is from Wikipedia under CC BY-SA 4.0, linked.
- Every forgery is clearly labeled as AI-generated wherever it appears.
- Before handing over, serve `Week5/` with `python -m http.server` and fetch the page and `game/game_data.json` with curl to confirm the paths resolve. (Opening via file:// breaks the JSON fetch, so tell us to test the same way if we pull the branch locally.)

## Phase 7: Wrap up

1. Write `AI_METHODS.md`: models used, how forgers were isolated and audited, the exact prompt templates, usage from `usage_log.csv`, what we verified by hand, and known failure modes.
2. Print the snippets for us to add outside the folder: the Week 5 card and nav link for `index.html`, and the nav link for the other week pages.
3. Run `git status`, confirm everything is committed, push, and give us the branch name so we can open the pull request.

---

## The forging prompt

Save each block as its own file in `prompts/`. Placeholders are in `{CURLY_CAPS}`. A rendered prompt is assembled in this order: instructions, then (round 3) style references, then (rounds 2–3) detector feedback, then the character, length and output blocks.

### `prompts/forge_instructions.txt` (every prompt starts with this)

```
<instructions>
You are an experienced English Wikipedia editor who writes articles about Marvel Comics characters. You write in Wikipedia's house style: neutral point of view, encyclopedic register, publication history in the past tense, and the fictional character's story described as fiction ("In the storyline ..., X ..."). No fan language, no hype, no rhetorical flourishes.

You are taking part in a university research experiment (DTU course 02805, Social Graphs and Interactions) on whether simple word statistics can tell real Wikipedia articles apart from AI-written ones. Your article will be shown next to the real Wikipedia article about the same character in a public guessing game, clearly labeled as AI-generated once revealed. Your goal is an article that a careful reader cannot tell apart from the real one.

Rules:
- Write in your own words. Do not reproduce sentences from Wikipedia or any other source verbatim. We measure verbatim overlap and report it.
- Follow the format in <format> exactly. Plain text only: no Markdown, no bullet points, no tables, no citation markers such as [1].
- Use what you know about the character. Everything else you need is in this message.

<format>
{FORMAT_NOTES}
</format>
</instructions>
```

### `prompts/forge_references_block.txt` (round 3 only)

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

### `prompts/forge_feedback_block.txt` (rounds 2 and 3)

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

### `prompts/forge_character.txt` (every prompt ends with this)

```
<character>
Name: {NAME}
Short description: {DESCRIPTION}
The real article links to these characters (mention them where it is natural): {OUT_NEIGHBORS}
</character>

<length>
Write about {TARGET_WORDS} words. {LENGTH_NOTE}
</length>

<output>
Use the Write tool exactly once to save the article, wrapped in <article></article> tags, to this path:
{OUTPUT_PATH}
Do not use any other tool. Do not read files, run commands, or search the web.
After saving, reply with only the word: done
</output>
```

`{LENGTH_NOTE}` is either "This is the whole article." or "The real article is longer. Write its opening part and stop at a natural section boundary."

### Parsing
Extract the text between `<article>` and `</article>`, then apply the same cleaning function as for the real pages. If the tags are missing, mark the forgery as failed and report it. Do not guess.
