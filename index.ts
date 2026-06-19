// pi-roles — Multi-roles for pi agent.
// Status: scaffolded. Implementation pending design confirmation.
// See README.md for the P0 roadmap and architecture.
//
// Key pi APIs (verified against pi 0.79.8 dist, do not change pi core):
//   - pi.on("resources_discover", (event) => ({ skillPaths?: string[] }))  // types.d.ts:393
//   - pi.on("before_agent_start", (event) => ({ systemPrompt?, ... }))      // types.d.ts:498
//   - ctx.setActiveTools(toolNames) / ctx.getActiveTools()                  // types.d.ts:881
//   - ctx.newSession({ parentSession })                                     // types.d.ts:252
//
// @gotgenes/pi-subagents service (consumed via Symbol.for):
//   const { getSubagentsService } = await import("@gotgenes/pi-subagents");
//   const service = getSubagentsService();  // SubagentManager: spawn/spawnAndWait/resume/listAgents/abort/abortAll/waitForAll
//
// Intentionally minimal entry for now. spawn_role tool + handlers added per README roadmap.

export default function (_pi: any): void {
  // TODO: implement per README roadmap.
  // P0-1/2: step limit + liveness (spawn-layer counter + abort)
  // P0-3/4: output contract report tool (JSON schema validation, success/error two-state)
  // P0-5: nesting depth limit
  // then: spawn_role tool, role persona injection, per-role tool whitelist, per-role skill isolation
  // team upgrade path (reserved): spawn_role `teammates` field, result `message_to` field
}
