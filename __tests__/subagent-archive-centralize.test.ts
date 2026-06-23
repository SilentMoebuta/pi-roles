// TDD for centralized child-session archive (UI trace replay data source).
// Child sessions must move to a dedicated sessions-archive dir (not .archived.* siblings).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultArchiveSession } from "../src/subagent/service";

describe("defaultArchiveSession — centralized child-session trace archive", () => {
  let tmpRoot: string;
  let liveDir: string;

  beforeEach(() => {
    // Mirror pi's layout: <sessions>/<encoded-cwd>/<session>.jsonl
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-archive-test-"));
    const encodedCwd = "--home-test-project--";
    liveDir = path.join(tmpRoot, "sessions", encodedCwd);
    fs.mkdirSync(liveDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  it("moves child session to ../sessions-archive/<encoded-cwd>/ (centralized, not sibling)", () => {
    const childFile = path.join(liveDir, "2026-06-23T06-14-44-518Z_abc.jsonl");
    fs.writeFileSync(childFile, '{"type":"session"}\n');
    defaultArchiveSession(childFile);

    // Original no longer in live dir
    assert.ok(!fs.existsSync(childFile), "child removed from live session dir");
    // Moved to centralized archive, mirroring the encoded-cwd subdir
    const archiveDir = path.join(tmpRoot, "sessions", "sessions-archive", "--home-test-project--");
    const dest = path.join(archiveDir, "2026-06-23T06-14-44-518Z_abc.jsonl");
    assert.ok(fs.existsSync(dest), "child moved to centralized sessions-archive dir");
    assert.equal(fs.readFileSync(dest, "utf8"), '{"type":"session"}\n', "content preserved");
  });

  it("preserves parent→child linkage via filename (basename unchanged)", () => {
    const childFile = path.join(liveDir, "2026-06-23T06-14-44-518Z_child-id.jsonl");
    fs.writeFileSync(childFile, "trace");
    defaultArchiveSession(childFile);
    // The sessionId in the filename is intact → can be correlated to parentSession
    const archiveDir = path.join(tmpRoot, "sessions", "sessions-archive", "--home-test-project--");
    const moved = fs.readdirSync(archiveDir);
    assert.equal(moved.length, 1);
    assert.match(moved[0], /child-id\.jsonl$/, "basename (with sessionId) preserved for linkage");
  });

  it("creates archive dir if it doesn't exist (idempotent mkdir)", () => {
    const childFile = path.join(liveDir, "x.jsonl");
    fs.writeFileSync(childFile, "t");
    // Archive dir does not pre-exist
    const archiveDir = path.join(tmpRoot, "sessions", "sessions-archive", "--home-test-project--");
    assert.ok(!fs.existsSync(archiveDir));
    defaultArchiveSession(childFile);
    assert.ok(fs.existsSync(archiveDir), "archive dir auto-created");
  });

  it("does not leave .archived.<ts> sibling in the live dir (the old behavior)", () => {
    const childFile = path.join(liveDir, "y.jsonl");
    fs.writeFileSync(childFile, "t");
    defaultArchiveSession(childFile);
    const remaining = fs.readdirSync(liveDir);
    assert.equal(remaining.length, 0, "live dir should be empty — no .archived.* sibling left behind");
  });

  it("handles concurrent archivals of multiple children to the same archive dir", () => {
    for (const name of ["a.jsonl", "b.jsonl", "c.jsonl"]) {
      const f = path.join(liveDir, name);
      fs.writeFileSync(f, "trace-" + name);
      defaultArchiveSession(f);
    }
    const archiveDir = path.join(tmpRoot, "sessions", "sessions-archive", "--home-test-project--");
    const moved = fs.readdirSync(archiveDir).sort();
    assert.deepEqual(moved, ["a.jsonl", "b.jsonl", "c.jsonl"], "all children archived to one dir");
  });

  it("does not throw when source file is already gone (best-effort, run not broken)", () => {
    const ghost = path.join(liveDir, "ghost.jsonl");
    // Source doesn't exist — archive must not crash the run
    assert.doesNotThrow(() => defaultArchiveSession(ghost));
  });
});
