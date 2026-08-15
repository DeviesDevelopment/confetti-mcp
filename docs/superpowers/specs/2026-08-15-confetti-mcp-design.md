# confetti-mcp — Design

**Date:** 2026-08-15
**Status:** Approved
**Repo:** `DeviesDevelopment/confetti-mcp` (public, MIT)
**Milestone 1 scope:** working server, tests, and a published Docker Hub image.
Hosting is explicitly out of scope until that lands.

## Summary

A remote MCP server exposing the Confetti API as tools for MCP clients, primarily
Claude Code. It is a thin, stateless HTTP layer over the published `confetti` npm
package (v4.1.5). Callers supply their own Confetti API key per request; the
server stores no credentials and holds no per-user state.

Tools are generated from `confetti-node`'s model registry rather than
hand-written, so the tool surface tracks the library automatically.

## Goals

- Every Confetti API operation reachable as an MCP tool, with typed inputs.
- API key supplied by the caller via a standard HTTP header, never stored server-side.
- Self-hostable by anyone from a public Docker image.
- Deployment topology and Azure resource names stay private.
- New resources added to `confetti-node` appear as tools with no code change here.

## Non-goals

- OAuth. Confetti issues API keys; an OAuth authorization server is out of scope.
- Caching, rate limiting, or quota enforcement. The upstream API owns those.
- A stdio transport. Remote HTTP only (revisit if demand appears).
- Vendoring or forking `confetti-node`. It is consumed as a versioned npm dependency.

## 1. Repositories and release chain

The split is drawn at **artifact vs. placement**: the public repo owns everything
up to and including the published container image; the private repo owns only
where that image runs.

### `DeviesDevelopment/confetti-mcp` — public, MIT

Source, tests, Dockerfile, README, CI. On a version tag, CI builds a multi-arch
image (`linux/amd64`, `linux/arm64`) and pushes to Docker Hub as
`deviesdevelopment/confetti-mcp`, tagged with the semver and the commit SHA.
Public Actions minutes are free, and nothing in this repo is sensitive — the
build is fully reproducible by outsiders, which is the point of open-sourcing it.

Docker Hub credentials are the one secret here: a scoped access token stored as a
repository secret. Fork PRs cannot read it (GitHub default), and the publish job
is gated on tag pushes, not PRs.

### `DeviesDevelopment/confetti-mcp-deploy` — private, deferred

**Not in the current scope.** The first milestone ends at a working image
published to Docker Hub; hosting is decided after that lands and the server has
been exercised by `docker run`.

When it happens: Bicep for the Azure App Service, custom domain, and app
settings; plus a deploy workflow that pins an image tag and rolls it out via
Azure OIDC federated credentials (the same mechanism KleerMCP already uses — no
stored passwords). Release is `gh workflow run deploy.yml -f tag=v1.2.0` from the
private repo. No cross-repo token is needed in either direction. Resource names,
topology, and deploy logs never become public.

Nothing in the public repo assumes Azure, so deferring this costs nothing later.

This mirrors the standard shape for open-source products with a privately-hosted
instance (Sentry, Cal.com, PostHog, Supabase all split this way).

## 2. Runtime architecture

TypeScript, ESM, Node 22 LTS. Dependencies:

- `@modelcontextprotocol/sdk` — `StreamableHTTPServerTransport` in stateless mode
- `express` — HTTP layer
- `confetti` — `^4.1.5`, the API client

Stateless mode means `sessionIdGenerator: undefined`: a fresh `McpServer` and
transport are constructed per request. This matters for correctness, not just
scale — the caller's API key is closed over by that request's instance and cannot
leak across requests.

Tool *definitions* are expensive to build and are computed once at startup, then
cached per filter combination (see §4). Only the server wiring is per-request.

`GET /` returns `{ status, server, version, usage }`, matching the KleerMCP
convention.

## 3. Authentication

The caller's Confetti API key is extracted per request and passed straight into
the client's static methods — `Confetti.events.findAll({ apiKey, ... })`. Every
static method on `confetti-node` accepts `apiKey` per call, which is what makes
a stateless multi-tenant server possible without constructing a client per user.

Accepted carriers, in precedence order:

1. `Authorization: Bearer <key>` — the primary, and the only one documented as
   first-class.
2. `X-Api-Key: <key>` — alias, for clients whose UI labels the field that way.
3. `/mcp/k/<key>` path segment — fallback for clients that cannot set headers
   (notably the claude.ai web connector UI). Documented as discouraged.

Missing or empty key returns `401` with a `WWW-Authenticate: Bearer` header.

The key is never logged, never written to disk, and never included in error
messages returned to the client.

**Why header over path or querystring.** A key in the URL lands in Azure App
Service HTTP logs, Application Insights request telemetry, and any reverse proxy
access log; KleerMCP had to add explicit log-filter suppression to work around
exactly this. It also sits in plaintext in the user's `~/.claude.json`, whereas a
header supports `${CONFETTI_API_KEY}` expansion or a `headersHelper` command, so
the secret need not be in a config file at all. RFC 6750 additionally discourages
tokens in query strings. The path fallback carries the same log-suppression
treatment as KleerMCP, scoped to that route only.

## 4. Connect-URL grammar

Tool surface is filtered per connection, not at build time:

```
/mcp                               all 63 tools
/mcp?ops=read                      29 tools, no writes
/mcp?ops=get,post,put              53 tools, no deletes
/mcp?resources=events,tickets      only those resources
/mcp?resources=events&ops=read     composed
```

