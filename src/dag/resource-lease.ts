import * as path from "node:path";

export interface NormalizedResourceUri {
  value: string;
  scheme: string;
  authority: string;
  path: string;
  recursive: boolean;
}

const SCHEME = /^[a-z][a-z0-9+.-]*$/;

export function normalizeResourceUri(raw: string): NormalizedResourceUri {
  const value = raw.trim().replace(/\\/g, "/");
  const match = value.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)(\/[^?#]*)?$/i);
  if (!match || !SCHEME.test(match[1].toLowerCase())) {
    throw new Error(`resource_scope must be an absolute resource URI (got '${raw}')`);
  }
  if (value.includes("?") || value.includes("#") || match[2].includes("@")) {
    throw new Error(`resource_scope cannot contain credentials, query, or fragment (got '${raw}')`);
  }
  const scheme = match[1].toLowerCase();
  const authority = match[2].toLowerCase();
  const rawPath = match[3] ?? "";
  const recursive = rawPath.endsWith("/**");
  const literal = recursive ? rawPath.slice(0, -3) : rawPath;
  if (/[*?\[\]{}]/.test(literal)) {
    throw new Error(`resource_scope only supports literal paths or a terminal '/**' (got '${raw}')`);
  }
  if (literal.split("/").includes("..")) {
    throw new Error(`resource_scope escapes its authority root (got '${raw}')`);
  }
  const normalizedPath = literal
    ? path.posix.normalize(literal).replace(/\/$/, "")
    : "";
  if (normalizedPath === "/.." || normalizedPath.startsWith("/../")) {
    throw new Error(`resource_scope escapes its authority root (got '${raw}')`);
  }
  const canonicalPath = normalizedPath === "/" ? "" : normalizedPath;
  return {
    value: `${scheme}://${authority}${canonicalPath}${recursive ? "/**" : ""}`,
    scheme,
    authority,
    path: canonicalPath,
    recursive,
  };
}

export function resourcesOverlap(leftRaw: string, rightRaw: string): boolean {
  const left = normalizeResourceUri(leftRaw);
  const right = normalizeResourceUri(rightRaw);
  if (left.scheme !== right.scheme || left.authority !== right.authority) return false;
  if (left.path === right.path) return true;
  if (left.recursive && isDescendant(right.path, left.path)) return true;
  if (right.recursive && isDescendant(left.path, right.path)) return true;
  return false;
}

/** One executor owns the lease table; external adapters can persist the resource URIs. */
export class ResourceLeases {
  private readonly held = new Map<string, string[]>();

  canAcquire(resources: string[]): boolean {
    const normalized = resources.map((resource) => normalizeResourceUri(resource).value);
    return [...this.held.values()].every((held) =>
      normalized.every((resource) => held.every((other) => !resourcesOverlap(resource, other))),
    );
  }

  acquire(owner: string, resources: string[]): boolean {
    const normalized = resources.map((resource) => normalizeResourceUri(resource).value);
    if (!this.canAcquire(normalized)) return false;
    this.held.set(owner, normalized);
    return true;
  }

  release(owner: string): void {
    this.held.delete(owner);
  }

  snapshot(): Record<string, string[]> {
    return Object.fromEntries([...this.held].map(([owner, resources]) => [owner, [...resources]]));
  }
}

function isDescendant(candidate: string, parent: string): boolean {
  if (!parent) return candidate.startsWith("/");
  return candidate.startsWith(parent + "/");
}
