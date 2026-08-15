# Changelog

## 0.2.0 — 2026-08-15

Security and agent-experience release, driven by two multi-agent reviews: a defect
audit (39 findings, 6 refuted, 29 kept) and an MCP-quality review (27 recommendations,
9 kept after an adversarial critic).

### Breaking

- **Read tools return an envelope, not a bare array.** `find_all` now returns
  `{ returned, page: { number, size }, more, records: [...] }` — previously a bare
  array with no way to tell "25 records is everything" from "the first 25 of 137".
- **`delete` returns `{ deleted: true, resource, id }`**, previously an empty string.
  Other empty-body successes return `{ ok: true, operation, resource, id }`.
- **Tool arguments are validated before dispatch.** Calls that previously "succeeded"
  while silently doing nothing now fail with an actionable message. See below.

### Fixed — security

- **Cross-tenant data disclosure.** The upstream client holds a process-global
  JSON:API store that caches every record by `(type, id)` for the life of the process
  and resolves relationships against it. Reproduced: one caller received another
  caller's record attributes through a relationship reference. Responses are now
  flattened with a per-call store, so no state crosses requests.
- **Path traversal defeating the connection filter.** Record ids were interpolated
  into the upstream URL unvalidated, so a connection scoped `?resources=events` could
  read — and delete — other resources via `id: "../payments/7"`. Ids are now
  allowlisted.
- **Connection options failed open.** The reserved-key denylist would not have
  stopped a new upstream option key; it is now an explicit per-operation allowlist.
- **No effective upstream timeout.** The client's timeouts are inert under
  `node-fetch` v3; every call now has a real deadline.
- **Unbounded response amplification.** Caller page sizes are clamped.

### Fixed — correctness

- Three `find_all` tools advertised a contract that always failed: `filter.eventId`
  is mandatory upstream but was never marked required.
- `filter.status` put its enum on the array instead of its items, making the schema
  unsatisfiable — status filtering was impossible from any validating client.
- `confetti_tickets_create.values` documented a field called `formValues` that does
  not exist. A model following it silently discarded the attendee's form answers.
- Malformed request bodies returned 500; they now return 400/413/415 as appropriate.
- Unknown tools return the protocol's `-32602` rather than a tool-level error.

### Added

- **Argument validation before dispatch** — unknown fields, bad enums, empty updates
  and non-ISO dates are rejected with the valid values in the message, so a model can
  correct itself instead of retrying blindly.
- **Server instructions** — a generated orientation paragraph describing the resource
  tree, the seven resources with no list tool and how to reach them, and the
  operations that do not exist.
- **Failure logging** — one structured JSON line to stderr per failure. Never the
  key, arguments, URL, or error message.
- **Actionable errors** — the upstream JSON:API error body is surfaced, validation
  issues are rendered one per line, and bare HTTP statuses carry guidance.
- Field description coverage raised from 40% to 56% by recovering metadata the schema
  generator was discarding.

### Changed

- Release builds now boot the image and check it serves before pushing to the tag
  production pulls.
- Base image pinned by digest; all GitHub Actions pinned to commit SHAs.
- Dependency install scripts disabled in CI and image builds.

### Known limitations

- The upstream store singleton still exists; this release routes around it. An
  upstream fix is filed.
- Description coverage is 56%, not complete — most remaining gaps need either
  upstream metadata or a docs-derived table.
- The Docker Hub webhook makes a mutable tag the production trust root.

## 0.1.0 — 2026-08-15

Initial release. Stateless MCP server over the Confetti API with 63 tools generated
from the client's model registry, four API key carriers, and a connect-URL filter
enforced on `tools/call`.