`ops` accepts domain verbs (`read`, `create`, `update`, `delete`) and HTTP verb
aliases (`get`→`read`, `post`→`create`, `put`→`update`, `delete`→`delete`), since
both vocabularies are natural to reach for. `read` covers both `find` and
`find_all`.

Unknown resource or op names are rejected with `400` and a message listing valid
values, rather than silently yielding an empty tool list.

Default with no parameters is all 63 tools. The API key already grants full
access, and this matches how GitHub, Linear, and Notion's servers behave.

## 5. Tool generation

All tools derive from `Confetti.models` plus the exported `schemaToJsonSchema`
and `filterToJsonSchema` helpers.

**Resource resolution.** `model.endpoint` is inconsistent across the registry —
`formFields` is camelCase while `image-uploads` is kebab-case — so it cannot be
used to look up the static resource. It happens to work for all 18 real resources
only because the three models with kebab endpoints (`addon`, `imageUpload`,
`previewToken`) are exactly the three with no static resource. Relying on that
coincidence would fail silently on an upstream rename, so the server keeps an
explicit typed map of the 18 model keys to their `Confetti` static resource. A
rename upstream then breaks the build instead of dropping tools.

**Naming.** `confetti_<resource>_<operation>`, e.g. `confetti_events_find_all`,
`confetti_sponsor_levels_delete`.

**Input schemas.**

| Operation | Inputs |
| --- | --- |
| `find_all` | `filter` from `model.filters` via `filterToJsonSchema`; `sort` as an enum from `model.sorting`; `include` as an enum array from `model.includes`; `page` |
| `find` | `id`, `include` |
| `create` / `update` | from `model.operations.{create,update}.schema` via `schemaToJsonSchema`, with relationship fields stripped; `update` also takes `id` |
| `delete` | `id` |

**Descriptions** embed `model.sample.single.formatted` so the model sees a real
payload shape rather than only a schema.

**Annotations.** `readOnlyHint` on reads, `idempotentHint` on updates,
`destructiveHint` on the ten deletes. Claude Code surfaces destructive tools for
confirmation rather than running them unprompted.

Operations are not uniform across resources — `forms` is find-only, `events` has
no delete, `speakers` has no `find_all`. Actual counts:

| verb | tools |
| --- | --- |
| `find` | 18 |
| `find_all` | 11 |
| `create` | 13 |
| `update` | 11 |
| `delete` | 10 |
| **total** | **63** |

## 6. Responses and errors

**Pagination.** `find_all` defaults to `page.size = 25`. An uncapped list response
is the fastest way to exhaust the client's context; the caller can page
deliberately by passing `page` explicitly.

**Results** are returned as pretty-printed JSON in a text content block.

**Errors** map to `isError: true` with a readable message naming the tool, in the
shape KleerMCP's `CallToolFilter` produces. Because `confetti-node` does not
export its error classes (see §9), classification is by `error.name`:

| `error.name` | Message shape |
| --- | --- |
| `ParameterError` | `Invalid parameters for '<tool>': <detail>` |
| `NotFoundError` | `Not found in '<tool>': <detail>` |
| `OperationNotFoundError` | `Unsupported operation '<tool>'` |
| anything else | `Error in '<tool>': [<type>] <message>` |

Zod validation failures from the client's own `.parse()` calls surface as
`ParameterError`-shaped messages so the model can correct its arguments.

## 7. Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `CONFETTI_API_HOST` | `api.confetti.events` | Upstream host, passed through to the client |
| `CONFETTI_API_PROTOCOL` | `https` | Upstream protocol |
| `LOG_LEVEL` | `info` | |

No API key is ever read from the server's own environment. A server-side default
key would be a multi-tenant footgun.

## 8. Testing

`node --test` with `tsx`, matching `confetti-node`'s existing setup; `nock` for
the upstream API. The tests that carry real weight:

- **Registry coverage** — every model in the explicit map resolves to a live
  static resource, and every static resource is present in the map. This is the
  test that catches the endpoint-naming fragility described in §5.
- **Filter grammar** — `ops` and `resources` combinations produce exactly the
  expected tool sets, including the HTTP-verb aliases and the 63-tool default.
- **Auth extraction** — all three carriers, precedence between them, and the
  `401` path. Plus an assertion that the key appears in no log output.
- **Error mapping** — each upstream failure mode produces the right `isError`
  message, driven by `error.name`.
- **Schema generation** — spot-check that `events_create` inputs match
  `EventCreateSchema` and that relationship fields are stripped.

## 9. Known constraints

- **Error classes are not exported.** `confetti-node`'s `src/errors.ts` is absent
  from the package entry point, and `package.json` `exports` exposes only `.`.
  Classification by `error.name` works today. A small upstream PR exporting them
  would be cleaner — tracked as a follow-up, not a blocker.
- **claude.ai web cannot set custom headers**, which is why the path fallback
  exists. Claude Code and Claude Desktop both handle headers natively.
- **63 tool schemas is roughly 40–60k tokens of always-on context.** This was a
  deliberate choice for discoverability over context economy. The `?ops=` and
  `?resources=` filters are the escape valve, and the generated architecture
  means switching to a smaller surface later is a change to one module, not a
  rewrite.

## 10. Follow-ups

- Upstream PR to `confetti-node` exporting the error classes.
- Optional GHCR mirror alongside Docker Hub.
- Consider `structuredContent` with `outputSchema` once the text-JSON shape has
  proven itself in use.
