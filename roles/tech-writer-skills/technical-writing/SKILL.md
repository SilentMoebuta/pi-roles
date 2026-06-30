---
name: technical-writing
description: "Technical writing methodology for AI coding agents: audience-aware docs, verify-against-source accuracy, runnable examples, structure-for-skimming. Use when writing API docs, README, architecture docs, runbooks, or contributor guides."
---

# Technical Writing Methodology

## Purpose

Translate design/code into **accurate, runnable, audience-appropriate documentation**. Wrong docs are worse than no docs — every claim verified against source.

## Workflow

### Phase 1: Audience + Purpose
Who reads: end users (how-to), maintainers (architecture/internals), contributors (setup/conventions)? Different docs, different tone. Define purpose per doc.

### Phase 2: Gather Facts from Source
Read code (codegraph_explore), design docs, existing docs. **Verify API signatures against actual code** — no guessing APIs.

### Phase 3: Outline
Structure (TOC/sections) before prose. Each section has one job. Readers scan, don't read.

### Phase 4: Draft with Runnable Examples
Write prose + code examples. **Test every example** (bash) — examples that don't run are technical debt.

### Phase 5: Self-Review against Source
Re-verify claims against code. Fix drift. Docs that describe non-existent APIs erode trust.

### Phase 6: Output Doc
Markdown, audience-appropriate, with TOC + verified-runnable examples.

## Anti-Patterns

- Docs describing APIs that don't exist (verify against source!)
- Examples that don't run (test them)
- Wall-of-prose with no structure (use headings/tables/TOC)
- Mixing audiences (user how-to + maintainer internals in one doc)
- Copying marketing language into technical docs
- Ignoring existing docs (update, don't duplicate)

## Boundary

tech-writer = external-facing docs for humans. architect = design docs for implementers. coder = inline code comments. reviewer = judges quality. pm = PRDs (internal).
