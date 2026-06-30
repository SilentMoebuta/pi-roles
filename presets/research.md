---
name: research
description: "调研 workflow — 多源查证、交叉验证、引用溯源、诚实标注不确定性。用于调研/对比/现状/可行性类任务。"
task_type: research
allowed_roles: [researcher]
allowed_tools: [read, bash, grep, find, ls, web_search, fetch_content, fetch_content_cloak, get_search_content, code_search]
source: builtin
version: "1.0"
author: pi
---
# Research Workflow (per-role SOP)

对齐业界: MetaGPT Researcher 三动作(CollectLinks→WebBrowseAndSummarize→ConductResearch) + Claude Code /deep-research(多角度 fan-out 搜索→交叉验证→claim 投票过滤→带引用报告)。

## 5-Phase

1. **明确问题** — 要查什么、边界、关键词、已知信息。输出查询计划。
2. **多源查证** — 至少 2 独立来源(不互引)印证重要 claim。优先一手(厂商官网/学术论文/行业报告),二手引用标"经X引用"。
3. **交叉验证** — claim 需多源印证;冲突显式报告。**建议补: claim 投票过滤(未过交叉验证的 claim 被过滤,对标 /deep-research)**。
4. **结构化输出** — 带引用(citation + URL + 置信度 高/中/低/猜测)。**建议补: 引用溯源(输出锚定原文位置)**。
5. **诚实标注不确定性** — 冲突/弱证据显式说"不确定"。不说来源的数据视为猜测。

## 触发词
调研/了解/对比/现状/可行性
