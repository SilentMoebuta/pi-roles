// PM-CORE-1: dynamic discovery of roles/*-skills/ directories.
//
// Replaces the hardcoded `["researcher-skills", "planner-skills", ...]` array
// that previously appeared in spawn-role-tool.ts + dag-execute-tool.ts. Adding
// a new role (pm, or any future role #7+) no longer requires editing those
// arrays — any `roles/<name>-skills/` dir is auto-discovered. This removes the
// recurring "hardcoded vs dynamic discovery" fault class flagged in the repo's
// own audit-memory.
//
// Both call sites pass the repo-root `roles/` dir; the helper returns the names
// of immediate `*-skills` subdirectories (names only; sites resolve full paths
// relative to their own __thisDir, preserving the existing path resolution).

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Return the names of immediate `*-skills` subdirectories under `rolesDir`.
 * Returns `[]` if `rolesDir` is missing or empty (never throws — callers wrap
 * loadSkillsFromDir in try/catch for missing dirs, but discovery itself is
 * crash-safe so a transient FS state can't break a spawn).
 */
export function discoverRoleSkillDirs(rolesDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(rolesDir);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of entries) {
    if (!name.endsWith("-skills")) continue;
    // Only directories — a stray file named `foo-skills` must not be treated
    // as a skills dir (loadSkillsFromDir would error on it).
    try {
      if (!fs.statSync(path.join(rolesDir, name)).isDirectory()) continue;
    } catch {
      continue;
    }
    dirs.push(name);
  }
  return dirs;
}
