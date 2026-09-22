# Startup compatibility diagnostics

The candidate advertises a compact API version, schema version, skill contract,
MCP application/protocol version and build descriptor. The production build
embeds the package/SDK versions, Git revision and a SHA-256 over source, SQL,
manifest, lockfile and build script. A docs-only commit can change revision while
keeping compatible source bytes. Direct source/test bundles without a descriptor
are explicitly `development-unidentified`; they do not establish production-build
identity.

Trusted launchers authenticate a read-only `compatibility` IPC probe before
enrollment. A different API/schema/skill contract fails as
`coordinator_version_mismatch`; identified production clients also reject a
different or unidentified source digest as `coordinator_build_mismatch`.
The launcher closes its own connection and does not kill an existing owner.
An old owner without discovery gets an explicit restart diagnostic. Ordinary
session capabilities may inspect the same metadata; invalid credentials cannot.
The MCP adapter checks the owner descriptor in bootstrap before serving tools.

New owner configs include `version: 1`. Existing unversioned candidate configs
are accepted for continuity; an explicitly unsupported version is rejected before
opening a database. Existing identity, path and dispatch validation remains in
force. A compatibility failure never rotates a resume token or selects another
database to make startup succeed.

Set `SWARM_SKILL_PATH` to the actual skill copy intended for the session. The
launcher also accepts `skillPath` and propagates that path to the MCP child.
An unreadable file, relative path or wrong/missing frontmatter contract causes
`skill_mismatch` before enrollment/MCP startup. The expected stamp is:

```yaml
metadata:
  coordination-contract: swarm-coordination/1
```

The stamp is version identity, not a signature or validation of all prose. The
file may still have been edited incorrectly. With no configured path, diagnostics
say `not_configured`, never “skill verified.” Even `file_verified` describes only
the named file; the host's loaded model instructions are not observable here.

`swarm_sync` includes the owner's compatibility record. In an enrolled shell,
`node dist/coordination/client-cli.js doctor` reports owner and client descriptors
plus configured-skill status without secrets. Keep these records when diagnosing
a stale executable/config path. Use the same built candidate for owner and adapters,
finish or stop existing work safely, then explicitly restart that owner. Do not
rewrite its database, delete retained identity files or silently switch profiles.

`test/coordination-compatibility.test.ts` builds two distinct clients/owners,
verifies rejection before any session is enrolled, and proves the existing owner
remains reachable. It also covers authentication, stale skill files, unknown
config versions and MCP startup refusal. Full compact MCP tests exercise successful
bootstrap and workflow calls in both modern and legacy protocol modes.
