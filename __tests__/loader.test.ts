import { describe, it } from "node:test";
import assert from "node:assert/strict";
import piRolesDefault from "../index";

// Verifies the pi-roles extension loads (ESM) and registers its tools.
// The extension now uses a self-written execution layer (src/subagent/) — it no
// longer imports @gotgenes/pi-subagents (removed per criterion 5/A). This test
// confirms the default export loads and both tools register without gotgenes.

function mockPi() {
  const registered: any[] = [];
  const handlers = new Map<string, Function>();
  return {
    api: {
      registerTool: (t: any) => registered.push(t),
      on: (ev: string, h: Function) => { handlers.set(ev, h); },
    } as any,
    registered,
    handlers,
  };
}

describe("pi-roles loader", () => {
  it("default() loads without throwing and registers report_role_result + spawn_role", async () => {
    const { api, registered } = mockPi();
    await assert.doesNotReject(async () => piRolesDefault(api));
    assert.ok(registered.length >= 2, "both tools registered");
    const names = registered.map((t) => t.name);
    assert.ok(names.includes("report_role_result"), "report_role_result registered");
    assert.ok(names.includes("spawn_role"), "spawn_role registered");
  });

  it("does not import @gotgenes/pi-subagents (self-written execution layer replaces it)", async () => {
    // The extension source must not depend on gotgenes at runtime. Assert the
    // index module does not pull in the gotgenes package as a side effect.
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
    assert.ok(!src.includes('import("@gotgenes/pi-subagents")'), "index.ts must not dynamic-import gotgenes");
    assert.ok(!/from\s+"@gotgenes\/pi-subagents"/.test(src), "index.ts must not static-import gotgenes");
  });
});
