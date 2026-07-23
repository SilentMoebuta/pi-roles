---
name: consulting-report-writing
description: "Consulting-grade report writing methodology: Minto Pyramid Principle, SCQA, MECE, Action Titles, Findings-to-Recommendations logic chains. Use when writing executive summaries, consulting deliverables, client reports, or any business document that must persuade executives with structured evidence."
---

# Consulting Report Writing Methodology

## Purpose

Transform raw findings and evidence into **consulting-grade reports** that business executives can read in 5 minutes and act on with confidence. Based on Barbara Minto's Pyramid Principle (McKinsey, 1960s), SCQA framework, and MECE structuring - the standard methodology used by MBB (McKinsey/BCG/Bain) and Big Four (Deloitte/PwC/EY/KPMG).

**Not for**: technical docs (API docs, README), code comments, or internal engineering notes. Use tech-writer for those.

---

## 1. Pyramid Principle (Minto)

### Core Rules

1. **Ideas at any level summarize the ideas grouped below them.**
2. **Ideas in each grouping are the same logical kind.**
3. **Ideas in each grouping are logically ordered** (time, structure, or degree).

### Think Bottom-Up, Write Top-Down

- **Thinking**: collect data → identify patterns → form hypotheses → reach conclusions
- **Writing**: state conclusion → present supporting arguments → provide evidence

### Structure

```
            Governing Thought (the answer/conclusion)
           /          |          \
    Argument 1    Argument 2    Argument 3    (3-5 key points, MECE)
     /    \          |            /    \
  Data   Data      Data        Data   Data     (supporting evidence)
```

Each level answers the question the level above raises:
- Conclusion raises "Why?" → Arguments answer
- Arguments raise "How?" → Evidence answers

### Common Errors

