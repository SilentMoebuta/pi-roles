---
name: architecture-design
description: "Structured architecture design methodology for AI coding agents: constraint analysis, research-backed options, contract-first design, ADRs, risk identification. Use when designing system architecture, API contracts, data models, or component boundaries before implementation."
---

# Architecture Design Methodology

## Purpose

Produce **design documents + contracts** that coder can implement against — not vague architecture diagrams. Design-level (what/why), feeds planner (task-level how).

## Workflow

### Phase 1: Understand Constraints
Read codebase (codegraph_files/explore), existing patterns, non-functional requirements (scale/security/perf). Identify what's fixed vs flexible.

### Phase 2: Research Options
Web search standard patterns + failure modes for the problem domain. **≥2 references per major decision** (cite sources). Note documented trade-offs.

### Phase 3: Propose 2-3 Architectures
Meaningfully different (not straw-men), with concrete trade-offs (complexity/risk/maintenance/perf). Lead with recommendation + rationale.

### Phase 4: Define Contracts (contract-first)
API endpoints, data models, component interfaces, data flow. These are what coder implements against — must be concrete enough to code from.

### Phase 5: Identify Risks
What could go wrong, migration impact, rollback plan. Surface assumptions.

### Phase 6: Output Design Doc
Architecture + contracts + ADRs (architecture decision records) + risks.

## Anti-Patterns

- No "we'll use a microservices architecture" without contracts
- No hidden assumptions (document them as ADRs)
- No straw-man alternatives
- No ignoring existing codebase patterns
- No design without migration/rollback consideration

## Output

Design doc with: proposed architectures, recommendation + rationale, API/data contracts, ADRs, risks.
