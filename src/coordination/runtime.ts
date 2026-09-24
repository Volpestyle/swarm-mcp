/** Embedding boundary for hosts; coordination semantics remain in the owner. */
export { enrollRuntime } from "./runtime-launcher";
export { CoordinationClient, localEndpoint, type Operation } from "./ipc";
export { RuntimeDelivery, renewTaskLeases, type RuntimeAdapter, type RuntimeDeliveryLease } from "./runtime-delivery";
export { observeInbox } from "./inbox-observer";
export { prepareClaudeLaunch } from "./claude-launcher";
export { ownerState } from "./launcher-state";
export { ensureCoordinator } from "./owner-launcher";