1. **Building up instead of leading down** (background → conclusion instead of conclusion → background)
2. **Topics instead of points** ("市场分析" → should be "市场增长 12%，吸引力强")
3. **Too many supporting arguments** (>5 = incomplete synthesis)
4. **Burying the ask** (passive voice, conditional language weakens recommendations)
5. **Assuming audience knowledge** (curse of knowledge - explain what they don't know)

> **Source**: Minto, Barbara. *The Pyramid Principle: Logic in Writing and Thinking*. Revised Edition, 2009.

---

## 2. SCQA Framework

### Four Elements

| Element | Purpose | Proportion | Writing Rule |
|---------|---------|------------|--------------|
| **Situation** | Establish common ground | 10-15% | State facts the reader already knows and accepts. 1-2 sentences. |
| **Complication** | Create urgency | 10-15% | What changed? What problem emerged? Why is status quo unsustainable? |
| **Question** | Frame the problem | 5-10% | The natural question from the complication. "How should we...?" |
| **Answer** | Deliver the conclusion | 60-70% | Direct, specific, actionable recommendation. The pyramid apex. |

### When to Use SCQA vs RSC

- **SCQA**: Standard opening. Use when the audience needs context before the answer.
- **RSC (Resolution-Situation-Complication)**: Use when the audience already agrees on direction and you want to get to the answer faster. Start with the resolution, then briefly recap S and C.

### SCQA Template

```
[Situation]: [1-2 sentences of accepted context]
[Complication]: [1-2 sentences of what changed/broke/is at risk]
[Question]: [The key question this report answers]
[Answer]: [Your core recommendation - 3-5 specific actions with priority]
```

> **Source**: https://strategyu.co/how-scqa-and-the-pyramid-principle-fit-into-the-strategy-consulting-process/

---

## 3. MECE (Mutually Exclusive, Collectively Exhaustive)

### Definition

- **Mutually Exclusive**: No item belongs to more than one group (no overlap)
- **Collectively Exhaustive**: All possibilities are covered (no gaps)

### Application Levels

1. **Report/deck structure**: Sections don't overlap
2. **Section internal structure**: Sub-points within a section don't overlap
3. **Issue trees / analysis frameworks**: Branches are MECE
4. **Individual page content**: Bullet points on a page are MECE

### Common MECE Frameworks

| Framework | When to use | Structure |
|-----------|-------------|-----------|
| 3W (What/Why/How) | Problem-solving | What is it → Why it matters → How to fix |
| Internal vs External | Risk analysis | Internal factors vs External factors |
| People/Process/Technology | Operational assessment | Three lenses on same problem |
| Current/Future | Gap analysis | Current state → Target state → Gap |

### Validation Checklist

- [ ] Can any item belong to two groups? → If yes, not MECE
- [ ] Is anything missing? → If yes, not MECE
- [ ] Are items at the same abstraction level? → If no, restructure

### Common Pitfalls

1. **Partial MECE**: Mutually exclusive but not exhaustive (missing cases)
2. **Overlapping categories**: "Legal" and "Compliance" overlap
3. **Different abstraction levels**: mixing high-level and detail in same group
4. **Forcing MECE when natural order is better**: some content is sequential, not categorical

> **Source**: https://thinkinsights.net/strategy/pyramid-principle

---

## 4. Action Titles

### Rule

Every section/page title is a **complete sentence stating a conclusion**, not a category label.

### Label vs Action Title

| ❌ Label (category) | ✅ Action Title (conclusion) |
|---|---|
| 市场分析 | 市场年增长 12%，但竞争加剧将压缩利润空间 |
| 差距分析 | NDA 模板存在 4 个致命沉默缺陷 |
| 改进建议 | 优先修订 3 项条款可在 30 天内降低合规风险 |
| 财务影响 | 缺口未修复的潜在年损失约 500 万元 |

### Action Title Test

Read only the titles in sequence (skip all body content). Do they tell the complete story? If a reader can understand the full narrative from titles alone, pass. If they need body content to understand the conclusion, fail.

### Bold-Text Only Test

Read only the bold text in each section. Does it convey the key message? If yes, pass.

> **Source**: https://deckary.com/blog/pyramid-principle-consulting

---

## 5. Findings-to-Recommendations Logic Chain

### The 6-Link Chain

```
Evidence → Finding → Implication → Recommendation → Owner → Action
```

| Link | Question | Example |
|------|----------|---------|
| **Evidence** | What data supports this? | "NDA 模板第 3 条将保密信息定义为'所有信息'" |
| **Finding** | What does the evidence show? | "保密信息定义过宽，法院可能不予执行" |
| **Implication** | So what? Why does it matter? | "反不正当竞争法第 9 条要求'相应保密措施'，过宽定义可能导致保护失败" |
| **Recommendation** | What should be done? | "将保密信息定义改为三层分级：核心秘密/一般秘密/公开信息" |
| **Owner** | Who is responsible? | "法务部 - 张律师" |
| **Action** | What is the specific next step? | "30 天内完成模板修订，经法务总监审批后发布" |

### Evidence Strength → Recommendation Style

| Evidence Strength | Source Type | Recommendation Style |
|---|---|---|
| **Strong** | Official regulation, verified contract text, statutory law | Definitive: "必须修订" |
| **Moderate** | Industry benchmark, sample-based observation, expert opinion | Conditional: "建议修订，需确认适用场景" |
| **Weak** | Inference, small sample, unverified assumption | Exploratory: "可考虑探讨，需补充样本确认" |

### Findings-to-Recommendations Matrix Template

| # | Evidence | Finding | Implication | Recommendation | Priority | Owner | Timeline | Evidence Strength |
|---|----------|---------|-------------|----------------|----------|-------|----------|-------------------|
| 1 | ... | ... | ... | ... | High | ... | 30d | Strong |
| 2 | ... | ... | ... | ... | Medium | ... | 60d | Moderate |

### QA Checklist

- [ ] Every recommendation has all 6 links filled?
- [ ] Every recommendation's evidence is cited?
- [ ] Evidence strength is tagged?
- [ ] Priority is assigned (High/Medium/Low)?
- [ ] Owner is named (not "TBD")?
- [ ] Timeline is specific (not "ASAP")?

> **Source**: https://slideworks.io/resources/what-real-consulting-deliverables-look-like-bcg-example

---

## 6. Executive Summary Best Practices

### Length
- **1 page maximum** (300-500 words for text; 1 slide for deck)
- Must be **standalone**: reader can make a decision without reading the rest

### What to Include
1. SCQA opening (situation, complication, question, answer)
2. Core conclusion (the governing thought)
3. 3-5 key recommendations with priority
4. Expected impact / risk if no action taken

### What NOT to Include
- Detailed methodology
- Raw data tables
- Background that the audience already knows
- Conditional language ("might", "could", "perhaps") - be definitive
- Internal process notes

### Standalone Test
Hand the executive summary to someone who hasn't read the report. Can they:
1. Understand what problem is being solved?
2. State the core recommendation?
3. Know what to do next?

If yes to all three, pass.

### BLUF (Bottom Line Up Front) Variant
For shorter reports/memos, use BLUF instead of full SCQA:
> **BLUF**: [One sentence stating the conclusion/recommendation]. [2-3 sentences of key supporting evidence]. [One sentence on next step].

> **Source**: https://www.sembly.ai/blog/how-to-write-a-professional-consulting-report/

---

## 7. Report Structure Template

### Full Consulting Report

```
# [Report Title - Action Title]

## Executive Summary                    [1 page, standalone]
  SCQA → Core Conclusion → Key Recommendations (with priority)

## [Section 1 - Action Title]           [Conclusion first, then evidence]
  Conclusion paragraph
  - Supporting argument 1 + evidence
  - Supporting argument 2 + evidence
  - Supporting argument 3 + evidence

## [Section 2 - Action Title]
  (same structure)

## [Section N - Action Title]
  (same structure)

## Recommendations Summary              [Table: all recommendations]
  | Priority | Recommendation | Owner | Timeline | Evidence Strength |

## Appendix                             [Raw data, methodology, detailed evidence]
  - Detailed data tables
  - Methodology notes
  - Source references
```

### Section Internal Structure

Each section follows the pyramid:
1. **Section title** = action title (conclusion)
2. **First paragraph** = section conclusion (summarizes the argument)
3. **Supporting points** = 3-5 MECE arguments, each with evidence
4. **Evidence** = data, quotes, references

### Cross-Section Flow
Sections should flow as a narrative (story arc), not just a list. Each section should naturally lead to the next. The last section before Recommendations should create the "so what?" that the Recommendations section answers.

> **Source**: https://poesius.com/blog/how-mckinsey-bcg-bain-structure-final-presentations

### Report Structure Diagram (Mermaid)

Every report must include a **chapter structure table** near the beginning (after SCQA, before the first chapter). This table gives the reader a "map" they can return to at any point -- satisfying the "可上可下、可粗可细" navigation principle.

**Use a Markdown table. Do NOT use mermaid** -- mermaid does not render as graphics in Feishu docs (it appears as code text). Tables render correctly everywhere.

**Template:**

```
| 章节 | 核心内容 |
|------|----------|
| 第一章：合同类型画像 | 法律属性、价值流、结构性矛盾 |
| 第二章：交易结构 | 服务范围、报价、指标、退出 |
| 第三章：财务确认 | 收入确认、税务、发票 |
```

**Rules:**
- Chapter names = short noun phrases ("合同类型画像"), NOT full sentences
- "核心内容" column = one-line summary of what the chapter covers
- Keep it to one table -- don't repeat in every chapter

---

## 8. Quality Checklist (Final Review)

Before delivering a report, verify:

### Pyramid Principle
- [ ] First sentence of exec summary = the conclusion
- [ ] Every section leads with its conclusion, not background
- [ ] Arguments are 3-5 per level (not 1, not 10)

### SCQA
- [ ] Exec summary opens with Situation (accepted fact)
- [ ] Complication creates urgency
- [ ] Question frames the problem
- [ ] Answer is specific and actionable

### MECE
- [ ] Sections don't overlap
- [ ] No missing perspective
- [ ] Items within sections are same abstraction level

### Action Titles
- [ ] Every title is a complete sentence with a conclusion
- [ ] Title-only read test passes (titles tell the full story)
- [ ] Bold-text only test passes

### Findings-to-Recommendations
- [ ] Every recommendation has 6 links (Evidence → Finding → Implication → Recommendation → Owner → Action)
- [ ] Evidence strength is tagged on every finding
- [ ] Priority is assigned on every recommendation
- [ ] Owner and timeline are specific (not TBD/ASAP)

### Executive Summary
- [ ] 1 page or less
- [ ] Standalone (reader can decide without reading body)
- [ ] No methodology details
- [ ] No raw data tables
- [ ] Definitive language (not "might/could/perhaps")

---

## References

| Source | Type |
|--------|------|
| Minto, Barbara. *The Pyramid Principle: Logic in Writing and Thinking*. Rev. ed., 2009. | Book (foundational) |
| https://barbaraminto.com/concept | Official site |
| https://strategyu.co/how-scqa-and-the-pyramid-principle-fit-into-the-strategy-consulting-process/ | SCQA + Pyramid guide |
| https://deckary.com/blog/pyramid-principle-consulting | Pyramid + Action Titles |
| https://thinkinsights.net/strategy/pyramid-principle | MECE + Pyramid |
| https://slideworks.io/resources/what-real-consulting-deliverables-look-like-bcg-example | BCG deliverable structure |
| https://poesius.com/blog/how-mckinsey-bcg-bain-structure-final-presentations | MBB presentation structure |
| https://www.sembly.ai/blog/how-to-write-a-professional-consulting-report/ | Consulting report format |
| https://managementconsulted.com/scqa-framework/ | SCQA framework guide |
