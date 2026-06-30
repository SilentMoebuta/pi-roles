---
name: systematic-debugging
description: "系统化调试 workflow — 复现报错→隔离范围→假设根因→最小修复→回归验证。用于 bug/故障/报错定位修复类任务。"
task_type: debug
allowed_roles: [debugger]
allowed_tools: [read, bash, write, edit, grep, find, ls, code_search, codegraph_search, codegraph_callers, codegraph_callees, codegraph_node]
source: builtin
version: "1.0"
author: pi
---
# Systematic Debugging Workflow

对齐业界: Claude Code /debug + MetaGPT debug_error+fix_bug + ChatDev Test Error Summary→Modification(3/7 家内置)。

## Steps

1. **复现报错** — 确定性复现: 跑什么命令得到什么错。不能复现先解决复现。
2. **隔离范围** — 二分/日志/最小复现用例, 缩小到具体模块/函数/行。
3. **假设根因** — 基于证据(不是猜测)形成根因假设。codegraph_callers/node 追调用链定位。
4. **最小修复** — 改最少代码修复根因(非症状)。避免 +1 补偿类治症不治本。
5. **回归验证** — 跑原复现用例确认修复 + 跑相关测试确认无回归。
6. **输出根因报告** — 根因/修复/为何这是根因(非症状)/回归结果。

## 与 code-review 边界
systematic-debugging 针对"已知故障/报错"(定位修复); code-review 审查"已有改动"(主动评审)。

## 原则
假设验证, 不瞎改症状。根因 > 症状修复。

## 触发词
bug/报错/故障/不工作/失败
