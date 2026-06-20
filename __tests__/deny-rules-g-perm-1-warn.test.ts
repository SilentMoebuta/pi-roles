// G-PERM-1: deny-rules advertise a security mechanism (P1-1) but bash patterns
// are bypassable via shell wrappers (`bash -c 'rm -rf /'` evades `rm *`), and no
// shipped role uses deny-rules today (Tier 4 inert). A user opting in gets SILENT
// FALSE PROTECTION. Approver decision (2026-06-20): WARN-ONLY (not tree-sitter-bash
// — inert feature + partial normalizer worse + zero new deps). Convert silent
// false-confidence → INFORMED false-confidence: a LOUD stderr warning at
// configuration time (spawn = when the bypass-vulnerable rules are applied)
// naming the shell-wrapper bypass.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDenyRulesExtension, bashBypassWarning } from "../src/subagent/deny-rules";

describe("deny-rules — G-PERM-1 bash-wrapper bypass loud warning (warn-only)", () => {
  it("bashBypassWarning names the shell-wrapper bypass for bash rules", () => {
    const w = bashBypassWarning({ bash: ["rm *"] });
    assert.ok(w, "warning returned for bash rules");
    assert.match(w!, /bash -c/i, "names the bash -c wrapper evading the rule");
    assert.match(w!, /rm/i, "references the rm example");
  });

  it("bashBypassWarning returns null for non-bash rules (no false alarm)", () => {
    assert.equal(bashBypassWarning({ write: ["*.env"] }), null);
    assert.equal(bashBypassWarning({}), null);
  });

  it("createDenyRulesExtension emits a LOUD stderr warning for bash rules (not silent)", () => {
    const original = console.error;
    const captured: string[] = [];
    console.error = (...args: any[]) => { captured.push(args.map(String).join(" ")); };
    try {
      createDenyRulesExtension({ bash: ["rm *", "git push *"] });
    } finally {
      console.error = original;
    }
    const w = captured.find((s) => /bash -c/i.test(s));
    assert.ok(w, "loud stderr warning emitted naming the bash -c bypass");
  });

  it("createDenyRulesExtension does NOT warn for non-bash rules", () => {
    const original = console.error;
    const captured: string[] = [];
    console.error = (...args: any[]) => { captured.push(args.map(String).join(" ")); };
    try {
      createDenyRulesExtension({ write: ["*.env"] });
    } finally {
      console.error = original;
    }
    assert.ok(!captured.some((s) => /bash -c/i.test(s)), "no bash warning for write-only rules");
  });
});
