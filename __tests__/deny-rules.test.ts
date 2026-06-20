import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { globMatch, extractCommand, createDenyRulesExtension } from "../src/subagent/deny-rules";

describe("globMatch", () => {
  it("matches wildcard", () => {
    assert.ok(globMatch("rm *", "rm -rf /tmp"));
    assert.ok(globMatch("git push *", "git push origin main"));
  });
  it("does not match non-matching", () => {
    assert.ok(!globMatch("rm *", "npm test"));
  });
  it("matches env pattern", () => {
    assert.ok(globMatch("*.env", ".env"));
    assert.ok(globMatch("*.env", "prod.env"));
    assert.ok(!globMatch("*.env", "config.json"));
  });
  it("matches exact", () => {
    assert.ok(globMatch("git push", "git push"));
    assert.ok(!globMatch("git push", "git push origin main"));
  });
  it("escapes regex chars", () => {
    assert.ok(globMatch("git+push", "git+push"));
    assert.ok(!globMatch("git+push", "gitXpush"));
  });
});

describe("extractCommand", () => {
  it("extracts bash command", () => {
    assert.strictEqual(extractCommand("bash", { command: "ls -la" }), "ls -la");
  });
  it("extracts write path", () => {
    assert.strictEqual(extractCommand("write", { path: "/foo/.env" }), "/foo/.env");
  });
  it("extracts read file_path", () => {
    assert.strictEqual(extractCommand("read", { file_path: "/bar/config.ts" }), "/bar/config.ts");
  });
  it("falls back to JSON", () => {
    const r = extractCommand("custom", { foo: "bar" });
    assert.ok(r.includes("foo"));
  });
});

describe("createDenyRulesExtension", () => {
  it("creates handlers", () => {
    const ext = createDenyRulesExtension({ bash: ["rm *"] });
    assert.ok(ext.handlers.has("tool_call"));
    assert.ok(ext.handlers.has("tool_result"));
    assert.strictEqual(ext.handlers.get("tool_call")!.length, 1);
  });
  it("blocks matching bash", async () => {
    const ext = createDenyRulesExtension({ bash: ["rm *"] });
    const h = ext.handlers.get("tool_call")![0];
    const r = await h({ toolName: "bash", input: { command: "rm -rf /tmp/foo" } }, {} as any);
    assert.ok(r?.block);
    assert.match(r.reason, /Denied by role policy/);
  });
  it("allows non-matching", async () => {
    const ext = createDenyRulesExtension({ bash: ["rm *"] });
    const h = ext.handlers.get("tool_call")![0];
    const r = await h({ toolName: "bash", input: { command: "npm test" } }, {} as any);
    assert.strictEqual(r, undefined);
  });
  it("blocks env writes", async () => {
    const ext = createDenyRulesExtension({ write: ["*.env"] });
    const h = ext.handlers.get("tool_call")![0];
    const b = await h({ toolName: "write", input: { path: "/app/prod.env" } }, {} as any);
    assert.ok(b?.block);
    const a = await h({ toolName: "write", input: { path: "/app/config.json" } }, {} as any);
    assert.strictEqual(a, undefined);
  });
  it("no rules for tool allows all", async () => {
    const ext = createDenyRulesExtension({ bash: ["rm *"] });
    const h = ext.handlers.get("tool_call")![0];
    const r = await h({ toolName: "read", input: { file_path: "/etc/hosts" } }, {} as any);
    assert.strictEqual(r, undefined);
  });
  it("tool_result returns undefined", async () => {
    const ext = createDenyRulesExtension({ bash: ["rm *"] });
    const h = ext.handlers.get("tool_result")![0];
    const r = await h({ toolName: "bash", input: {}, isError: false }, {} as any);
    assert.strictEqual(r, undefined);
  });
  it("empty rules allow all", async () => {
    const ext = createDenyRulesExtension({});
    const h = ext.handlers.get("tool_call")![0];
    const r = await h({ toolName: "bash", input: { command: "ls" } }, {} as any);
    assert.strictEqual(r, undefined);
  });
  it("multiple patterns", async () => {
    const ext = createDenyRulesExtension({ bash: ["rm *", "git push *"] });
    const h = ext.handlers.get("tool_call")![0];
    assert.ok((await h({ toolName: "bash", input: { command: "rm -rf /tmp" } }, {} as any))?.block);
    assert.ok((await h({ toolName: "bash", input: { command: "git push origin main" } }, {} as any))?.block);
    assert.strictEqual(await h({ toolName: "bash", input: { command: "npm run build" } }, {} as any), undefined);
  });
});

describe("deny-rules — KNOWN BYPASS (T3-6, documented limitation)", () => {
  // ponytail: deny-rules do raw-string glob matching on input.command.
  // A `rm *` deny rule does NOT match a shell wrapper like `bash -c 'rm -rf /'`
  // because the command doesn't start with 'rm'. OpenCode normalizes bash via
  // tree-sitter; pi-roles does not (no shipped role uses deny-rules today —
  // Tier 4 inert). A partial normalizer (strip bash -c / quotes) would create
  // FALSE CONFIDENCE: nested wrappers (`env bash -c`, `sh -c 'bash -c ...'`,
  // eval) still evade. So we DOCUMENT the bypass + lock it in here rather than
  // ship a normalizer that operators might trust. Real fix = tree-sitter bash
  // parsing (OpenCode pattern), gated on a role actually opting into deny-rules.
  it("a `rm *` deny rule does NOT match `bash -c 'rm -rf /'` (shell-wrapper bypass — documented)", () => {
    assert.ok(!globMatch("rm *", "bash -c 'rm -rf /'"),
      "KNOWN BYPASS — deny-rules do raw-string matching; shell wrappers evade. " +
      "Documented limitation, see ponytail comment in deny-rules.ts + this test.");
  });
});
