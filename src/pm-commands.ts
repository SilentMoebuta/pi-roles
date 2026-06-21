// pm-commands — pi-native PM slash commands that reproduce phuryn/pm-skills'
// 42-command workflow as pi.registerCommand handlers. Each handler injects a
// steer message instructing the main agent to dispatch a pm role subagent via
// spawn_role with the appropriate skill.
//
// Option A' (approver-corrected): single-skill commands dispatch one
// spawn_role; multi-skill sequencers instruct the main agent to run N
// sequential spawn_role calls with user checkpoints between each (pi subagents
// are non-interactive, so the PARENT session orchestrates the flow).
//
// Data-driven: a single PM_COMMANDS table + one registerPmCommands function.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface PmCommand {
  /** Slash command name (e.g. "pm-write-prd"). */
  name: string;
  /** One-line description for the command registry. */
  description: string;
  /** Domain dir under roles/pm-skills/ (e.g. "execution", "product-strategy"). */
  domain: string;
  /** Skill name(s) to load — 1 for single-skill, N for multi-skill sequencers. */
  skills: string[];
  /** Whether this is a multi-step sequencer (option A' parent-orchestrated). */
  sequencer?: boolean;
}

// All ~40 PM commands. Single-skill = spawn_role(pm, "read skill X, do Y").
// Multi-skill sequencers instruct N sequential spawn_role with checkpoints.
export const PM_COMMANDS: PmCommand[] = [
  // --- Execution ---
  { name: "pm-write-prd", description: "Write a Product Requirements Document from a feature idea or problem statement.", domain: "execution", skills: ["create-prd"] },
  { name: "pm-user-stories", description: "Write user stories with acceptance criteria from a PRD or feature spec.", domain: "execution", skills: ["user-stories"] },
  { name: "pm-job-stories", description: "Write job stories (When... I want to... So that...) from user research.", domain: "execution", skills: ["job-stories"] },
  { name: "pm-test-scenarios", description: "Generate test scenarios and edge cases from a PRD or feature spec.", domain: "execution", skills: ["test-scenarios"] },
  { name: "pm-roadmap", description: "Build an outcome-based roadmap with themes and time horizons.", domain: "execution", skills: ["outcome-roadmap"] },
  { name: "pm-okrs", description: "Brainstorm OKRs (Objectives and Key Results) from a product goal.", domain: "execution", skills: ["brainstorm-okrs"] },
  { name: "pm-prioritize", description: "Prioritize features using ICE/RICE/Opportunity Score frameworks.", domain: "execution", skills: ["prioritization-frameworks"] },
  { name: "pm-pre-mortem", description: "Run a pre-mortem: imagine the project failed, find why, mitigate.", domain: "execution", skills: ["pre-mortem"] },
  { name: "pm-red-team", description: "Red-team a PRD or strategy by steelmanning then attacking its assumptions.", domain: "execution", skills: ["strategy-red-team"] },
  { name: "pm-stakeholder", description: "Map stakeholders: their interests, influence, and communication needs.", domain: "execution", skills: ["stakeholder-map"] },
  { name: "pm-sprint", description: "Plan a sprint from a backlog or roadmap with capacity estimates.", domain: "execution", skills: ["sprint-plan"] },
  { name: "pm-retro", description: "Run a retrospective: what went well, what didn't, what to change.", domain: "execution", skills: ["retro"] },
  { name: "pm-release-notes", description: "Write release notes from git history or a feature list.", domain: "execution", skills: ["release-notes"] },
  { name: "pm-summarize-meeting", description: "Summarize a meeting with decisions, action items, and owners.", domain: "execution", skills: ["summarize-meeting"] },
  // --- Product Discovery ---
  { name: "pm-ost", description: "Build an Opportunity Solution Tree mapping outcomes to opportunities to solutions to experiments.", domain: "product-discovery", skills: ["opportunity-solution-tree"] },
  { name: "pm-interview", description: "Create a user interview script with research goals and open-ended questions.", domain: "product-discovery", skills: ["interview-script"] },
  { name: "pm-feature-analysis", description: "Analyze feature requests against user needs and business goals.", domain: "product-discovery", skills: ["analyze-feature-requests"] },
  { name: "pm-metrics-dashboard", description: "Design a product metrics dashboard with key metrics and data sources.", domain: "product-discovery", skills: ["metrics-dashboard"] },
  // multi-skill sequencer: the flagship discovery flow
  { name: "pm-discover", description: "Full discovery flow: OST → identify assumptions → prioritize → brainstorm experiments.", domain: "product-discovery", skills: ["opportunity-solution-tree", "identify-assumptions-existing", "prioritize-assumptions", "brainstorm-experiments-existing"], sequencer: true },
  // --- Product Strategy ---
  { name: "pm-strategy", description: "Build a product strategy using the 9-section Product Strategy Canvas.", domain: "product-strategy", skills: ["product-strategy"] },
  { name: "pm-vision", description: "Craft a product vision statement that aligns stakeholders.", domain: "product-strategy", skills: ["product-vision"] },
  { name: "pm-swot", description: "Perform a SWOT analysis with actionable recommendations.", domain: "product-strategy", skills: ["swot-analysis"] },
  { name: "pm-porters", description: "Analyze competitive forces using Porter's Five Forces.", domain: "product-strategy", skills: ["porters-five-forces"] },
  { name: "pm-lean-canvas", description: "Fill a Lean Canvas (problem, solution, metrics, UVP, unfair advantage).", domain: "product-strategy", skills: ["lean-canvas"] },
  { name: "pm-bmc", description: "Map a Business Model Canvas (9 blocks: segments, value props, channels, etc.).", domain: "product-strategy", skills: ["business-model"] },
  { name: "pm-value-prop", description: "Design a Value Proposition using the Strategyzer canvas.", domain: "product-strategy", skills: ["value-proposition"] },
  { name: "pm-pricing", description: "Develop a pricing strategy from value, cost, and competitive analysis.", domain: "product-strategy", skills: ["pricing-strategy"] },
  { name: "pm-monetization", description: "Identify monetization models and revenue streams.", domain: "product-strategy", skills: ["monetization-strategy"] },
  { name: "pm-ansoff", description: "Analyze growth direction using the Ansoff Matrix.", domain: "product-strategy", skills: ["ansoff-matrix"] },
  { name: "pm-pestle", description: "Assess macro-environmental factors (Political, Economic, Social, Tech, Legal, Environmental).", domain: "product-strategy", skills: ["pestle-analysis"] },
  { name: "pm-startup-canvas", description: "Fill a startup canvas (problem, customer, solution, UVP, channels, cost, revenue).", domain: "product-strategy", skills: ["startup-canvas"] },
  // --- Market Research ---
  { name: "pm-competitor", description: "Analyze competitors: strengths, weaknesses, positioning, strategy.", domain: "market-research", skills: ["competitor-analysis"] },
  { name: "pm-market-size", description: "Estimate market size (TAM/SAM/SOM) with top-down and bottom-up approaches.", domain: "market-research", skills: ["market-sizing"] },
  { name: "pm-personas", description: "Create user personas from research data with goals, frustrations, and JTBD.", domain: "market-research", skills: ["user-personas"] },
  { name: "pm-market-segments", description: "Segment a market by demographics, behavior, or needs.", domain: "market-research", skills: ["market-segments"] },
  { name: "pm-customer-journey", description: "Map the customer journey across touchpoints with emotions and pain points.", domain: "market-research", skills: ["customer-journey-map"] },
  { name: "pm-sentiment", description: "Analyze sentiment from user feedback, reviews, or social data.", domain: "market-research", skills: ["sentiment-analysis"] },
  { name: "pm-segmentation", description: "Segment users by behavior, JTBD, and needs from feedback data.", domain: "market-research", skills: ["user-segmentation"] },
  // --- Go-to-Market ---
  { name: "pm-gtm", description: "Build a go-to-market strategy: target, positioning, channels, timeline.", domain: "go-to-market", skills: ["gtm-strategy"] },
  { name: "pm-icp", description: "Define the Ideal Customer Profile from demographics, behaviors, and JTBD.", domain: "go-to-market", skills: ["ideal-customer-profile"] },
  { name: "pm-battlecard", description: "Create a competitive battlecard for sales: positioning vs. each competitor.", domain: "go-to-market", skills: ["competitive-battlecard"] },
  { name: "pm-growth-loops", description: "Identify and design growth loops (referral, content, product-led).", domain: "go-to-market", skills: ["growth-loops"] },
  // --- Marketing & Growth ---
  { name: "pm-north-star", description: "Define a North Star Metric and input metrics constellation.", domain: "marketing-growth", skills: ["north-star-metric"] },
  { name: "pm-positioning", description: "Brainstorm positioning ideas aligned to market context and differentiation.", domain: "marketing-growth", skills: ["positioning-ideas"] },
  { name: "pm-product-name", description: "Brainstorm product names with rationale aligned to brand values.", domain: "marketing-growth", skills: ["product-name"] },
  { name: "pm-value-props", description: "Write value proposition statements for different audiences.", domain: "marketing-growth", skills: ["value-prop-statements"] },
  // --- Data Analytics ---
  { name: "pm-ab-test", description: "Analyze A/B test results: significance, effect size, sample size, recommendations.", domain: "data-analytics", skills: ["ab-test-analysis"] },
  { name: "pm-cohort", description: "Perform cohort analysis: retention curves, feature adoption, segment insights.", domain: "data-analytics", skills: ["cohort-analysis"] },
];

