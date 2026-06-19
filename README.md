# pi-roles

> Multi-roles for the [pi](https://github.com/earendil-works/pi) coding agent.
> Status: scaffolded (2026-06-19). Implementation pending design confirmation.

## 定位

pi 的 **multi-roles 层**——spawn_role 派生角色化子代理，带 persona / tool 白名单 / per-role skill 隔离 / subagent 控制面（防失控与 handoff 契约）。

依赖 `@gotgenes/pi-subagents` 提供的 service（`getSubagentsService()` 暴露 SubagentManager，不重写 spawn），在其之上叠 role 层。

与 `pi-agent-guard` 的区别：
- **pi-agent-guard** = 通用行为质量（doom_loop/日志/截断/敏感保护，主 agent 也受益）
- **pi-roles** = role 定义 + spawn_role + role 专属控制面（契约/失败/深度只对 spawn 有意义）

## 待实现项

### multi-roles 前置 P0（必做，不改 pi 核心）
- **P0-1 步数硬限**：spawn 层计数，超 maxTurns abort。~50 行。
- **P0-2 子代理活性检测**：start_time / 超时 abort。含在 P0-1。
- **P0-3 输出契约 report 工具**：JSON schema 校验，子代理必调。~150 行。
- **P0-4 失败确定性传递**：report success/error 两态，结构化错误对象。~30 行（含在 P0-3）。
- **P0-5 嵌套深度限制**：spawn 层计深度，超限拒绝。~20 行。

### multi-roles 主体（P0 就位后）
- **spawn_role 工具**：注册工具，description 列可用 role 一句话能力。
- **role persona 注入**：`before_agent_start` 返回 systemPrompt。
- **per-role tool 白名单**：`setActiveTools` 收窄（执行型 role 不含 subagent 工具，防套娃）。
- **per-role skill 隔离**：`resources_discover` 返回 `baseSkills ∪ role.domainSkills`。

## 架构（C2: 领域 skill 只存在于 role）

```
主 agent (默认 role = orchestrator):
  skillPaths = [宽基本池]              ← 现状全部 skill, 不变
  tools     = 全套 (含 subagent)       ← 能派活
  + spawn_role 工具

PM role 派生 (spawn_role("pm", task)):
  resources_discover 返回 skillPaths:
    [宽基本池] ∪ [PM 领域 skill]
  tools = [read,bash,grep,find,ls,ask_user,web_search,fetch_content]  (不含 subagent)
```

## 关键机制依赖（pi 核心已有，不改核心）

- `resources_discover` 返回 skillPaths（per-session skill 隔离）— types.d.ts:393-403
- `setActiveTools` per-session — types.d.ts:881-885; agent-session.js:550
- `before_agent_start` 注入 systemPrompt — types.d.ts:498
- `newSession({parentSession})` — types.d.ts:252（gotgenes 已封装）
- `@gotgenes/pi-subagents` service：`getSubagentsService()` 返回 SubagentManager（spawn/spawnAndWait/resume/listAgents/abort/abortAll/waitForAll）

## @gotgenes 依赖评估

- **multi-roles 阶段**：gotgenes 是助力——开放 service API 让 pi-roles 专注 role 层不重写 spawn。parentSession 正常设置，`isSubagentSession` 检测不破。
- **team 阶段**：gotgenes 无子↔子通信（steer 只父→子单向）。mailbox 在本包的聊天室 ext 自建，gotgenes 继续管 spawn 跟踪。
- **长期风险**：依赖 gotgenes service API 稳定性。缓解：pi-roles 调 service 时做薄 adapter 层。

## 不做（取向差异 / 归 guard / 归 team）

- **PreToolUse 阻断**：取向差异，归"不做"（见 pi-agent-guard README）。
- **doom_loop / 持续日志 / 截断落盘 / 敏感保护**：归 pi-agent-guard（主 agent 也受益）。
- **agent team (mailbox + shared task list)**：远期，聊天室 ext 形态，见 team-outlook 文档。预留接口（spawn_role 留 `teammates` 字段、result 留 `message_to` 字段）。

## 远期演进

- **team 阶段**：本包升级成 team 编排，聊天室 mailbox 叠在 spawn_role 之上。teammate = spawn_role 的延伸。
- **预留接口**（零成本，待 team 阶段启用）：spawn_role 留 `teammates` 字段、result 留 `message_to` 字段。

## 关联文档

- pi-roles 设计（含待补地基 §十三）：`/home/qliy/project27-pi/2026-06-19-pi-roles-design.md`
- team 展望（聊天室 ext 形态）：`/home/qliy/project27-pi/2026-06-19-pi-roles-team-outlook.md`
- multi-roles 差距分析：`/home/qliy/project27-pi/2026-06-19-advanced-agent-gap-analysis.md`

## License

MIT
