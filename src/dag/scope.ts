import * as path from "node:path";

const UNSUPPORTED_GLOB = /[*?[\]{}]/;
const EXTGLOB_SEGMENT = /[!+@]\([^/]*\)/;

/**
 * Normalize a write scope without resolving it outside the repository.
 *
 * Plain paths retain the legacy recursive-prefix behavior. `dir/**` is the
 * explicit spelling of the same recursive scope and canonicalizes to `dir`.
 */
export function normalizeWriteScope(raw: string): string {
  const value = raw.trim().replace(/\\/g, "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new Error(`write_scope must be a non-empty repo-relative path (got '${raw}')`);
  }
  const recursive = value.endsWith("/**");
  const literal = recursive ? value.slice(0, -3) : value;
  if (UNSUPPORTED_GLOB.test(literal) || EXTGLOB_SEGMENT.test(literal)) {
    throw new Error(`write_scope only supports literal paths or a terminal '/**' (got '${raw}')`);
  }
  const pathNormalized = path.posix.normalize(literal);
  const normalized = pathNormalized === "." || pathNormalized === "./"
    ? "."
    : pathNormalized.replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`write_scope escapes the repository root (got '${raw}')`);
  }
  return normalized;
}

export function scopesOverlap(a: string, b: string): boolean {
  const left = normalizeWriteScope(a);
  const right = normalizeWriteScope(b);
  return left === "." || right === "." || left === right || left.startsWith(right + "/") || right.startsWith(left + "/");
}

/** In-process leases are sufficient because one executor owns all running DAG nodes. */
export class WriteScopeLeases {
  private readonly held = new Map<string, string[]>();

  canAcquire(scopes: string[]): boolean {
    const normalized = scopes.map(normalizeWriteScope);
    return [...this.held.values()].every((held) =>
      normalized.every((scope) => held.every((other) => !scopesOverlap(scope, other))),
    );
  }

  acquire(owner: string, scopes: string[]): boolean {
    const normalized = scopes.map(normalizeWriteScope);
    if (!this.canAcquire(normalized)) return false;
    this.held.set(owner, normalized);
    return true;
  }

  release(owner: string): void {
    this.held.delete(owner);
  }
}
