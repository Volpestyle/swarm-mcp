import * as kv from "./kv";
import { stamp } from "./time";
import type { TaskType } from "./generated/protocol";

export const WORK_TRACKER_PREFIX = "config/work_tracker/";
export const TRACKER_BINDING_PREFIX = "tracker/";
export const DEFAULT_PROVIDER = "linear";

export function identityFromLabel(label: string | null | undefined) {
  if (!label) return "";
  for (const token of label.split(/\s+/)) {
    if (!token.startsWith("identity:")) continue;
    const identity = token.slice("identity:".length).trim();
    if (/^[A-Za-z0-9_.-]+$/.test(identity)) return identity;
  }
  return "";
}

export function workTrackerKey(identity: string | null | undefined) {
  const clean = (identity ?? "").trim();
  const suffix = /^[A-Za-z0-9_.-]+$/.test(clean) ? clean : "default";
  return `${WORK_TRACKER_PREFIX}${suffix}`;
}

function parseValue(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export interface ResolvedTrackerConfig {
  key: string;
  value: unknown;
  updated_at: number;
}

export function configuredWorkTracker(
  scope: string,
  label: string | null | undefined,
): ResolvedTrackerConfig | null {
  const identity = identityFromLabel(label);
  const keys = identity
    ? [workTrackerKey(identity), workTrackerKey("default")]
    : [workTrackerKey("default")];

  for (const key of keys) {
    const row = kv.get(scope, key);
    if (!row) continue;
    return {
      key,
      value: parseValue(row.value),
      updated_at: row.updated_at,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Linear promotion predicate (VUH-36)
//
// Pure decision layer. The actual Linear MCP call lives outside this module
// (in the gateway / planner that owns the tracker MCP). This file:
//   1. evaluates whether a task should be promoted to the configured tracker
//   2. detects explicit `linear:VUH-XX` references and resolves them to a
//      `link` decision the binding row can be written for without an API call
//   3. reads / writes binding rows at `tracker/<provider>/<identity>/<task_id>`
//
// See docs/linear-promotion-policy.md for the binding spec.
// ---------------------------------------------------------------------------

/** Tracker types the predicate routes for; everything else is skipped. */
const PROMOTABLE_TASK_TYPES: ReadonlyArray<TaskType> = [
  "implement",
  "fix",
  "review",
  "research",
] as const;

export interface TrackerConfig {
  identity: string;
  provider: string;
  mcp: string | null;
  default_promotion: string | null;
}

export interface TaskPromotionInput {
  task_id: string;
  type: TaskType;
  title: string;
  description: string | null;
  idempotency_key: string | null;
  parent_task_id: string | null;
  label: string | null;
  files: string[] | null;
}

export interface DispatchPromotionOverride {
  /** Explicit per-dispatch override: true forces promote, false suppresses. */
  promote?: boolean;
  /** Explicit identifier the operator pasted, e.g. "VUH-20". Forces link. */
  identifier?: string;
}

export interface PromotionDecisionCommon {
  identity: string;
  provider: string;
  precedence: "per_dispatch" | "routine" | "identity" | "repo" | "default";
}

export type PromotionDecision =
  | (PromotionDecisionCommon & {
      promote: true;
      mode: "create";
      reason: string;
      existing_binding: TrackerBinding | null;
    })
  | (PromotionDecisionCommon & {
      promote: true;
      mode: "link";
      reason: string;
      identifier: string;
      url?: string;
      existing_binding: TrackerBinding | null;
    })
  | {
      promote: false;
      reason: string;
      identity: string | null;
      provider: string | null;
    };

export interface TrackerBinding {
  identifier: string;
  url?: string;
  linked_at: number;
}

export function bindingKey(provider: string, identity: string, taskId: string) {
  const cleanProvider = sanitizeSegment(provider, DEFAULT_PROVIDER);
  const cleanIdentity = sanitizeSegment(identity, "default");
  const cleanTask = taskId.trim();
  if (!cleanTask) throw new Error("bindingKey requires a non-empty task id");
  return `${TRACKER_BINDING_PREFIX}${cleanProvider}/${cleanIdentity}/${cleanTask}`;
}

function sanitizeSegment(value: string, fallback: string) {
  const clean = (value ?? "").trim();
  return /^[A-Za-z0-9_.-]+$/.test(clean) ? clean : fallback;
}

export function getBinding(
  scope: string,
  provider: string,
  identity: string,
  taskId: string,
): TrackerBinding | null {
  const row = kv.get(scope, bindingKey(provider, identity, taskId));
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    if (typeof parsed.identifier !== "string" || !parsed.identifier) return null;
    return {
      identifier: parsed.identifier,
      url: typeof parsed.url === "string" ? parsed.url : undefined,
      linked_at:
        typeof parsed.linked_at === "number" ? parsed.linked_at : row.updated_at,
    };
  } catch {
    return null;
  }
}

export interface SetBindingOpts {
  scope: string;
  provider: string;
  identity: string;
  task_id: string;
  identifier: string;
  url?: string;
  actor?: string | null;
}

export type SetBindingResult =
  | { ok: true; key: string; binding: TrackerBinding }
  | { error: string };

export function setBinding(opts: SetBindingOpts): SetBindingResult {
  const payload: TrackerBinding = {
    identifier: opts.identifier,
    ...(opts.url ? { url: opts.url } : {}),
    linked_at: stamp(),
  };
  const key = bindingKey(opts.provider, opts.identity, opts.task_id);
  const result = kv.set(opts.scope, key, JSON.stringify(payload), opts.actor ?? null);
  if ("error" in result && typeof result.error === "string") {
    return { error: result.error };
  }
  return { ok: true, key, binding: payload };
}

/** Pull a `VUH-31`-style identifier out of free text. Returns the first match. */
export function detectTrackerIdentifier(text: string | null | undefined) {
  if (!text) return null;
  const direct = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/.exec(text);
  if (direct) return { identifier: direct[1], url: undefined as string | undefined };

  const prefixed = /\blinear:([A-Z][A-Z0-9]{1,9}-\d+)\b/i.exec(text);
  if (prefixed) {
    return {
      identifier: prefixed[1].toUpperCase(),
      url: undefined as string | undefined,
    };
  }

  const url = /https?:\/\/[^\s]+\/issue\/([A-Z][A-Z0-9]{1,9}-\d+)/i.exec(text);
  if (url) return { identifier: url[1].toUpperCase(), url: url[0] };

  return null;
}

function normalizeTrackerConfig(
  value: unknown,
  fallbackIdentity: string,
): TrackerConfig {
  const record =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const provider =
    typeof record.provider === "string" && record.provider.trim()
      ? record.provider.trim().toLowerCase()
      : DEFAULT_PROVIDER;
  const mcp =
    typeof record.mcp === "string" && record.mcp.trim()
      ? record.mcp.trim()
      : typeof record.mcp_server === "string" && record.mcp_server.trim()
        ? record.mcp_server.trim()
        : null;
  const identity =
    typeof record.identity === "string" && record.identity.trim()
      ? record.identity.trim()
      : fallbackIdentity;
  const defaultPromotion =
    typeof record.default_promotion === "string"
      ? record.default_promotion.trim().toLowerCase()
      : null;
  return { identity, provider, mcp, default_promotion: defaultPromotion };
}

function deny(reason: string, identity: string, provider: string | null): PromotionDecision {
  return {
    promote: false,
    reason,
    identity: identity || null,
    provider,
  };
}

/**
 * Evaluate the promotion policy for a single task.
 *
 * The function is pure given the inputs — it never calls the tracker API. The
 * caller is responsible for using the result to drive Linear MCP and writing
 * the final binding via {@link setBinding}.
 */
export function evaluatePromotion(opts: {
  scope: string;
  task: TaskPromotionInput;
  tracker: ResolvedTrackerConfig | null;
  override?: DispatchPromotionOverride;
}): PromotionDecision {
  const { scope, task, tracker, override } = opts;

  const identity = identityFromLabel(task.label);
  if (!identity) {
    return deny("missing_identity_label", "", null);
  }

  if (!tracker) {
    return deny("no_tracker_configured", identity, null);
  }

  const config = normalizeTrackerConfig(tracker.value, identity);
  // Identity enforcement: the tracker config must belong to this identity.
  if (config.identity && config.identity !== identity) {
    return deny("identity_mismatch", identity, config.provider);
  }

  const existingBinding = getBinding(scope, config.provider, identity, task.task_id);

  // §3: Tasks whose `parent_task_id` is set are deferred to the parent's
  // routine declaration. We can't see the routine here, so we surface the
  // parent's binding and let the caller decide. The default in this first cut
  // is "inherit binding when parent has one, skip otherwise."
  if (task.parent_task_id) {
    const parentBinding = getBinding(scope, config.provider, identity, task.parent_task_id);
    if (parentBinding) {
      return {
        promote: true,
        mode: "link",
        reason: "parent_binding_inherited",
        identity,
        provider: config.provider,
        identifier: parentBinding.identifier,
        url: parentBinding.url,
        existing_binding: existingBinding,
        precedence: "routine",
      };
    }
    return deny("parent_routine_skipped", identity, config.provider);
  }

  // §3: synthetic spawn/coordination resources never promote.
  if (
    task.idempotency_key &&
    task.idempotency_key.startsWith("__swarm/")
  ) {
    return deny("synthetic_resource", identity, config.provider);
  }

  // §2.1 explicit operator marker — highest precedence.
  if (override?.promote === false) {
    return deny("operator_suppressed", identity, config.provider);
  }

  const explicitIdentifier =
    override?.identifier?.trim() ||
    detectTrackerIdentifier(task.idempotency_key)?.identifier ||
    detectTrackerIdentifier(task.title)?.identifier ||
    detectTrackerIdentifier(task.description)?.identifier ||
    null;
  const explicitUrl = (() => {
    if (override?.identifier) return undefined;
    return (
      detectTrackerIdentifier(task.description)?.url ??
      detectTrackerIdentifier(task.title)?.url ??
      undefined
    );
  })();

  if (explicitIdentifier) {
    return {
      promote: true,
      mode: "link",
      reason: "explicit_identifier",
      identity,
      provider: config.provider,
      identifier: explicitIdentifier,
      url: explicitUrl,
      existing_binding: existingBinding,
      precedence: "per_dispatch",
    };
  }

  if (override?.promote === true) {
    return {
      promote: true,
      mode: "create",
      reason: "operator_requested",
      identity,
      provider: config.provider,
      existing_binding: existingBinding,
      precedence: "per_dispatch",
    };
  }

  // §3: type=test never promotes.
  if (!PROMOTABLE_TASK_TYPES.includes(task.type)) {
    return deny("type_not_promotable", identity, config.provider);
  }

  // §2.2: medium-or-larger heuristic. We approximate "more than a one-line
  // tweak" by requiring either a non-empty `files` list with >1 entries or a
  // description longer than 80 characters. test/research are filtered above.
  const layer = resolvePromotionLayer(config);
  if (layer === "explicit_only") {
    return deny("repo_explicit_only", identity, config.provider);
  }

  const promotable = layer === "always" || isMediumOrLarger(task);
  if (!promotable) {
    return deny("trivial_inline_edit", identity, config.provider);
  }

  return {
    promote: true,
    mode: "create",
    reason: layer === "always" ? "repo_default_always" : "medium_or_larger",
    identity,
    provider: config.provider,
    existing_binding: existingBinding,
    precedence:
      layer === "always"
        ? "repo"
        : config.default_promotion
          ? "identity"
          : "default",
  };
}

type PromotionLayer = "always" | "medium_or_larger" | "explicit_only";

function resolvePromotionLayer(config: TrackerConfig): PromotionLayer {
  const fromIdentity = (config.default_promotion ?? "").trim();
  if (fromIdentity === "always") return "always";
  if (fromIdentity === "explicit-only" || fromIdentity === "explicit_only") {
    return "explicit_only";
  }
  if (fromIdentity === "medium-or-larger" || fromIdentity === "medium_or_larger") {
    return "medium_or_larger";
  }
  // Built-in default per docs/linear-promotion-policy.md §4.
  return "medium_or_larger";
}

function isMediumOrLarger(task: TaskPromotionInput) {
  const fileCount = task.files?.length ?? 0;
  if (fileCount > 1) return true;
  const descLength = task.description?.trim().length ?? 0;
  if (descLength > 80) return true;
  // Titles like "VUH-36: …" can be promoted on their own merit; check whether
  // the title is more than a sentence-fragment one-liner.
  const titleLength = task.title.trim().length;
  return titleLength > 60;
}

/**
 * Convenience: evaluate, and if the decision is `link` with a known
 * identifier (no existing binding yet), persist the binding row immediately
 * because the operator's intent is unambiguous.
 *
 * The `create` case does NOT write a binding here — the bridge does not call
 * the tracker API; the caller (gateway/planner with Linear MCP) creates the
 * issue and then writes the binding via {@link setBinding}.
 */
export function evaluateAndAutoLink(opts: {
  scope: string;
  task: TaskPromotionInput;
  tracker: ResolvedTrackerConfig | null;
  override?: DispatchPromotionOverride;
  actor?: string | null;
}) {
  const decision = evaluatePromotion(opts);
  if (
    decision.promote &&
    decision.mode === "link" &&
    !decision.existing_binding
  ) {
    const written = setBinding({
      scope: opts.scope,
      provider: decision.provider,
      identity: decision.identity,
      task_id: opts.task.task_id,
      identifier: decision.identifier,
      url: decision.url,
      actor: opts.actor ?? null,
    });
    if ("ok" in written) {
      return { decision, binding_written: written.binding };
    }
    return { decision, binding_error: written.error };
  }
  return { decision };
}
