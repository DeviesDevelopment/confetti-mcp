# confetti-mcp

An MCP server for the [Confetti](https://confetti.events) API. It exposes all 63
Confetti API operations as MCP tools, so assistants like Claude Code can manage
events, tickets, contacts, pages, and payments directly.

> **Beta** — tool definitions may change.

## How it works

`confetti-mcp` is a stateless HTTP server speaking the MCP streamable-http
transport. You supply your own Confetti API key on each connection; the server
stores no credentials and holds no per-user state.

Because there is no session, `GET /mcp` and `DELETE /mcp` — the
streamable-http verbs for resuming or closing one — return `405`: there is
nothing to resume and nothing to delete. Use `POST /mcp` for everything.

Tools are generated at startup from the `confetti` client's model registry, so
the tool surface tracks the API rather than being hand-maintained.

There's no hosted instance — self-hosting (see below) is the supported way to
run it today. `https://your-host` in the examples below stands for wherever
you deploy it.

## Self-hosting

```bash
docker run -p 8080:8080 deviesdevelopment/confetti-mcp
```

> Published from the first tagged release onward. Until then, build it locally
> with the commands below.

Or build the image from the `Dockerfile` in this repo:

```bash
docker build -t confetti-mcp .
docker run -p 8080:8080 confetti-mcp
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `CONFETTI_API_HOST` | `api.confetti.events` | Upstream API host |
| `CONFETTI_API_PROTOCOL` | `https` | Upstream protocol |
| `LOG_LEVEL` | `info` | Accepted but not yet wired to log output; reserved |

`GET /` is an unauthenticated health endpoint, suitable for a load balancer or
container probe. It reports the server name and version and touches nothing
upstream:

```bash
curl https://your-host/
# {"status":"ok","server":"confetti-mcp","version":"0.2.0","usage":"POST /mcp with an \"Authorization: Bearer <confetti-api-key>\" header.","filtering":"All 63 tools are exposed by default. Narrow the connection with ?ops= and ?resources= ..."}
```

The image's own `HEALTHCHECK` uses this endpoint, so plain Docker and compose
restart a wedged container without any extra configuration.

### Logs

The server writes one structured JSON line to **stderr** per failed tool call and
per rejected request — request id, tool name, error class, upstream status class,
and duration. It deliberately never logs the API key, the tool arguments, the
request URL, or the error message, because all four can carry caller data and the
URL carriers put the key in the path or query string. A regression test asserts
the key never reaches any output channel through any carrier
(`test/server/no-key-in-logs.ts`).

Successful calls are not logged at all.

**Managed platforms ignore the Dockerfile `HEALTHCHECK`** and probe a path you
configure instead — point them at `/`. On Azure App Service for Containers that
is the separate **Health check** feature (Settings → Health check → path `/`),
which is off by default: without it a container that is listening but wedged is
never restarted, and Always On only keeps it warm. The equivalents elsewhere:

| Platform | Setting |
| --- | --- |
| Azure App Service | Health check path `/` |
| AWS ECS / ALB | Target group health check path `/` |
| Kubernetes | `livenessProbe.httpGet.path: /` |
| Docker / compose | Nothing to configure — the image's `HEALTHCHECK` is used |

The server never reads an API key from its own environment — keys always come
from the caller.

## Connect from Claude Code

```bash
claude mcp add --transport http confetti https://your-host/mcp \
  --header "Authorization: Bearer $CONFETTI_API_KEY" \
  --scope user
```

Check it connected with `/mcp` inside a session. `claude mcp add` saves the
config without validating credentials, so a bad key shows up as `failed` at
connect time rather than at add time.

### Share it with your team

Commit a `.mcp.json` that carries no secret:

```json
{
  "mcpServers": {
    "confetti": {
      "type": "http",
      "url": "${CONFETTI_MCP_URL:-https://your-host}/mcp",
      "headers": { "Authorization": "Bearer ${CONFETTI_API_KEY}" }
    }
  }
}
```

Both `${VAR}` and `${VAR:-default}` expand in `url` and `headers`. Each developer
exports `CONFETTI_API_KEY` in their own shell.

> An entry with a `url` but no `type` is a configuration error — Claude Code
> reads it as a stdio server and skips it. Always include `"type": "http"`.

### Keep the key out of your environment entirely

```json
{
  "mcpServers": {
    "confetti": {
      "type": "http",
      "url": "https://your-host/mcp",
      "headersHelper": "echo '{\"Authorization\":\"Bearer '\"$(op read op://Vault/confetti/api-key)\"'\"}'"
    }
  }
}
```

Claude Code runs the helper at connect time. On a `401` or `403` it re-runs the
helper and retries once, so a rotated key heals without restarting the session.

## Trimming the tool surface

The full tool list — all 63 tools — serialises to roughly 73 KB of JSON, about
20,000 tokens of context spent before you've asked anything. Narrow it per
connection with query parameters on the connect URL:

| URL | Tools |
| --- | --- |
| `/mcp` | all 63 |
| `/mcp?ops=read` | 29 — reads only |
| `/mcp?ops=get,post,put` | 53 — no deletes |
| `/mcp?resources=events,tickets` | 8 |
| `/mcp?resources=events&ops=read` | 2 |

`ops` accepts domain verbs (`read`, `create`, `update`, `delete`) and HTTP verb
aliases (`get`, `post`, `put`, `patch`, `delete`). `read` covers both `find` and
`find_all`.

The filter is enforced, not advisory: a tool excluded by `?ops=` / `?resources=`
is refused if a client calls it directly by name, not merely hidden from
`tools/list`. A connection opened with `?ops=read` cannot invoke a delete tool
even by naming it exactly.

## Connect from Claude Desktop

Which setup you need depends on the surface:

**Code tab** — reads `~/.claude.json`, `.mcp.json`, and
`claude_desktop_config.json`, so it supports headers exactly like the CLI. Use
any of the configurations above; nothing extra is needed.

**Chat surface** (and claude.ai web) — these use the custom connector UI, whose
only fields are the server URL and, under Advanced settings, an OAuth client id
and secret. There is no way to send a header, so put the key in the URL:

```
https://your-host/mcp?apiKey=YOUR_CONFETTI_API_KEY
```

Add it under Settings → Connectors → Add custom connector. Filters still work:

```
https://your-host/mcp?apiKey=YOUR_CONFETTI_API_KEY&ops=read
```

Prefer a header wherever the client allows one. A key in a URL is visible in
browser history, proxy logs, and anything that records request lines — the URL
forms exist because these two surfaces cannot do better, not because the
tradeoff is even.

## Authentication

In precedence order:

1. `Authorization: Bearer <key>` — recommended.
2. `X-Api-Key: <key>` — alias.
3. `?apiKey=<key>` — URL fallback, for clients that cannot set headers.
4. `POST /mcp/k/<key>` — the other URL fallback, for clients or proxies that
   handle a path segment better than a query parameter.

A malformed `Authorization` header is rejected rather than falling through to a
weaker carrier. An empty value in carriers 2–4 falls through to the next.

## Development

```bash
npm install
npm run lint
npm test
npm run build
npm run dev
```

## License

[MIT](LICENSE)
