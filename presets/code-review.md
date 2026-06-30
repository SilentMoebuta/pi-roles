---
name: code-review
description: "多步代码审查 workflow — 拉 diff、按正确性/安全/可维护/迁移风险维度评审、给分级修改建议。用于 PR/改动审查类任务。"
task_type: review
allowed_roles: [reviewer, chief-reviewer]
allowed_tools: [read, bash, grep, find, ls, code_search, codegraph_search, codegraph_callers, codegraph_callees, codegraph_impact]
source: builtin
version: "1.0"
author: pi
---
# Code Review Workflow

对齐业界: Claude Code /code-review + MetaGPT write_code_review + ChatDev Code Review phase + Factory /review(4/7 家内置)。

## Steps

1. **拉 diff/改动范围** — git diff 或改动文件清单。明确审查对象。
2. **按四维度评审**:
   - **正确性**: 逻辑对吗?边界条件?并发?错误处理?
   - **安全**: 注入/鉴权/敏感数据/依赖漏洞?
   - **可维护性**: 命名/复杂度/重复/可读性?
   - **迁移风险**: 破坏性改动?兼容性?回滚成本?
3. **分级修改建议**:
   - 🔴 必须改(blocker): 合并/发布前必修
   - 🟡 建议改(should): 不阻塞但该改
   - 🟢 可选(nice-to-have): 锦上添花
4. **(可选)二次复审** — 修改后重新拉 diff 复审到收敛。
5. **输出审查报告** — 每条标 位置/维度/级别/具体建议。

## 与 systematic-debugging 边界
code-review 审查"已有改动"(主动评审); systematic-debugging 针对"已知故障/报错"(定位修复)。

## 触发词
审查/review/PR/代码评审
