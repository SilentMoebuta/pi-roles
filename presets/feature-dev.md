---
name: feature-dev
description: "引导式特性开发 workflow — 需求澄清→设计/任务拆解→实现→自测验证→修复循环→交付。用于新功能开发类任务。"
task_type: coding
allowed_roles: [planner, coder, reviewer]
allowed_tools: [read, bash, write, edit, grep, find, ls, code_search, codegraph_search, codegraph_files]
source: builtin
version: "1.0"
author: pi
---
# Feature Dev Workflow

对齐业界: MetaGPT 全 SOP + ChatDev Coding→Complete + CrewAI planning + Factory Missions+Spec Mode + Devin build features(5/7 家内置)。

## Steps

1. **需求澄清** — 明确做什么、不做什么、成功标准、边界。可衔接 pm-discovery 产出的需求。
2. **设计/任务拆解** — spawn planner: 架构决策 + 任务拆成可独立执行的子任务(标依赖)。
3. **实现** — spawn coder: 按子任务实现, TDD 优先(Red-Green-Refactor)。
4. **自测/验证** — 跑测试 + 验证成功标准。
5. **修复循环** — 测试失败 → spawn debugger 定位根因修复 → 重测, 到收敛。
6. **交付** — spawn reviewer 审查 + 提交。

## 与 pm-discovery 衔接
pm-discovery 产出需求(领域盘点→机会→优先级); feature-dev 接力实现(设计→编码→测试→交付)。

## 触发词
实现/开发/feature/新功能
