# Linear promotion policy

The current compact-coordinator policy lives in the packaged
[work-tracker reference](../skills/swarm-mcp/references/work-trackers.md), so the
agent skill and operator documentation use the same rules. Integration is optional:
no Linear calls are made by the compact owner, and runtime progress does not depend
on tracker availability.

This reuses VUH-35 through VUH-38's promotion/binding/evidence work while adopting
VUH-1344's explicit acceptance boundary: one authorized writer per binding,
version-aware reconciliation, and no automatic worker-completed-to-issue-Done
transition. The archived tickets are historical design input, not shipped bridge
claims or permission to reopen that work.

The [legacy policy](legacy-linear-promotion-policy.md) retains the earlier
worker-first/gateway-backstop design and legacy configuration keys for historical
reference. Its automatic closure mapping does not govern the compact candidate.
