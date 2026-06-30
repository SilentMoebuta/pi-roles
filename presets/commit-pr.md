---
name: commit-pr
description: "提交/PR 收尾 workflow — 汇总 diff、风险自查、生成 commit message + PR 描述。用于代码提交/PR 创建类任务。"
task_type: coding
allowed_roles: [coder, reviewer]
allowed_tools: [read, bash, write, edit, grep, find, ls, code_search]
source: builtin
version: "1.0"
author: pi
---
# Commit / PR Workflow

对齐业界: Claude Code /commit + Factory PR review/commit + Devin commit workflow(P1, 中-高置信度)。

## Steps

1. **汇总 diff** — git diff --stat + git log, 明确本次改动范围。
2. **风险自查** — 破坏性改动? 敏感信息? 测试覆盖? 迁移影响?
3. **生成 commit message** — Conventional Commits 格式(type: scope: subject + body)。一行说清做了什么。
4. **生成 PR 描述** — 改什么/为什么/如何验证/风险/回滚。可调 code-review preset 复审。
5. **交付** — commit + push + 创建 PR(或输出待提交内容供人工确认)。

## 原则
commit message 说清"做了什么", PR 描述说清"为什么 + 如何验证"。不堆砌。

## 触发词
提交/commit/PR/push
