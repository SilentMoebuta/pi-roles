import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RoleDef } from "./roles";

export interface RoleCatalogItem {
  name: string;
  description: string;
  tools: string[];
  skills: string[];
}

/** Stable, read-only projection used by routing and the list_roles tool. */
export function listRoleCatalog(registry: Map<string, RoleDef>): RoleCatalogItem[] {
  return [...registry.values()]
    .map((role) => ({
      name: role.name,
      description: role.description,
      tools: [...role.tools],
      skills: [...role.skills],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function makeListRolesTool(registry: Map<string, RoleDef>) {
  return defineTool({
    name: "list_roles",
    label: "List Roles",
    description: "List registered pi-roles with their descriptions, tool allowlists, and skills. Read-only.",
    parameters: Type.Object({}),
    async execute() {
      const roles = listRoleCatalog(registry);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ roles }) }],
        details: { roles },
      };
    },
  });
}
