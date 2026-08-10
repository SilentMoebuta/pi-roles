export type ProfileScope = "organization" | "user" | "repository";

export const PROFILE_LAYER_VERSION = 1 as const;

export interface ProfileComponentsV1 {
  profile?: Record<string, unknown>;
  skills?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  projectPolicy?: Record<string, unknown>;
}

export interface ProfileLayerV1 {
  schemaVersion: typeof PROFILE_LAYER_VERSION;
  id: string;
  scope: ProfileScope;
  components: ProfileComponentsV1;
  /** Organization-enforced components are applied last and cannot be overridden. */
  enforced?: ProfileComponentsV1;
}

export interface ResolvedProfileV1 {
  components: ProfileComponentsV1;
  provenance: Record<string, ProfileScope | "organization_enforced">;
  layerIds: string[];
}

const PRECEDENCE: ProfileScope[] = ["organization", "user", "repository"];

export function resolveProfileLayers(layers: ProfileLayerV1[]): ResolvedProfileV1 {
  const validation = validateProfileLayers(layers);
  if (validation.length > 0) throw new Error(`invalid profile layers: ${validation.join("; ")}`);
  const components: ProfileComponentsV1 = {};
  const provenance: Record<string, ProfileScope | "organization_enforced"> = {};
  const layerIds: string[] = [];
  for (const scope of PRECEDENCE) {
    for (const layer of layers.filter((candidate) => candidate.scope === scope)) {
      merge(components as Record<string, unknown>, layer.components as Record<string, unknown>, "", provenance, scope);
      layerIds.push(layer.id);
    }
  }
  for (const layer of layers.filter((candidate) => candidate.scope === "organization" && candidate.enforced)) {
    merge(components as Record<string, unknown>, layer.enforced! as Record<string, unknown>, "", provenance, "organization_enforced");
  }
  return { components, provenance, layerIds };
}

export function validateProfileLayers(layers: ProfileLayerV1[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(layers)) return ["profile layers must be an array"];
  const ids = new Set<string>();
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") { errors.push("profile layer must be an object"); continue; }
    const id = typeof layer.id === "string" ? layer.id : "";
    if (layer.schemaVersion !== PROFILE_LAYER_VERSION) errors.push(`layer '${id}' schemaVersion must be ${PROFILE_LAYER_VERSION}`);
    if (!id.trim() || ids.has(id)) errors.push(`layer id '${id}' is empty or duplicated`);
    ids.add(id);
    if (!PRECEDENCE.includes(layer.scope)) errors.push(`layer '${layer.id}' has unknown scope '${String(layer.scope)}'`);
    if (layer.scope !== "organization" && layer.enforced) errors.push(`layer '${layer.id}' cannot enforce values outside organization scope`);
    validateComponents(id, layer.components, errors);
    if (layer.enforced) validateComponents(`${id}.enforced`, layer.enforced, errors);
  }
  return errors;
}

function merge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  prefix: string,
  provenance: ResolvedProfileV1["provenance"],
  scope: ProfileScope | "organization_enforced",
): void {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value) && isRecord(target[key])) merge(target[key] as Record<string, unknown>, value, path, provenance, scope);
    else {
      clearProvenanceBelow(provenance, path);
      target[key] = structuredClone(value);
      provenance[path] = scope;
    }
  }
}

function validateComponents(layerId: string, components: ProfileComponentsV1, errors: string[]): void {
  if (!components || typeof components !== "object" || Array.isArray(components)) { errors.push(`layer '${layerId}' components must be an object`); return; }
  const allowed = new Set(["profile", "skills", "mcp", "hooks", "projectPolicy"]);
  for (const [name, value] of Object.entries(components)) {
    if (!allowed.has(name)) errors.push(`layer '${layerId}' contains unknown component '${name}'`);
    if (!isRecord(value)) errors.push(`layer '${layerId}' component '${name}' must be an object`);
  }
}

function clearProvenanceBelow(provenance: ResolvedProfileV1["provenance"], path: string): void {
  for (const key of Object.keys(provenance)) {
    if (key === path || key.startsWith(`${path}.`)) delete provenance[key];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
