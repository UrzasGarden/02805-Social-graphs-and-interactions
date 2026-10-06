# AI methods: Week 5, "The Forger"

This file documents every use of AI in Week 5, as the course requires: which models did what, how the forgers
were isolated and audited, the exact prompts, how much usage they cost, what was checked by hand, and what can go
wrong. The website itself never calls an AI; the game reads precomputed data (`game/game_data.json`).

## 1. Models and roles

| Role | Model / tool | What it did |
|---|---|---|
| **Forger** (the object of study) | Claude Fable 5.1 (`claude-fable-5-1`), each forgery written by its own Claude Code `general-purpose` subagent | Wrote 3 pilot forgeries and 60 round-1 forgeries. Effort was Claude Code's default for subagents (`xhigh`); the subagent tool offers no way to lower it. |
| **Coding agent** | Claude Code (main session), on claude.ai | Wrote the pipeline (`pipeline/`), rendered the prompts, spawned the forgers, ran the audits, built the notebook, the game and this post, under the group's direction and go/no-go at every phase checkpoint. |
| **Detector** | none (no AI) | Logistic regression on 12 word-count features (`pipeline/04_detector.py`). |

No API key was ever used and no paid API call was made. An early plan used the Anthropic API with a cheap pilot
model; it was dropped when we switched to subagents inside Claude Code (see `SPEC.md`, "Change in this version").

Rounds 2 and 3 of the planned arms race were **not run**. The round-2 prompts (with the detector feedback block) were
rendered and are in `outputs/prompts/round2/`, but no forger ever received them.

## 2. How the forgers were isolated

* Each forger was a fresh subagent: it starts with an empty context and never sees this conversation, the real
  article, the detector code or any other file, unless it reads files itself.
* Its whole input was one rendered prompt (`outputs/prompts/<round>/<character>.txt`), passed verbatim. The prompt
  contains only: the instructions, the format notes, the character's name, the one-line description from the course
  node file, the names of the characters the real article links to, and the target length.
* The prompt tells it to use the Write tool exactly once to a given path and nothing else.
* Caveats: the subagent also sees Claude Code's own subagent system prompt, a list of available skills, basic
  environment facts (working directory, date) and a harness reminder to finish by calling a hand-back tool. None of
  these contain article text.

## 3. How every forger was audited

`pipeline/02_forge.py --audit` reads each forger's Claude Code transcript
(`~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`) and checks:

1. the first message it received is **byte-identical** to the rendered prompt file;
2. every model response came from `claude-fable-5-1`;
3. its tool calls were exactly **one Write** to its own output path, plus at most one `SubagentHandback` (the harness
   tool every subagent uses to return its final reply). Any Read, Bash, Grep, Glob, WebFetch, WebSearch or other
   call would mark the forgery as contaminated and delete it;
4. the file on disk is identical to what the forger wrote.

`--check` then confirms the article is inside `<article></article>` tags and within 0.7 to 1.3 times the target
length.

**Result: 63 of 63 forgers passed** (3 pilot + 60 round 1). None was contaminated, none had to be re-spawned.
Round-1 lengths ranged from 0.88 to 1.22 times the target (median 1.01).

Each passing transcript is copied to `outputs/transcripts/<round>/`. Before committing (this repository is public),
the copy has the account e-mail address and organisation id blanked; `audit.json` keeps a SHA-256 of each original.

## 4. The exact prompt templates

A rendered prompt is: instructions (with the format notes inserted at `{FORMAT_NOTES}`), then, for rounds 2 and 3
only, the feedback block, then the character block. Placeholders are in `{CURLY_CAPS}`.

### `prompts/forge_instructions.txt`
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

### `prompts/format_notes.txt` (inserted at `{FORMAT_NOTES}`)
```
A cleaned real article is plain text with this shape.

Headings: each section heading sits on its own line written as == Heading == (two equals signs, a space, the heading, a space, two equals signs). There is one blank line before and after every heading. There is no heading above the opening paragraphs. Subsections use the same == Heading == form; there is no deeper level.

Paragraphs: one blank line between paragraphs. A paragraph is a few sentences long, typically 40 to 90 words. No bullet points, numbered lists, tables, images, citation markers, URLs or markup of any kind.

Opening: one to three paragraphs with no heading. The first sentence names the character and says they are a fictional character or superhero appearing in American comic books published by Marvel Comics. The opening then gives the creators and the first appearance (title, issue number, cover date in parentheses), the character's alter ego and affiliations, and often a sentence on adaptations in other media.

Typical section order:
== Publication history ==  (creation, first appearance, creators, later series and notable runs, in the past tense; sometimes titled Creation or split by decade such as == 1970s ==)
== Fictional character biography ==  (the character's story told as fiction, in the present tense; longer articles split this into storyline subsections such as == "Secret Invasion" == or == Death ==)
== Powers and abilities ==  (one or two paragraphs)
== Other versions ==  (alternate-universe versions, e.g. Ultimate Marvel, Marvel Zombies, House of M)
== In other media ==  (often split into == Television ==, == Film ==, == Video games ==; each appearance is one short sentence stating the work and the voice or screen actor)
== Reception ==  (rankings and critical response, e.g. "In 2019, CBR.com ranked X 8th in their ... list.")

Not every article has every section. Short articles usually have only Publication history, Fictional character biography and Powers and abilities. Wikipedia's References, External links and See also sections are not part of the cleaned text, so do not write them.

Register: neutral encyclopedic prose. Comic issue references look like The Avengers #57 (October 1968). Storyline names are in double quotes ("Civil War"). En dashes appear in ranges such as 2012–2014; em dashes are rare. Parentheses are common for dates and real names, e.g. Robert Frank (Whizzer).
```

