// PM SDO batch-fix: rewrites all pm-skills descriptions to trigger-only + adds
// source citations. Run once: npx tsx scripts/pm-sdo-fix.ts
//
// Three patterns:
// 1. Strategy domain (11/12): old pattern — lean frontmatter description (workflow
//    summary) + ## Metadata block with Triggers: field. Fix: move Triggers into
//    frontmatter description (replacing the summary), delete ## Metadata block.
// 2. Marketing-growth (5/5): hybrid — triggers in BOTH frontmatter + body.
//    Fix: remove the body Triggers: line (already in frontmatter).
// 3. Other 5 domains (43): already SDO-compliant. Fix: just add source citation.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "roles", "pm-skills");

// Framework sources per domain (from the researcher's deep-dive).
const SOURCES: Record<string, string> = {
  "product-discovery": "Teresa Torres (Continuous Discovery Habits), Dan Olsen (The Lean Product Playbook), Alberto Savoia (pretotypes), Rob Fitzpatrick (The Mom Test)",
  "execution": "Marty Cagan (Inspired), Christina Wodtke (Radical Focus/OKRs), Anthony Ulwick (JTBD)",
  "product-strategy": "Roger Martin (Playing to Win), Michael Porter (Competitive Strategy), Ash Maurya (Running Lean), Strategyzer/Osterwalder (BMC, Value Proposition Design)",
  "market-research": "Rob Fitzpatrick (The Mom Test), Steve Portigal (Interviewing Users)",
  "go-to-market": "Maja Voje (GTM), Geoffrey Moore (Crossing the Chasm)",
  "marketing-growth": "Sean Ellis (North Star Framework), April Dunford (Obviously Awesome)",
  "data-analytics": "Alistair Croll & Benjamin Yoskovitz (Lean Analytics)",
};

function fixSkill(file: string): { changed: boolean; reason: string } {
  let content = fs.readFileSync(file, "utf8");
  const original = content;
  const domain = file.split(path.sep).slice(-3, -2)[0];
  const skillName = path.basename(path.dirname(file));

  // Parse frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return { changed: false, reason: "no frontmatter" };
  const fmBlock = fmMatch[1];
  const afterFm = content.slice(fmMatch[0].length);

  // Extract current description
  const descMatch = fmBlock.match(/^description:\s*(.+?)$/m);
  let desc = descMatch ? descMatch[1].replace(/^["']|["']$/g, "") : "";

  // Pattern 1: strategy — has ## Metadata with Triggers: in body
  const metaMatch = afterFm.match(/## Metadata\s*\n([\s\S]*?)(?=\n## |\n$|$)/);
  if (metaMatch) {
    const triggersMatch = metaMatch[1].match(/Triggers?:\s*(.+)/);
    if (triggersMatch) {
      const triggers = triggersMatch[1].trim();
      // If the frontmatter description doesn't start with "Use when", replace it
      // with the triggers (which do start with "Use when" or are trigger phrases).
      if (!/Use when/i.test(desc) && triggers) {
        desc = triggers;
      } else if (triggers && !desc.includes(triggers.slice(0, 30))) {
        // Append triggers if not already in description
        desc = desc + " " + triggers;
      }
    }
    // Delete the ## Metadata block
    content = content.replace(/## Metadata\s*\n[\s\S]*?(?=\n## |\n$|$)/, "");
    // Clean up any leftover blank lines
    content = content.replace(/\n{3,}/g, "\n\n");
  }

  // Pattern 2: marketing-growth — remove body Triggers: line
  if (domain === "marketing-growth") {
    content = content.replace(/\nTriggers?:\s*.+/g, "");
  }

  // Update frontmatter description (ensure trigger-only: trim workflow summaries
  // that appear before "Use when" if both exist)
  if (/Use when/i.test(desc)) {
    // Keep only from "Use when" onward if there's a workflow summary before it
    const useWhenIdx = desc.search(/Use when/i);
    if (useWhenIdx > 20) {
      desc = desc.slice(useWhenIdx);
    }
  }

  // Rebuild frontmatter
  let newFm = fmBlock;
  if (descMatch) {
    newFm = newFm.replace(/^description:\s*.+$/m, `description: "${desc.replace(/"/g, '\\"')}"`);
  } else {
    newFm += `description: "${desc.replace(/"/g, '\\"')}"\n`;
  }
  content = `---\n${newFm}\n---` + content.slice(fmMatch[0].length);

  // Add source citation footer (if not already present)
  const source = SOURCES[domain];
  if (source && !content.includes("## Source")) {
    content = content.trimEnd() + `\n\n## Source\n\n${source}. Adapted from [phuryn/pm-skills](https://github.com/phuryn/pm-skills) (MIT), re-authored for pi.\n`;
  }

  if (content !== original) {
    fs.writeFileSync(file, content);
    return { changed: true, reason: metaMatch ? "strategy-metadata-rewrite" : (domain === "marketing-growth" ? "mgrowth-cleanup" : "citation-added") };
  }
  return { changed: false, reason: "no-change" };
}

// Walk all SKILL.md files
const files: string[] = [];
function walk(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(path.join(dir, entry.name));
    else if (entry.name === "SKILL.md") files.push(path.join(dir, entry.name));
  }
}
walk(ROOT);

let changed = 0;
for (const f of files) {
  const r = fixSkill(f);
  if (r.changed) { changed++; console.log(`  ${r.reason}: ${path.relative(ROOT, f)}`); }
}
console.log(`\n${changed}/${files.length} skills updated (SDO + citations).`);
