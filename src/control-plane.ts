export function shouldAbortForStep(step: number, maxTurns: number): boolean {
  return step >= maxTurns;
}
export function isLivenessTimeout(startedAtMs: number, timeoutMs: number, nowMs: number = Date.now()): boolean {
  return (nowMs - startedAtMs) > timeoutMs;
}
export function nextDepth(parentDepth: number): number {
  return parentDepth + 1;
}
export function isDepthExceeded(depth: number, maxDepth: number): boolean {
  return depth > maxDepth;
}
