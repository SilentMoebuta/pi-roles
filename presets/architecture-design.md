---
name: architecture-design
description: "架构设计 workflow — 约束分析→research-backed options→contract-first 设计→ADRs→风险识别。用于系统设计/API/数据模型/架构决策类任务, 先于 planner 任务拆解。"
task_type: coding
allowed_roles: [architect, planner]
allowed_tools: [read, bash, grep, find, ls, web_search, fetch_content, fetch_content_cloak, get_search_content, code_search, codegraph_search, codegraph_files, codegraph_explore]
source: builtin
version: "1.0"
author: pi
---
# Architecture Design Workflow

衔接: pm-discovery 产出需求 → **architecture-design 出设计** → planner 拆任务 → coder 实现。
本 preset 补 Phase 2b 链路断层(architect role 无 preset 入口)。

## Steps (对齐 architect-skills/architecture-design SKILL.md)

1. **约束分析** — 读 codebase (codegraph_files/explore), 现有模式, 非功能需求(规模/安全/性能)。明确什么是固定的、什么是灵活的。
2. **research-backed options** — web_search 标准模式 + 失败模式。**≥2 references per major decision**(标来源)。记录文档化的 trade-off。
3. **propose 2-3 architectures** — 意义不同(非 straw-man), 具体权衡(复杂度/风险/维护/性能)。先给推荐 + rationale。
4. **define contracts (contract-first)** — API endpoints, 数据模型, 组件接口, 数据流。这些是 coder 实现的依据, 必须具体到能据此编码。
5. **identify risks** — 什么会出错, 迁移影响, 回滚方案。显式标注假设。
6. **output design doc** — 架构 + contracts + ADRs(架构决策记录) + 风险。

## 与 planner 边界
architecture-design = design-level(系统形状+契约, what/why); planner = task-level(ordered steps for coder, how)。本 preset 产出喂 planner。

## Anti-Patterns
- "用微服务架构" 却无契约
- 隐藏假设(都该作 ADR 记录)
- straw-man 替代方案
- 忽略现有 codebase 模式
- 设计无迁移/回滚考虑

## 触发词
架构/设计/API/数据模型/系统设计
