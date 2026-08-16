# Changelog

## 0.2.4 — 2026-08-16

No user-facing change: internal hardening and documentation.

### Changed

- A failing test now fails instead of hanging. Tests closed their server as the
  last statement of the body, so a throwing assertion skipped cleanup and leaked
  the listening handle; `--test-force-exit` masked it. Cleanup runs via
  `t.after`, the flag is gone, and a deliberate failure exits in ~3s.
- The shared `id` and `page` schema objects are frozen. They are assigned by
  reference into every tool that uses them, so a future per-tool patch would
  otherwise have silently altered all of them.
- `annotate()` is an exhaustive switch over `Operation`, matching `schemaFor`
  and `describe`. A new upstream operation now breaks the build rather than
  silently defaulting a destructive tool to non-destructive.
- README documents the `405` responses on `GET`/`DELETE /mcp`, and self-hosting
  now precedes the client-setup sections it is a prerequisite for.

## 0.2.3 — 2026-08-16

### Fixed

- **Array filters returned HTTP 500.** `filter: { status: ['attending'] }` was
  serialised as `filter[status][0]=attending`, which the Confetti API rejects.
  The generated schemas advertise `status` as an array of enum, so the tools
  were instructing callers to send precisely the shape that fails — reported
  from a real client. Array filter values are now joined into the comma list the
  API accepts (`filter[status]=attending,waitlist`, which genuinely ORs). The
  schemas still take an array; only the wire representation changed.
  Affects `confetti_tickets_find_all` and `confetti_payments_find_all`.
  Filed upstream as confetti/confetti-node#37.

## 0.2.2 — 2026-08-16

### Added

- `webhook.type` now advertises its 17 valid event types. Upstream declares it a
  bare string, but the registry states the values, so the enum is generated from
  it and stays correct as events are added.
- Descriptions for ten fields whose meaning is readable from neither the schema
  nor the name — the free-form `settings`/`content` objects and the block-style
  and theme ids no tool lists. Where upstream documents nothing these say so
  rather than guessing.

### Changed

- The design doc now describes the deployment that exists rather than a private
  deploy repo that was planned and never built.

## 0.2.1 — 2026-08-16

No user-facing change. Deployment moved from a Docker Hub webhook to an Azure
OIDC federated credential: the webhook URL embedded App Service publishing
credentials that also granted shell access, stored outside any secret manager.
Releases now deploy an exact version tag rather than following `latest`, and
verify the running app reports it.

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