### `prompts/forge_character.txt`
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

`{LENGTH_NOTE}` is "This is the whole article." or "The real article is longer. Write its opening part and stop at
a natural section boundary." `{OUT_NEIGHBORS}` lists the names of characters the real article links to (week 1
network), or "(none)".

### `prompts/forge_feedback_block.txt` (rounds 2 and 3; rendered for round 2, never sent)
```
<detector_feedback>
In the previous round, a detector built only from simple word counts caught {CAUGHT} of {TOTAL} forgeries. These statistics gave the forgeries away (typical real-article value vs. typical forgery value):
{FEATURE_TABLE}

Examples of word pairs the forgeries used that never occur anywhere in about 300 real Marvel Wikipedia articles:
{IMPOSSIBLE_BIGRAMS}

Write so that these statistics look like those of a real article, without making the text worse to read.
</detector_feedback>
```

### `prompts/forge_references_block.txt` (round 3; never used)
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

## 5. Usage

From `outputs/usage_log.csv`, summed over forgers. Claude Code stores the usage block from the *start* of each
streamed reply, so input and cache figures are complete, but output (article and thinking) tokens are not recorded.
The article size below is estimated from the written text (words x 1.35); thinking tokens are unknown.

| Batch | Forgers | Cache writes | Cache reads | Uncached input | Article tokens (est.) | Wall time |
|---|---|---|---|---|---|---|
| Pilot | 3 | 197,479 | 136,590 | 102 | ~4,300 | 11 min summed, run in parallel |
| Round 1 | 60 | 1,322,812 | 4,182,648 | 2,040 | ~87,000 | 108 min summed, run 10 at a time |

Most input is Claude Code's own subagent context (about 45,000 tokens per forger). From the second chunk of round 1
on, forgers read that shared context from cache, which cut each forger's cache writes from about 50,000 to
12,000-22,000 tokens. These numbers were reported to the group after the pilot, before round 1 was approved.

## 6. What was checked by hand

Checked during the work (by the coding agent, with results shown to the group at each checkpoint):

* Three raw pages and two raw-vs-cleaned pairs were printed and read before the cleaning function was written
  (`outputs/phase1_inspection.md`).
* The three pilot forgeries were read side by side with the real pages (`outputs/pilot_round1_comparison.md`).
* The 5 forgeries D1 is surest about and the 5 documents it gets most wrong are printed in full, with never-seen word
  pairs marked, in `notebooks/analysis.ipynb`.
* The sentence-length gap was re-measured on proper prose paragraphs only (real 20.2, forged 24.5 tokens) to rule out
  flattened lists in real pages.
* The longest verbatim runs between forgeries and real pages were read: they are Wikipedia's stock opening sentence
  with facts filled in, not memorised prose.
* The game was played end to end in a browser, and every page asset was fetched over HTTP.

**To be done by the group before submitting:** read a sample of forgeries yourselves (the notebook and the game both
show them), and spot-check a few factual claims. We saw wrong cover dates (She-Hulk's debut given as February 1980
instead of November 1979) but did not fact-check the forgeries systematically.

## 7. Known failure modes and caveats

* **Truncated descriptions.** Two descriptions in the course node file are cut off mid-sentence (Kristoff Vernard,
  Scarlet Spider) and were passed to the forger as they are. These are exactly the two pairs the detector loses.
* **Disambiguators in names.** Neighbour names keep Wikipedia's tags, e.g. "Franklin Richards (character)".
* **Forgers ran inside Claude Code, not as bare API calls.** They had Claude Code's system prompt, ran at high effort,
  and three of 63 replied "done" plus a one-line summary instead of just "done". One round-1 forger took 19 minutes
  instead of 1-4, with no extra tool calls.
* **Hallucinated or hedged facts.** Forgeries contain small factual errors (dates) and occasional hedged filler (the
  pilot Kristoff Vernard "Other versions" section names versions in which he "does not appear").
* **Feature choices.** Word pairs ignore punctuation ("Romanova) is" counts as "romanova is"). The never-seen-pair
  highlighting also lights up the character's own name, because its own page is left out of the reference corpus.
  The sentence splitter is a rule-based heuristic.
* **Probabilities shown in the game are out-of-fold:** each pair was scored by a D1 model trained without that
  character. The frozen D1 file (`outputs/models/D1.joblib`) is trained on all 120 documents.
* **NLTK.** NLTK's downloader refuses to run behind the VM's proxy, so the stopword list is fetched directly from the
  NLTK data repository into the git-ignored `.cache/`.
* **Small sample.** 60 characters, one forgery each; the 97% pair accuracy has a wide confidence interval.
