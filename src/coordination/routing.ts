import { CoordinationError, requireText } from "./errors";
import type { RuntimeState } from "./runtime-delivery";

/** These declarations come from trusted runtime/launcher adapters, not labels or
 * model-authored advertisements. Scope already includes the profile boundary.
 * Worktree identifiers must be canonicalized by the trusted launcher. */
export interface ExecutionRoute {
  id: string;
  path: "native" | "peer";
  scope: string;
  host: string;
  worktree: string;
  capabilities: readonly string[];
  durable: boolean;
  availability: RuntimeState;
  observedAt: number;
  active: number;
  capacity: number;
  overhead: number;
  authorized: boolean;
}
export interface RouteRequirements {
  scope: string;
  worktree: string;
  host?: string;
  capabilities: readonly string[];
  durable: boolean;
}
export type RouteSelection =
  | { status: "selected"; routeId: string; path: "native" | "peer" }
  | { status: "blocked"; reasons: string[] };

/** Select only an existing execution route. This is advisory until an atomic
 * dispatch reservation revalidates capacity and ownership; it never spawns. */
export function selectExecutionRoute(
  requirement: RouteRequirements,
  routes: readonly ExecutionRoute[],
  budget: { active: number; maximum: number; observationMaxAgeMs: number },
  now = Date.now(),
): RouteSelection {
  requireText(requirement.scope, "scope");
  requireText(requirement.worktree, "worktree", 4096);
  for (const capability of requirement.capabilities)
    requireText(capability, "capability");
  if (
    !Number.isFinite(now) ||
    !Number.isSafeInteger(budget.active) ||
    budget.active < 0 ||
    !Number.isSafeInteger(budget.maximum) ||
    budget.maximum < 0 ||
    !Number.isSafeInteger(budget.observationMaxAgeMs) ||
    budget.observationMaxAgeMs < 0
  )
    throw new CoordinationError(
      "invalid_input",
      "Invalid routing budget or observation clock",
    );
  if (budget.active >= budget.maximum)
    return { status: "blocked", reasons: ["concurrency_budget"] };
  const reasons = new Set<string>();
  const eligible: ExecutionRoute[] = [];
  const ids = new Set<string>();
  for (const route of routes) {
    requireText(route.id, "routeId");
    if (ids.has(route.id))
      throw new CoordinationError("invalid_input", "Duplicate route identity");
    ids.add(route.id);
    if (
      !Number.isFinite(route.overhead) ||
      route.overhead < 0 ||
      !Number.isSafeInteger(route.active) ||
      route.active < 0 ||
      !Number.isSafeInteger(route.capacity) ||
      route.capacity < 0
    )
      throw new CoordinationError(
        "invalid_input",
        "Invalid route capacity or overhead",
      );
    if (route.scope !== requirement.scope) continue;
    const rejected: string[] = [];
    if (!route.authorized) rejected.push("unauthorized");
    if (route.worktree !== requirement.worktree) rejected.push("worktree");
    if (requirement.host && route.host !== requirement.host)
      rejected.push("host");
    if (requirement.durable && !route.durable)
      rejected.push("durable_lifetime");
    for (const capability of requirement.capabilities)
      if (!route.capabilities.includes(capability))
        rejected.push(`capability:${capability}`);
    if (
      !Number.isFinite(route.observedAt) ||
      route.observedAt > now ||
      now - route.observedAt > budget.observationMaxAgeMs
    )
      rejected.push("stale_availability");
    if (route.availability !== "idle")
      rejected.push(`availability:${route.availability}`);
    if (route.active >= route.capacity) rejected.push("route_capacity");
    if (rejected.length) rejected.forEach((reason) => reasons.add(reason));
    else eligible.push(route);
  }
  eligible.sort((a, b) => a.overhead - b.overhead || a.id.localeCompare(b.id));
  const route = eligible[0];
  return route
    ? { status: "selected", routeId: route.id, path: route.path }
    : {
        status: "blocked",
        reasons: reasons.size ? [...reasons].sort() : ["no_compatible_route"],
      };
}