/** Build the task string for a spawn_role(pm, ...) call. */
function buildTask(cmd: PmCommand, userArgs: string): string {
  if (cmd.sequencer) {
    // Option A': instruct the main agent to run N sequential spawn_role calls
    // with user checkpoints between each step.
    const steps = cmd.skills.map((s, i) =>
      `Step ${i + 1}: spawn_role(pm, "Read roles/pm-skills/${cmd.domain}/${s}/SKILL.md and apply its framework to: ${userArgs}. Report via report_role_result.")`
    ).join("\n");
    return `Run this multi-step PM workflow using spawn_role. For each step:\n1. Dispatch the spawn_role call described below.\n2. Wait for the pm subagent to report its result.\n3. Present the result to the user.\n4. Ask the user if they want to proceed to the next step before continuing.\n\n${steps}`;
  }
  // Single-skill: one spawn_role call.
  const skill = cmd.skills[0];
  return `Use spawn_role to dispatch a pm role subagent with this task: "Read roles/pm-skills/${cmd.domain}/${skill}/SKILL.md and apply its framework to: ${userArgs}. Report your findings via report_role_result." Wait for the result and present it to the user.`;
}

/** Register all PM commands with the pi extension API.
 *  Defensive: guards against missing registerCommand/sendMessage (e.g. test mocks). */
export function registerPmCommands(pi: ExtensionAPI): void {
  const register = (pi as any).registerCommand;
  const sendMessage = (pi as any).sendMessage;
  if (typeof register !== "function") return; // mock pi — skip (loader test)
  for (const cmd of PM_COMMANDS) {
    register.call(pi, cmd.name, {
      description: cmd.description,
      handler: async (args: string, _ctx: any) => {
        const userArgs = (args || "").trim() || "(no input provided — ask the user what they want to analyze)";
        const task = buildTask(cmd, userArgs);
        if (typeof sendMessage === "function") {
          sendMessage.call(pi,
            {
              customType: "pi-roles:pm-command",
              content: `PM command /${cmd.name}:\n\n${task}`,
              display: true,
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        }
      },
    });
  }
}
