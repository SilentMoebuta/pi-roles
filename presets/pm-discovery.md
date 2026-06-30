---
name: pm-discovery
description: "PM Discovery SOP — 领域盘点/痛点收集/竞品扫描/机会识别/优先级/方向规划。用于产品方向/机会/规划/PRD 类任务。"
task_type: pm
allowed_roles: [pm]
allowed_tools: [read, bash, write, edit, grep, find, ls, web_search, fetch_content, fetch_content_cloak, get_search_content]
source: builtin
version: "1.0"
author: pi
---
# PM Discovery Workflow (per-role SOP)

参照 MetaGPT per-role SOP 模式(role 自带 Action 序列)。业界无 PM discovery agent workflow 先例,基于 PM 方法论自建(诚实标注:推理/中,需实战打磨)。

## 7-Step

1. **问题域界定** — 要解决什么、边界、谁是用户、什么不算在范围。输出问题陈述+边界清单。
2. **痛点收集** — 调研(可 spawn researcher 做深度调研,交叉验证)+用户访谈+量化数据。每条标来源+置信度。无来源视为猜测。
3. **竞品扫描** — 谁做了/做到什么程度/gap 在哪。海外+中国厂商都要看。可 spawn researcher 补。
4. **验证聚类** — 痛点归类排序。**关键: 区分 AI 能解的 vs 流程/人/治理问题(不该塞给 agent)**。诚实标注哪些不该用 AI 解。排序不只看痛度,也看 AI 可解性+业界成熟度。
5. **机会识别** — 3-5 个高价值机会。每个说清: 机会是什么(一句)/为什么现在能做(新技术改变可解性?)/业界现状(谁做了 gap 在哪)/差异化(凭什么我们做得更好)/风险与不确定性。
6. **优先级** — 用户价值×可行性×差异化,排序有依据。推荐一个 MVP+说清理由+定义边界(做/不做)。
7. **结构化输出** — 报告+**诚实标注**: 哪些是强证据(行业数据)/推理(逻辑推断)/假设(需验证)。成功指标要领域特化(准确率/介入率/漏期率),不要只看收入/用户数。

## 原则
数据和假设分开说。不确定性不可怕,隐藏不确定性才可怕。不说来源的数据视为猜测。

## 触发词
机会/规划/方向/PRD
