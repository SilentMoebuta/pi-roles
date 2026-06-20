---
name: technical-research
description: "Conduct rigorous, multi-source research on technical topics using structured methodology. 5-phase workflow (Scope → Discover → Read → Verify → Synthesize), 4-tier source trust hierarchy, explicit confidence levels, and mandatory citations. Use when asked to research, investigate, find out about, compare, or verify any technical topic."
---

# Technical Research Methodology

## Purpose

A systematic, citation-rich approach to technical research that prioritizes accuracy over speed. Every claim must be backed by at least 2 independent sources. Uncertainty is reported explicitly — never silently pick one version of a disputed fact.

## 5-Phase Workflow

### Phase 1: Scope Definition

Before any search, clarify:
1. **Core question** — what specific question needs answering?
2. **Required depth** — surface overview or exhaustive deep-dive?
3. **Recency needs** — is timeliness critical? (API versions, current events)
4. **Authoritative sources** — what would count as a definitive answer?

### Phase 2: Source Discovery

Cast a wide net:
1. **Web search** with 3-5 different phrasings of the core question
2. **Code search** for API/library references and implementations
3. Identify authoritative sources: official docs, peer-reviewed papers, GitHub repo READMEs, recognized experts
4. Use site-scoped search: `site:docs.python.org`, `site:github.com`

### Phase 3: Deep Reading

For each promising source:
1. Fetch full content (web_search → get_search_content chain)
2. Extract key claims, facts, figures, dates, quotes
3. Note source metadata: author, date, organization, potential biases
4. Flag conflicts: does this contradict other sources?

### Phase 4: Cross-Verification

For each major claim:
1. Find 2+ independent sources that don't cite each other
2. Prefer newer sources for rapidly evolving topics (last 6 months)
3. Weight by authority: primary sources > secondary > tertiary
4. When sources disagree: report all positions, investigate why, never silently pick one

### Phase 5: Synthesis & Output

Call `report_role_result` with structured findings:
- **findings**: array of research findings, each with the claim + citation
- **artifacts**: paths to any files created during research

---

## 4-Tier Source Trust Hierarchy

| Tier | Sources | Use for |
|------|---------|---------|
| **Tier 1 — Authoritative** | Official vendor docs, RFC/specs, peer-reviewed papers, GitHub repo READMEs | Definitive answers, API contracts |
| **Tier 2 — High-signal community** | Stack Overflow (accepted/high-vote), GitHub Issues (reactions), official changelogs | Real-world patterns, known bugs |
| **Tier 3 — Useful but verify** | Hacker News, Reddit engineering subs, well-cited blogs, Dev.to | Ecosystem trends, opinions |
| **Tier 4 — Last resort** | General tutorials, Medium, blog posts | Background context only — always cross-check with Tier 1/2 |

> **Golden rule**: Never cite Tier 3/4 as the sole source for a technical claim. Always pair with a Tier 1 or Tier 2 source.

---

## Confidence Levels

| Level | Criteria |
|-------|----------|
| **High** | 3+ independent authoritative sources agree; no conflicts |
| **Medium** | 2 sources agree, or 1 highly authoritative source; minor conflicts |
| **Low** | Single source, or significant conflicts between sources |
| **Uncertain** | Sources conflict significantly; unable to determine truth |

State confidence explicitly. "I'm not sure" is a valid finding.

---

## Anti-Patterns to Avoid

| Anti-Pattern | Instead |
|--------------|---------|
| Single source | Always 2+ independent sources |
| Uncited claims | Every factual claim needs a source |
| Assuming first result is best | Evaluate source quality (tier, recency, authority) |
| Ignoring conflicts | Report all positions with citations |
| Outdated sources | Check publication dates; flag >3 years in fast-moving fields |
| Stopping early | Research until diminishing returns on new information |
| Trusting AI summaries | Go to primary sources; AI summaries may hallucinate |

---

## Parallel Search Strategy

For efficient research, launch sources in parallel grouped by tier:

```
STEP 1 — PARALLEL (Tier 1):
  ├── fetch official docs
  ├── fetch GitHub README / repo metadata
  └── code_search for implementations

STEP 2 — PARALLEL (Tier 2):
  ├── web_search for Stack Overflow / GitHub Issues
  └── web_search for changelogs / release notes

STEP 3 — ONLY IF NEEDED (Tier 3):
  └── web_search for community discussion (HN, Reddit)

→ Synthesize after each step; stop when enough evidence gathered.
```

## PRISMA-Style Screening (core 20%)

Adopt the CORE 20% of PRISMA 2020 (Page et al., BMJ 2021 — gold standard for evidence synthesis, adopted by Cochrane/WHO), NOT the full medical-review flow:

1. **Declare inclusion/exclusion criteria BEFORE searching** — prevents confirmation bias (deciding after seeing results). E.g. "include: official docs + source code + 2024+; exclude: AI-generated content, non-English, <3rd-party-citation blog posts."
2. **Screening count** — record N found → N after dedup → N title/abstract screened → N full-text → N included. Surface this in the report (a one-line flow).
3. **Exclusion reasons** — document WHY each excluded source was dropped (outdated, irrelevant, duplicate, low quality, behind paywall).

This makes the research auditable + reproducible, and surfaces publication/selection bias.

## Search Strategy Documentation + Snowballing

Document the search PROCESS itself (Kitchenham 2004, EBSE):
- Exact search strings used (the queries)
- Sources/databases searched + rationale for each
- Date ranges applied
- N results per source

**Snowballing** (critical discovery technique):
- **Backward** — chase the citations of a strong source (find what IT relied on)
- **Forward** — find newer sources citing a strong source (find what built on it)

Catches canonical/foundational work that keyword search misses.

## Saturation Heuristic — When to Stop

"Diminishing returns" is dangerously vague. Use a concrete saturation criterion (grounded theory, Glaser & Strauss 1967):

> Stop after **N=3-5 consecutive sources yield no new claims** (not just no new sources — no new CLAIMS/findings).

Track "new claims per source" — when it flatlines, you've saturated. State this in the report ("saturation reached after source N, last 4 sources added 0 new claims").

## Retrieval-Augmented Citation Verification (newer SOTA)

Models hallucinate citations. As a final verify phase step, RE-FETCH each cited URL/claim before finalizing the report — confirm the source says what you say it says. Drop any citation that 404s or doesn't support the claim. This is increasingly standard as citation hallucination is a known LLM failure mode.
