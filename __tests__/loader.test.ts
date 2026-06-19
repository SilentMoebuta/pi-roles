import { describe, it } from "node:test";
import assert from "node:assert/strict";
import piRolesDefault from "../index";

// Verifies the ESM loader fix: __dirname replaced by fileURLToPath(import.meta.url)
// and require() replaced by await import("@gotgenes/pi-subagents"). Under "type":
// "module" the old code threw ReferenceError (require undefined) and __dirname
// undefined; both are silently caught today, masking a total loader failure.

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

describe("pi-roles ESM loader", () => {
  it("default() loads without throwing and registers report_role_result", async () => {
    const { api, registered } = mockPi();
    await assert.doesNotReject(async () => piRolesDefault(api));
    assert.ok(registered.length >= 1, "at least one tool registered");
    assert.equal(registered[0].name, "report_role_result");
  });

  it("@gotgenes/pi-subagents resolves and exports getSubagentsService (loader path works)", async () => {
    // If this throws, the ESM-correct dynamic import the extension now uses would
    // fail in production too (it is wrapped in try/catch there, but a failure
    // means spawn_role can never find the service).
    const mod: any = await import("@gotgenes/pi-subagents");
    assert.equal(typeof mod.getSubagentsService, "function");
  });
});
