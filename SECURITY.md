# Security Policy

`confetti-mcp` is a stateless MCP server that exposes the [Confetti](https://confetti.events)
API to MCP clients. Callers supply their own Confetti API key on each
connection; the server never stores keys server-side and holds no
per-user state — see the README's [How it works](README.md#how-it-works)
and [Authentication](README.md#authentication) sections for details.

## Reporting a vulnerability

Please do not open a public GitHub issue for security reports. Instead,
report privately to Devies Development via the org's GitHub security
advisories:

https://github.com/DeviesDevelopment/confetti-mcp/security/advisories/new

We'll acknowledge your report and follow up as we investigate.
