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
