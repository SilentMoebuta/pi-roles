export const SPAWN_PROVENANCE_TYPE = "pi-roles:spawn-provenance";

export interface SpawnProvenance {
  schemaVersion: 1;
  agentId: string;
  role: string;
  sessionId: string;
  parentSession: string | null;
}

interface ProvenanceSessionManager {
  appendCustomEntry?: (customType: string, data: unknown) => unknown;
}

/** Persist trusted spawn metadata in the child session before its first turn. */
export function appendSpawnProvenance(
  sessionManager: ProvenanceSessionManager,
  provenance: Omit<SpawnProvenance, "schemaVersion">,
): boolean {
  if (typeof sessionManager.appendCustomEntry !== "function") return false;
  sessionManager.appendCustomEntry(SPAWN_PROVENANCE_TYPE, {
    schemaVersion: 1,
    ...provenance,
  } satisfies SpawnProvenance);
  return true;
}
