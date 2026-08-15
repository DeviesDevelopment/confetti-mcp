# confetti-mcp Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stateless remote MCP server that exposes all 63 Confetti API operations as generated tools, authenticates via the caller's own API key in an `Authorization: Bearer` header, and ships as a public Docker Hub image.

**Architecture:** An Express app wraps the MCP SDK's `StreamableHTTPServerTransport` in stateless mode — a fresh low-level `Server` per request, closing over that request's API key so keys cannot leak across requests. Tool definitions are generated once at startup by walking `Confetti`'s 18 static resource objects and pulling schemas, filters, sorts, and includes from `Confetti.models`. A dispatcher maps a tool name back to the right static method and calls it with `{ apiKey }`.

**Tech Stack:** TypeScript (ESM), Node 22 LTS, `@modelcontextprotocol/sdk` 1.30.0, `express` 5.2.1, `confetti` ^4.1.5. Tests: `node --test` via `tsx`, `nock` for upstream HTTP.

**Spec:** `docs/superpowers/specs/2026-08-15-confetti-mcp-design.md`

## Global Constraints

- Node engine: `>=22.12.0`. Docker base image `node:22-alpine`.
- ESM only (`"type": "module"`). All relative imports carry a `.js` extension, matching `confetti-node`.
- Package is **private** (`"private": true`) — this ships as a Docker image, not to npm.
- Docker image name: `deviesdevelopment/confetti-mcp`.
- The MCP endpoint path is `/mcp`. Server name reported to clients is `confetti-mcp`.
- **No API key is ever read from the server's own environment.** A server-side default key would be a multi-tenant footgun.
- **The API key must never appear in a log line, an error message returned to a client, or a stack trace.**
- Default page size for every `find_all` is `25`.
- License: MIT, `DeviesDevelopment`.

## Verified Facts (do not re-derive)

These were confirmed by running against `confetti@4.1.5`. Trust them.

- `Confetti` has exactly **18** static resource objects: `events, tickets, contacts, payments, workspaces, webhooks, categories, ticketBatches, pages, blocks, images, forms, formFields, speakers, organisers, scheduleItems, sponsors, sponsorLevels`.
- Their method keys sum to exactly **63** operations.
- `models` has **21** keys; the 3 with no static resource are `imageUpload`, `addon`, `previewToken`.
- **`model.operations` never contains a `delete` key**, yet `Confetti.pages.delete` exists. Tool existence is therefore driven by the **static resource object's keys**, never by `model.operations`. The registry supplies *schemas* only.
- **Only `ticket` has non-empty `model.sorting`** (7 entries). Every other model is `[]`.
- 10 of 18 models have **zero** filters; 13 of 18 have **zero** includes.
- `model.endpoint` is inconsistent (`formFields` camelCase vs `image-uploads` kebab) and must **not** be used to look up static resources.
- `confetti-node` does **not** export its error classes. Classify by `error.name`.
- `McpServer.registerTool` accepts Zod only (`AnySchema = z3.ZodTypeAny | z4.$ZodType`). Generated JSON Schema requires the **low-level `Server`** class.

## Spec Deviation

The spec's §5 says create/update inputs are generated "with relationship fields stripped". **Do not strip them.** `EventCreateSchema` includes `workspaceId`, and `event.relationships` names `workspaceId` — stripping it would make it impossible to say which workspace a new event belongs to. `stripFields` exists for Confetti's own form rendering, not for an API surface. Pass the create/update schemas through unstripped.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/config.ts` | Read and validate `PORT`, `CONFETTI_API_HOST`, `CONFETTI_API_PROTOCOL`, `LOG_LEVEL` |
| `src/confetti/resource-map.ts` | The explicit 18-entry model-key → static-resource map |
| `src/tools/names.ts` | `camelToSnake`, `toolName` |
| `src/tools/definitions.ts` | Build the 63 MCP tool definitions from the registry |
| `src/tools/filter.ts` | Parse `?ops=` / `?resources=` and select a tool subset |
| `src/tools/dispatch.ts` | Call the right static method for a tool name |
| `src/tools/errors.ts` | Map thrown errors to MCP `isError` results |
| `src/server/mcp.ts` | Build a low-level `Server` bound to one API key + tool set |
| `src/server/auth.ts` | Extract the API key from header / alias / path |
| `src/server/app.ts` | Express app: `GET /`, `POST /mcp`, `POST /mcp/k/:apiKey` |
| `src/main.ts` | Entry point — bind and listen |

---

### Task 1: Project scaffold and health endpoint

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.nvmrc`, `LICENSE`, `eslint.config.js`, `prettier.config.js`
- Create: `src/config.ts`, `src/server/app.ts`, `src/main.ts`
- Test: `test/server/health.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config` where `Config = { port: number; apiHost: string; apiProtocol: string; logLevel: string }`. `createApp(config: Config): express.Express`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "confetti-mcp",
  "version": "0.1.0",
  "description": "MCP server for the Confetti API",
  "type": "module",
  "private": true,
  "license": "MIT",
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "clean": "rm -rf dist",
    "build": "npm run clean && tsc -p tsconfig.json",
    "start": "node dist/main.js",
    "dev": "tsx watch src/main.ts",
    "test": "node --import=tsx --test test/**/*.ts",
    "lint": "eslint . && tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "confetti": "^4.1.5",
    "express": "5.2.1"
  },
  "devDependencies": {
    "@eslint/js": "9.36.0",
    "@types/express": "5.0.0",
    "@types/node": "22.14.0",
    "@typescript-eslint/eslint-plugin": "8.44.0",
    "@typescript-eslint/parser": "8.44.0",
    "eslint": "9.36.0",
    "nock": "14.0.10",
    "prettier": "3.6.2",
    "tsx": "4.6.0",
    "typescript": "5.9.3"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `.gitignore`, `.nvmrc`, `prettier.config.js`, `eslint.config.js`**

`.gitignore`:
```
node_modules
dist
*.log
.env
```

`.nvmrc`:
```
22.12.0
```

`prettier.config.js`:
```js
export default {
  semi: false,
  singleQuote: true,
  printWidth: 120,
  trailingComma: 'all',
}
```

`eslint.config.js`:
```js
import js from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  { ignores: ['dist/**', 'node_modules/**'] },
]
```

- [ ] **Step 4: Create `LICENSE`**

Standard MIT text, copyright line: `Copyright (c) 2026 Devies Development AB`.

- [ ] **Step 5: Run `npm install`**

Run: `npm install`
Expected: completes, `node_modules` populated, `package-lock.json` created.

- [ ] **Step 6: Write the failing test**

Create `test/server/health.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/config.js'

test('GET / reports server identity', async () => {
  const app = createApp(loadConfig({}))
  const server = app.listen(0)
  const { port } = server.address() as { port: number }

  const res = await fetch(`http://127.0.0.1:${port}/`)
  const body = await res.json()

  assert.equal(res.status, 200)
  assert.equal(body.status, 'ok')
  assert.equal(body.server, 'confetti-mcp')
  assert.equal(typeof body.version, 'string')
  assert.match(body.usage, /Authorization: Bearer/)

  server.close()
})

test('loadConfig applies defaults', () => {
  const config = loadConfig({})
  assert.equal(config.port, 8080)
  assert.equal(config.apiHost, 'api.confetti.events')
  assert.equal(config.apiProtocol, 'https')
})

test('loadConfig reads overrides from env', () => {
  const config = loadConfig({ PORT: '3000', CONFETTI_API_HOST: 'staging.confetti.events' })
  assert.equal(config.port, 3000)
  assert.equal(config.apiHost, 'staging.confetti.events')
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../../src/server/app.js`.

- [ ] **Step 8: Write `src/config.ts`**

```ts
export interface Config {
  port: number
  apiHost: string
  apiProtocol: string
  logLevel: string
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: Number(env['PORT'] ?? 8080),
    apiHost: env['CONFETTI_API_HOST'] ?? 'api.confetti.events',
    apiProtocol: env['CONFETTI_API_PROTOCOL'] ?? 'https',
    logLevel: env['LOG_LEVEL'] ?? 'info',
  }
}
```

- [ ] **Step 9: Write `src/server/app.ts`**

```ts
import express from 'express'
import type { Config } from '../config.js'

export const SERVER_NAME = 'confetti-mcp'
export const SERVER_VERSION = '0.1.0'

export function createApp(_config: Config): express.Express {
  const app = express()
  app.use(express.json({ limit: '4mb' }))

  app.get('/', (_req, res) => {
    res.json({
      status: 'ok',
      server: SERVER_NAME,
      version: SERVER_VERSION,
      usage: 'POST /mcp with an "Authorization: Bearer <confetti-api-key>" header.',
    })
  })

  return app
}
```

- [ ] **Step 10: Write `src/main.ts`**

```ts
import { createApp } from './server/app.js'
import { loadConfig } from './config.js'

const config = loadConfig(process.env)
const app = createApp(config)

app.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', msg: 'listening', port: config.port }))
})
```

- [ ] **Step 11: Run tests to verify they pass**

Run: `npm test`
Expected: 3 tests PASS.

- [ ] **Step 12: Verify lint passes**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: project scaffold with health endpoint"
```

---

### Task 2: API key extraction

**Files:**
- Create: `src/server/auth.ts`
- Test: `test/server/auth.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractApiKey(req: { headers: Record<string, unknown>; params?: Record<string, string>; query?: Record<string, unknown> }): string | undefined`.

Four carriers, in precedence order: `Authorization: Bearer`, `X-Api-Key`,
`?apiKey=`, then the `:apiKey` path segment. The two URL-carried fallbacks exist
because Claude Desktop's chat surface and claude.ai web use the custom-connector
UI, which accepts only a URL plus optional OAuth credentials — no headers.
Desktop's Code tab reads `.mcp.json` and handles headers natively.

A present-but-malformed `Authorization` header returns `undefined` rather than
falling through; an empty value in any other carrier falls through to the next.

- [ ] **Step 1: Write the failing test**

Create `test/server/auth.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractApiKey } from '../../src/server/auth.js'

test('reads Authorization Bearer header', () => {
  assert.equal(extractApiKey({ headers: { authorization: 'Bearer sk_abc' } }), 'sk_abc')
})

test('Bearer scheme is case-insensitive', () => {
  assert.equal(extractApiKey({ headers: { authorization: 'bearer sk_abc' } }), 'sk_abc')
})

test('reads X-Api-Key header', () => {
  assert.equal(extractApiKey({ headers: { 'x-api-key': 'sk_xyz' } }), 'sk_xyz')
})

test('reads apiKey query parameter', () => {
  assert.equal(extractApiKey({ headers: {}, query: { apiKey: 'sk_query' } }), 'sk_query')
})

test('reads apiKey path param', () => {
  assert.equal(extractApiKey({ headers: {}, params: { apiKey: 'sk_path' } }), 'sk_path')
})

test('Authorization wins over X-Api-Key, query, and path', () => {
  const key = extractApiKey({
    headers: { authorization: 'Bearer sk_header', 'x-api-key': 'sk_alias' },
    query: { apiKey: 'sk_query' },
    params: { apiKey: 'sk_path' },
  })
  assert.equal(key, 'sk_header')
})

test('X-Api-Key wins over the query parameter', () => {
  const key = extractApiKey({ headers: { 'x-api-key': 'sk_alias' }, query: { apiKey: 'sk_query' } })
  assert.equal(key, 'sk_alias')
})

test('query parameter wins over the path param', () => {
  const key = extractApiKey({ headers: {}, query: { apiKey: 'sk_query' }, params: { apiKey: 'sk_path' } })
  assert.equal(key, 'sk_query')
})

test('a repeated apiKey query parameter takes the first value', () => {
  assert.equal(extractApiKey({ headers: {}, query: { apiKey: ['sk_one', 'sk_two'] } }), 'sk_one')
})

test('an empty apiKey query parameter falls through to the path param', () => {
  const key = extractApiKey({ headers: {}, query: { apiKey: '  ' }, params: { apiKey: 'sk_path' } })
  assert.equal(key, 'sk_path')
})

test('X-Api-Key wins over path', () => {
  const key = extractApiKey({ headers: { 'x-api-key': 'sk_alias' }, params: { apiKey: 'sk_path' } })
  assert.equal(key, 'sk_alias')
})

test('returns undefined when absent', () => {
  assert.equal(extractApiKey({ headers: {} }), undefined)
})

test('returns undefined for a Bearer header with no token', () => {
  assert.equal(extractApiKey({ headers: { authorization: 'Bearer ' } }), undefined)
})

test('ignores a non-Bearer Authorization scheme', () => {
  assert.equal(extractApiKey({ headers: { authorization: 'Basic dXNlcjpwYXNz' } }), undefined)
})

test('trims surrounding whitespace', () => {
  assert.equal(extractApiKey({ headers: { 'x-api-key': '  sk_pad  ' } }), 'sk_pad')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import=tsx --test test/server/auth.ts`
Expected: FAIL — cannot find module `../../src/server/auth.js`.

- [ ] **Step 3: Write `src/server/auth.ts`**

```ts
export interface ApiKeyCarrier {
  headers: Record<string, unknown>
  params?: Record<string, string>
  query?: Record<string, unknown>
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Extracts the caller's Confetti API key.
 *
 * Precedence: Authorization: Bearer, then X-Api-Key, then ?apiKey=, then the
 * :apiKey path segment. The two URL-carried forms exist for clients that cannot
 * set headers — Claude Desktop's chat surface and claude.ai web both use the
 * custom-connector UI, which accepts only a URL and optional OAuth credentials.
 * Both are documented as second-class.
 */
export function extractApiKey(req: ApiKeyCarrier): string | undefined {
  const authorization = clean(firstString(req.headers['authorization']))
  if (authorization) {
    // A present but malformed Authorization header is an error, not an
    // invitation to try a weaker carrier.
    const match = /^Bearer[ ]+(.+)$/i.exec(authorization)
    return clean(match?.[1])
  }

  const alias = clean(firstString(req.headers['x-api-key']))
  if (alias) return alias

  const query = clean(firstString(req.query?.['apiKey']))
  if (query) return query

  return clean(req.params?.['apiKey'])
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import=tsx --test test/server/auth.ts`
Expected: 15 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: extract API key from header, alias, or path"
```

---

### Task 3: Resource map with registry drift guards

**Files:**
- Create: `src/confetti/resource-map.ts`
- Test: `test/confetti/resource-map.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RESOURCE_MAP: Record<ModelKey, ResourceName>`, `OPERATIONS: readonly ['findAll','find','create','update','delete']`, `resourceFor(modelKey: string): Record<string, unknown>`, `listResourceOperations(): Array<{ modelKey: string; resourceName: string; operation: string }>`.

The tests here are the ones that catch upstream drift. They are the reason this task exists separately.

- [ ] **Step 1: Write the failing test**

Create `test/confetti/resource-map.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Confetti from 'confetti'
import { RESOURCE_MAP, listResourceOperations } from '../../src/confetti/resource-map.js'

const STATIC_EXCLUDES = new Set(['length', 'name', 'prototype', 'models'])

function staticResourceNames(): string[] {
  return Object.getOwnPropertyNames(Confetti).filter((k) => !STATIC_EXCLUDES.has(k))
}

test('every mapped resource name exists on Confetti', () => {
  for (const [modelKey, resourceName] of Object.entries(RESOURCE_MAP)) {
    const resource = (Confetti as unknown as Record<string, unknown>)[resourceName]
    assert.ok(resource, `${modelKey} -> Confetti.${resourceName} is missing`)
  }
})

test('every static resource on Confetti is mapped', () => {
  const mapped = new Set(Object.values(RESOURCE_MAP))
  for (const name of staticResourceNames()) {
    assert.ok(mapped.has(name), `Confetti.${name} is not in RESOURCE_MAP`)
  }
})

test('every mapped model key exists in Confetti.models', () => {
  for (const modelKey of Object.keys(RESOURCE_MAP)) {
    assert.ok(modelKey in Confetti.models, `models.${modelKey} is missing`)
  }
})

test('maps exactly 18 resources', () => {
  assert.equal(Object.keys(RESOURCE_MAP).length, 18)
})

test('enumerates exactly 63 operations', () => {
  assert.equal(listResourceOperations().length, 63)
})

test('operation counts per verb match the spec', () => {
  const byVerb = listResourceOperations().reduce<Record<string, number>>((acc, op) => {
    acc[op.operation] = (acc[op.operation] ?? 0) + 1
    return acc
  }, {})
  assert.deepEqual(byVerb, { find: 18, findAll: 11, create: 13, update: 11, delete: 10 })
})

test('every create/update operation has a schema in the registry', () => {
  for (const { modelKey, operation } of listResourceOperations()) {
    if (operation !== 'create' && operation !== 'update') continue
    const model = (Confetti.models as unknown as Record<string, { operations: Record<string, unknown> }>)[modelKey]
    assert.ok(model?.operations[operation], `models.${modelKey}.operations.${operation} is missing`)
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import=tsx --test test/confetti/resource-map.ts`
Expected: FAIL — cannot find module `../../src/confetti/resource-map.js`.

- [ ] **Step 3: Write `src/confetti/resource-map.ts`**

```ts
import Confetti from 'confetti'

/**
 * Model key -> the name of the matching static resource object on Confetti.
 *
 * This is written out by hand on purpose. `model.endpoint` looks like it would
 * work, but the registry mixes camelCase (`formFields`) with kebab-case
 * (`image-uploads`); it only lines up today because the three kebab-cased
 * models happen to be the three with no static resource. Deriving the name
 * would fail silently on an upstream rename. An explicit map fails loudly, and
 * the tests in test/confetti/resource-map.ts assert both directions.
 */
export const RESOURCE_MAP = {
  event: 'events',
  ticket: 'tickets',
  contact: 'contacts',
  payment: 'payments',
  workspace: 'workspaces',
  webhook: 'webhooks',
  category: 'categories',
  ticketBatch: 'ticketBatches',
  page: 'pages',
  block: 'blocks',
  image: 'images',
  form: 'forms',
  formField: 'formFields',
  speaker: 'speakers',
  organiser: 'organisers',
  scheduleItem: 'scheduleItems',
  sponsor: 'sponsors',
  sponsorLevel: 'sponsorLevels',
} as const satisfies Record<string, string>

export type ModelKey = keyof typeof RESOURCE_MAP

export const OPERATIONS = ['findAll', 'find', 'create', 'update', 'delete'] as const
export type Operation = (typeof OPERATIONS)[number]

export type ResourceMethods = Record<string, (...args: never[]) => Promise<unknown>>

export function resourceFor(modelKey: ModelKey): ResourceMethods {
  const resource = (Confetti as unknown as Record<string, ResourceMethods>)[RESOURCE_MAP[modelKey]]
  if (!resource) throw new Error(`No Confetti resource for model "${modelKey}"`)
  return resource
}

export interface ResourceOperation {
  modelKey: ModelKey
  resourceName: string
  operation: Operation
}

/**
 * Every (resource, operation) pair that actually exists, driven by the static
 * resource object's own keys. `model.operations` is NOT the source of truth
 * here — it has no `delete` key for any model even where `.delete()` exists.
 */
export function listResourceOperations(): ResourceOperation[] {
  const result: ResourceOperation[] = []
  for (const modelKey of Object.keys(RESOURCE_MAP) as ModelKey[]) {
    const resource = resourceFor(modelKey)
    for (const operation of OPERATIONS) {
      if (typeof resource[operation] === 'function') {
        result.push({ modelKey, resourceName: RESOURCE_MAP[modelKey], operation })
      }
    }
  }
  return result
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import=tsx --test test/confetti/resource-map.ts`
Expected: 7 tests PASS. The 63 and the per-verb breakdown must both match exactly.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: explicit resource map with registry drift guards"
```

---

### Task 4: Tool naming

**Files:**
- Create: `src/tools/names.ts`
- Test: `test/tools/names.ts`

**Interfaces:**
- Consumes: `Operation` from `src/confetti/resource-map.js`.
- Produces: `camelToSnake(value: string): string`, `toolName(resourceName: string, operation: Operation): string`.

- [ ] **Step 1: Write the failing test**

Create `test/tools/names.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { camelToSnake, toolName } from '../../src/tools/names.js'

test('camelToSnake converts camelCase', () => {
  assert.equal(camelToSnake('sponsorLevels'), 'sponsor_levels')
  assert.equal(camelToSnake('formFields'), 'form_fields')
  assert.equal(camelToSnake('ticketBatches'), 'ticket_batches')
  assert.equal(camelToSnake('scheduleItems'), 'schedule_items')
  assert.equal(camelToSnake('findAll'), 'find_all')
})

test('camelToSnake leaves single words alone', () => {
  assert.equal(camelToSnake('events'), 'events')
  assert.equal(camelToSnake('find'), 'find')
})

test('toolName composes the prefixed name', () => {
  assert.equal(toolName('events', 'findAll'), 'confetti_events_find_all')
  assert.equal(toolName('sponsorLevels', 'delete'), 'confetti_sponsor_levels_delete')
  assert.equal(toolName('forms', 'find'), 'confetti_forms_find')
})

test('every generated name is a legal MCP tool name', () => {
  const name = toolName('scheduleItems', 'update')
  assert.match(name, /^[a-zA-Z0-9_-]{1,128}$/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import=tsx --test test/tools/names.ts`
Expected: FAIL — cannot find module `../../src/tools/names.js`.

- [ ] **Step 3: Write `src/tools/names.ts`**

```ts
import type { Operation } from '../confetti/resource-map.js'

export function camelToSnake(value: string): string {
  return value.replace(/([A-Z])/g, '_$1').toLowerCase()
}

export function toolName(resourceName: string, operation: Operation): string {
  return `confetti_${camelToSnake(resourceName)}_${camelToSnake(operation)}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import=tsx --test test/tools/names.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: tool name generation"
```

---

### Task 5: Tool definition generation

**Files:**
- Create: `src/tools/definitions.ts`
- Test: `test/tools/definitions.ts`

**Interfaces:**
- Consumes: `listResourceOperations`, `ModelKey`, `Operation` from `src/confetti/resource-map.js`; `toolName` from `src/tools/names.js`.
- Produces:
  - `interface ToolDefinition { name: string; description: string; inputSchema: JsonSchemaObject; annotations: ToolAnnotations }`
  - `interface JsonSchemaObject { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }`
  - `interface GeneratedTool { definition: ToolDefinition; modelKey: ModelKey; operation: Operation }`
  - `buildTools(): GeneratedTool[]`

- [ ] **Step 1: Write the failing test**

Create `test/tools/definitions.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTools } from '../../src/tools/definitions.js'

const tools = buildTools()
const byName = new Map(tools.map((t) => [t.definition.name, t]))

test('generates exactly 63 tools', () => {
  assert.equal(tools.length, 63)
})

test('tool names are unique', () => {
  assert.equal(byName.size, 63)
})

test('every tool has a non-empty description and an object input schema', () => {
  for (const tool of tools) {
    assert.ok(tool.definition.description.length > 0, `${tool.definition.name} has no description`)
    assert.equal(tool.definition.inputSchema.type, 'object')
  }
})

test('events_create exposes the create schema including workspaceId', () => {
  const tool = byName.get('confetti_events_create')
  assert.ok(tool)
  const props = tool.definition.inputSchema.properties
  assert.ok('name' in props)
  assert.ok('startDate' in props)
  assert.ok('workspaceId' in props, 'workspaceId must NOT be stripped')
  assert.deepEqual(tool.definition.inputSchema.required, ['name', 'startDate'])
})

test('events_update requires id alongside the update fields', () => {
  const tool = byName.get('confetti_events_update')
  assert.ok(tool)
  assert.ok('id' in tool.definition.inputSchema.properties)
  assert.ok(tool.definition.inputSchema.required?.includes('id'))
})

test('update tools require only id, never the body schema required fields', () => {
  for (const tool of tools) {
    if (tool.operation !== 'update') continue
    assert.deepEqual(
      tool.definition.inputSchema.required,
      ['id'],
      `${tool.definition.name} must require only id`,
    )
  }
})

test('tickets_find_all exposes a sort enum because ticket has sorting', () => {
  const tool = byName.get('confetti_tickets_find_all')
  assert.ok(tool)
  const sort = tool.definition.inputSchema.properties['sort'] as { enum?: string[] } | undefined
  assert.ok(sort, 'tickets should expose sort')
  assert.ok(sort.enum?.includes('createdAt'))
})

test('events_find_all omits sort because event has no sorting', () => {
  const tool = byName.get('confetti_events_find_all')
  assert.ok(tool)
  assert.equal(tool.definition.inputSchema.properties['sort'], undefined)
})

test('events_find_all exposes filter and include', () => {
  const tool = byName.get('confetti_events_find_all')
  assert.ok(tool)
  const filter = tool.definition.inputSchema.properties['filter'] as
    | { properties?: Record<string, { enum?: string[] }> }
    | undefined
  assert.ok(filter?.properties?.['signupType'])
  assert.deepEqual(filter.properties['signupType'].enum, ['rsvp', 'tickets'])

  const include = tool.definition.inputSchema.properties['include'] as
    | { items?: { enum?: string[] } }
    | undefined
  assert.ok(include?.items?.enum?.includes('categories'))
})

test('contacts_find_all omits filter because contact has no filters', () => {
  const tool = byName.get('confetti_contacts_find_all')
  assert.ok(tool)
  assert.equal(tool.definition.inputSchema.properties['filter'], undefined)
})

test('find and delete tools take id', () => {
  for (const name of ['confetti_forms_find', 'confetti_pages_delete']) {
    const tool = byName.get(name)
    assert.ok(tool, `${name} missing`)
    assert.ok('id' in tool.definition.inputSchema.properties)
    assert.deepEqual(tool.definition.inputSchema.required, ['id'])
  }
})

test('every find_all exposes page', () => {
  for (const tool of tools) {
    if (tool.operation !== 'findAll') continue
    assert.ok('page' in tool.definition.inputSchema.properties, `${tool.definition.name} lacks page`)
  }
})

test('annotations mark reads, updates, and deletes correctly', () => {
  assert.equal(byName.get('confetti_events_find')?.definition.annotations.readOnlyHint, true)
  assert.equal(byName.get('confetti_events_find_all')?.definition.annotations.readOnlyHint, true)
  assert.equal(byName.get('confetti_pages_delete')?.definition.annotations.destructiveHint, true)
  assert.equal(byName.get('confetti_events_update')?.definition.annotations.idempotentHint, true)
  assert.equal(byName.get('confetti_events_create')?.definition.annotations.readOnlyHint, false)
})

test('exactly 10 tools are marked destructive', () => {
  const destructive = tools.filter((t) => t.definition.annotations.destructiveHint === true)
  assert.equal(destructive.length, 10)
})

test('descriptions embed a sample payload for read tools', () => {
  const tool = byName.get('confetti_events_find')
  assert.ok(tool)
  assert.match(tool.definition.description, /Example/)
  assert.match(tool.definition.description, /startDate/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import=tsx --test test/tools/definitions.ts`
Expected: FAIL — cannot find module `../../src/tools/definitions.js`.

- [ ] **Step 3: Write `src/tools/definitions.ts`**

```ts
import Confetti from 'confetti'
import { schemaToJsonSchema, filterToJsonSchema } from 'confetti'
import type { ModelDefinition } from 'confetti'
import { listResourceOperations, type ModelKey, type Operation } from '../confetti/resource-map.js'
import { toolName } from './names.js'

export interface JsonSchemaObject {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export interface ToolAnnotations {
  title: string
  readOnlyHint: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchemaObject
  annotations: ToolAnnotations
}

export interface GeneratedTool {
  definition: ToolDefinition
  modelKey: ModelKey
  operation: Operation
}

const ID_SCHEMA = { type: ['string', 'number'], description: 'Identifier of the record.' }

const PAGE_SCHEMA = {
  type: 'object',
  description: 'JSON:API pagination. Defaults to a page size of 25 when omitted.',
  properties: {
    number: { type: 'number', description: 'Page number, 1-based.' },
    size: { type: 'number', description: 'Records per page. Defaults to 25.' },
    offset: { type: 'number' },
    limit: { type: 'number' },
  },
}

function model(modelKey: ModelKey): ModelDefinition {
  return (Confetti.models as unknown as Record<ModelKey, ModelDefinition>)[modelKey]
}

function sampleFor(m: ModelDefinition): string {
  const sample = m.sample?.single?.formatted
  if (!sample) return ''
  return `\n\nExample record:\n${JSON.stringify(sample, null, 2)}`
}

function findAllSchema(m: ModelDefinition): JsonSchemaObject {
  const properties: Record<string, unknown> = {}

  const filterKeys = Object.keys(m.filters)
  if (filterKeys.length > 0) {
    const filterProps: Record<string, unknown> = {}
    for (const [key, filter] of Object.entries(m.filters)) {
      filterProps[key] = filterToJsonSchema(filter)
    }
    properties['filter'] = {
      type: 'object',
      description: `Filters for ${m.name} records.`,
      properties: filterProps,
    }
  }

  if (m.sorting.length > 0) {
    properties['sort'] = {
      type: 'string',
      description: 'Field to sort by. Prefix with "-" for descending order.',
      enum: m.sorting,
    }
  }

  if (m.includes.length > 0) {
    properties['include'] = {
      type: 'array',
      description: 'Related resources to side-load into the response.',
      items: { type: 'string', enum: m.includes },
    }
  }

  properties['page'] = PAGE_SCHEMA

  return { type: 'object', properties }
}

function findSchema(m: ModelDefinition): JsonSchemaObject {
  const properties: Record<string, unknown> = { id: ID_SCHEMA }
  if (m.includes.length > 0) {
    properties['include'] = {
      type: 'array',
      description: 'Related resources to side-load into the response.',
      items: { type: 'string', enum: m.includes },
    }
  }
  return { type: 'object', properties, required: ['id'] }
}

function bodySchema(m: ModelDefinition, operation: 'create' | 'update'): JsonSchemaObject {
  const config = m.operations[operation]
  if (!config) throw new Error(`models.${m.key}.operations.${operation} is missing`)
  // Deliberately NOT stripping relationship fields: workspaceId and friends
  // must stay settable, or records cannot be attached to their parent.
  const generated = schemaToJsonSchema(config.schema) as unknown as JsonSchemaObject
  return {
    type: 'object',
    properties: { ...generated.properties },
    ...(generated.required ? { required: [...generated.required] } : {}),
  }
}

function updateSchema(m: ModelDefinition): JsonSchemaObject {
  const body = bodySchema(m, 'update')
  return {
    type: 'object',
    properties: { id: ID_SCHEMA, ...body.properties },
    // Only the identifier is required. A partial update must never mandate
    // fields beyond it — inheriting the body schema's required list would force
    // callers to resupply fields they aren't changing.
    required: ['id'],
  }
}

function deleteSchema(): JsonSchemaObject {
  return { type: 'object', properties: { id: ID_SCHEMA }, required: ['id'] }
}

function schemaFor(m: ModelDefinition, operation: Operation): JsonSchemaObject {
  switch (operation) {
    case 'findAll':
      return findAllSchema(m)
    case 'find':
      return findSchema(m)
    case 'create':
      return bodySchema(m, 'create')
    case 'update':
      return updateSchema(m)
    case 'delete':
      return deleteSchema()
  }
}

function describe(m: ModelDefinition, operation: Operation): string {
  const noun = m.name
  switch (operation) {
    case 'findAll':
      return `List ${noun} records from Confetti.${sampleFor(m)}`
    case 'find':
      return `Fetch a single ${noun} from Confetti by id.${sampleFor(m)}`
    case 'create':
      return `Create a new ${noun} in Confetti.`
    case 'update':
      return `Update an existing ${noun} in Confetti by id. Only the fields you pass are changed.`
    case 'delete':
      return `Permanently delete a ${noun} from Confetti by id. This cannot be undone.`
  }
}

function annotate(m: ModelDefinition, operation: Operation, name: string): ToolAnnotations {
  const readOnly = operation === 'find' || operation === 'findAll'
  return {
    title: name,
    readOnlyHint: readOnly,
    ...(operation === 'delete' ? { destructiveHint: true } : {}),
    ...(operation === 'update' || operation === 'delete' ? { idempotentHint: true } : {}),
    ...(operation === 'create' ? { destructiveHint: false } : {}),
  }
}

export function buildTools(): GeneratedTool[] {
  return listResourceOperations().map(({ modelKey, resourceName, operation }) => {
    const m = model(modelKey)
    const name = toolName(resourceName, operation)
    return {
      modelKey,
      operation,
      definition: {
        name,
        description: describe(m, operation),
        inputSchema: schemaFor(m, operation),
        annotations: annotate(m, operation, name),
      },
    }
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import=tsx --test test/tools/definitions.ts`
Expected: 15 tests PASS.

If `import type { ModelDefinition } from 'confetti'` fails to resolve, the type is re-exported through `confetti`'s `types/index.js` barrel; confirm with `node -e "import('confetti').then(m => console.log(Object.keys(m)))"` and adjust the import to the named export that exists.

- [ ] **Step 5: Verify lint passes**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: generate 63 MCP tool definitions from the Confetti registry"
```

---

### Task 6: Tool set filtering by ops and resources

**Files:**
- Create: `src/tools/filter.ts`
- Test: `test/tools/filter.ts`

**Interfaces:**
- Consumes: `GeneratedTool` from `src/tools/definitions.js`; `Operation`, `RESOURCE_MAP` from `src/confetti/resource-map.js`.
- Produces:
  - `class ToolFilterError extends Error { constructor(message: string) }`
  - `parseToolFilter(query: Record<string, unknown>): { operations?: Set<Operation>; resources?: Set<string> }`
  - `selectTools(all: GeneratedTool[], filter: ReturnType<typeof parseToolFilter>): GeneratedTool[]`
  - `toolSetCacheKey(query: Record<string, unknown>): string`

- [ ] **Step 1: Write the failing test**

Create `test/tools/filter.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTools } from '../../src/tools/definitions.js'
import { parseToolFilter, selectTools, ToolFilterError, toolSetCacheKey } from '../../src/tools/filter.js'

const all = buildTools()
const select = (query: Record<string, unknown>) => selectTools(all, parseToolFilter(query))

test('no query returns all 63 tools', () => {
  assert.equal(select({}).length, 63)
})

test('ops=read returns the 29 read tools', () => {
  const tools = select({ ops: 'read' })
  assert.equal(tools.length, 29)
  assert.ok(tools.every((t) => t.operation === 'find' || t.operation === 'findAll'))
})

test('ops=get is an alias for read', () => {
  assert.equal(select({ ops: 'get' }).length, 29)
})

test('ops=get,post,put returns 53 tools and excludes deletes', () => {
  const tools = select({ ops: 'get,post,put' })
  assert.equal(tools.length, 53)
  assert.ok(tools.every((t) => t.operation !== 'delete'))
})

test('ops=read,create,update matches the HTTP verb spelling', () => {
  assert.equal(select({ ops: 'read,create,update' }).length, 53)
})

test('ops=delete returns the 10 delete tools', () => {
  assert.equal(select({ ops: 'delete' }).length, 10)
})

test('resources filter narrows to the named resources', () => {
  const tools = select({ resources: 'events,tickets' })
  assert.equal(tools.length, 8)
  assert.ok(tools.every((t) => t.modelKey === 'event' || t.modelKey === 'ticket'))
})

test('resources accepts snake_case as well as camelCase', () => {
  assert.equal(select({ resources: 'sponsor_levels' }).length, select({ resources: 'sponsorLevels' }).length)
  assert.equal(select({ resources: 'sponsor_levels' }).length, 4)
})

test('resources and ops compose', () => {
  const tools = select({ resources: 'events', ops: 'read' })
  assert.equal(tools.length, 2)
})

test('whitespace and empty segments are tolerated', () => {
  assert.equal(select({ ops: ' read , , create ' }).length, 29 + 13)
})

test('an unknown op is rejected with the valid values listed', () => {
  assert.throws(
    () => parseToolFilter({ ops: 'frobnicate' }),
    (error: unknown) => {
      assert.ok(error instanceof ToolFilterError)
      assert.match(error.message, /frobnicate/)
      assert.match(error.message, /read/)
      return true
    },
  )
})

test('an unknown resource is rejected with the valid values listed', () => {
  assert.throws(
    () => parseToolFilter({ resources: 'unicorns' }),
    (error: unknown) => {
      assert.ok(error instanceof ToolFilterError)
      assert.match(error.message, /unicorns/)
      assert.match(error.message, /events/)
      return true
    },
  )
})

test('cache key is stable regardless of ordering or spacing', () => {
  assert.equal(toolSetCacheKey({ ops: 'create,read' }), toolSetCacheKey({ ops: ' read , create ' }))
  assert.notEqual(toolSetCacheKey({ ops: 'read' }), toolSetCacheKey({ ops: 'create' }))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import=tsx --test test/tools/filter.ts`
Expected: FAIL — cannot find module `../../src/tools/filter.js`.

- [ ] **Step 3: Write `src/tools/filter.ts`**

```ts
import { RESOURCE_MAP, type ModelKey, type Operation } from '../confetti/resource-map.js'
import { camelToSnake } from './names.js'
import type { GeneratedTool } from './definitions.js'

export class ToolFilterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolFilterError'
  }
}

/** Domain verbs plus their HTTP-verb aliases. `read` covers find and find_all. */
const OP_ALIASES: Record<string, Operation[]> = {
  read: ['find', 'findAll'],
  get: ['find', 'findAll'],
  create: ['create'],
  post: ['create'],
  update: ['update'],
  put: ['update'],
  patch: ['update'],
  delete: ['delete'],
}

const RESOURCE_LOOKUP: Record<string, ModelKey> = Object.fromEntries(
  (Object.keys(RESOURCE_MAP) as ModelKey[]).flatMap((modelKey) => {
    const resourceName = RESOURCE_MAP[modelKey]
    return [
      [resourceName.toLowerCase(), modelKey],
      [camelToSnake(resourceName), modelKey],
    ]
  }),
)

export interface ToolFilter {
  operations?: Set<Operation>
  resources?: Set<ModelKey>
}

function splitList(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return parts.length > 0 ? parts : undefined
}

export function parseToolFilter(query: Record<string, unknown>): ToolFilter {
  const filter: ToolFilter = {}

  const ops = splitList(query['ops'])
  if (ops) {
    const operations = new Set<Operation>()
    for (const op of ops) {
      const mapped = OP_ALIASES[op.toLowerCase()]
      if (!mapped) {
        throw new ToolFilterError(
          `Unknown op "${op}". Valid ops: ${Object.keys(OP_ALIASES).sort().join(', ')}.`,
        )
      }
      for (const operation of mapped) operations.add(operation)
    }
    filter.operations = operations
  }

  const resources = splitList(query['resources'])
  if (resources) {
    const selected = new Set<ModelKey>()
    for (const resource of resources) {
      const modelKey = RESOURCE_LOOKUP[resource.toLowerCase()]
      if (!modelKey) {
        throw new ToolFilterError(
          `Unknown resource "${resource}". Valid resources: ${Object.values(RESOURCE_MAP).sort().join(', ')}.`,
        )
      }
      selected.add(modelKey)
    }
    filter.resources = selected
  }

  return filter
}

export function selectTools(all: GeneratedTool[], filter: ToolFilter): GeneratedTool[] {
  return all.filter((tool) => {
    if (filter.operations && !filter.operations.has(tool.operation)) return false
    if (filter.resources && !filter.resources.has(tool.modelKey)) return false
    return true
  })
}

export function toolSetCacheKey(query: Record<string, unknown>): string {
  const normalise = (value: unknown) => (splitList(value) ?? []).map((v) => v.toLowerCase()).sort().join(',')
  return `ops=${normalise(query['ops'])}|resources=${normalise(query['resources'])}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import=tsx --test test/tools/filter.ts`
Expected: 13 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: filter the tool set by ops and resources"
```

---

### Task 7: Error mapping

**Files:**
- Create: `src/tools/errors.ts`
- Test: `test/tools/errors.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `toolErrorMessage(error: unknown, toolName: string, secret?: string): string`. The optional `secret` is the caller's API key, exact-matched out of the returned message; Task 9 must pass `options.context.apiKey`.

- [ ] **Step 1: Write the failing test**

Create `test/tools/errors.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolErrorMessage } from '../../src/tools/errors.js'

function named(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

test('maps ParameterError', () => {
  const message = toolErrorMessage(named('ParameterError', 'startDate is required'), 'confetti_events_create')
  assert.match(message, /Invalid parameters for 'confetti_events_create'/)
  assert.match(message, /startDate is required/)
})

test('maps NotFoundError', () => {
  const message = toolErrorMessage(named('NotFoundError', 'Event 99 not found'), 'confetti_events_find')
  assert.match(message, /Not found in 'confetti_events_find'/)
  assert.match(message, /Event 99 not found/)
})

test('maps OperationNotFoundError', () => {
  const message = toolErrorMessage(named('OperationNotFoundError', 'nope'), 'confetti_events_update')
  assert.match(message, /Unsupported operation 'confetti_events_update'/)
})

test('maps ZodError to the parameter shape', () => {
  const message = toolErrorMessage(named('ZodError', 'Expected string, received number'), 'confetti_events_create')
  assert.match(message, /Invalid parameters for 'confetti_events_create'/)
})

test('falls back for unknown errors and names the type', () => {
  const message = toolErrorMessage(named('TypeError', 'x is not a function'), 'confetti_events_find')
  assert.match(message, /Error in 'confetti_events_find'/)
  assert.match(message, /\[TypeError\]/)
  assert.match(message, /x is not a function/)
})

test('handles non-Error throwables', () => {
  const message = toolErrorMessage('a bare string', 'confetti_events_find')
  assert.match(message, /Error in 'confetti_events_find'/)
  assert.match(message, /a bare string/)
})

test('never echoes an api-key-shaped token that appears in the message', () => {
  const message = toolErrorMessage(named('ParameterError', 'bad key sk_live_secret123'), 'confetti_events_find')
  assert.ok(!message.includes('sk_live_secret123'), 'api-key-shaped tokens must be redacted')
  assert.match(message, /\[redacted\]/)
})

test('redacts the caller api key exactly, whatever its shape', () => {
  const message = toolErrorMessage(named('ParameterError', 'rejected key my-key here'), 'confetti_events_find', 'my-key')
  assert.ok(!message.includes('my-key'), 'the caller key must not survive into the message')
  assert.match(message, /\[redacted\]/)
})

test('redacts every occurrence of the caller api key', () => {
  const message = toolErrorMessage(named('ParameterError', 'my-key then my-key again'), 'confetti_events_find', 'my-key')
  assert.ok(!message.includes('my-key'))
})

test('redacts the caller key even from an unclassified error', () => {
  const message = toolErrorMessage(named('TypeError', 'boom my-key'), 'confetti_events_find', 'my-key')
  assert.ok(!message.includes('my-key'))
  assert.match(message, /\[TypeError\]/)
})

test('an empty or trivially short secret does not corrupt the message', () => {
  assert.match(toolErrorMessage(named('ParameterError', 'plain failure'), 'confetti_events_find', ''), /plain failure/)
  assert.match(toolErrorMessage(named('ParameterError', 'plain failure'), 'confetti_events_find', 'ab'), /plain failure/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import=tsx --test test/tools/errors.ts`
Expected: FAIL — cannot find module `../../src/tools/errors.js`.

- [ ] **Step 3: Write `src/tools/errors.ts`**

```ts
/**
 * `confetti-node` does not export its error classes — src/errors.ts is absent
 * from the package entry point and `exports` only exposes ".". Every error it
 * throws does set `name`, so classification goes by that instead of instanceof.
 */

/**
 * Redacts the caller's key, plus anything shaped like one, before it reaches a
 * client. Confetti enforces no key format (`apiKey: z.string()`), so the shape
 * pattern is only a secondary net — exact-matching the caller's own key is what
 * actually holds the "key never reaches a client" constraint.
 */
function redact(text: string, secret?: string): string {
  const byShape = text.replace(/\bsk_[A-Za-z0-9_-]{4,}/g, '[redacted]')
  // Guard the length: replaceAll('') inserts between every character.
  if (!secret || secret.length < 4) return byShape
  return byShape.replaceAll(secret, '[redacted]')
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

export function toolErrorMessage(error: unknown, toolName: string, secret?: string): string {
  const detail = messageOf(error)
  const name = nameOf(error)

  let message: string
  switch (name) {
    case 'ParameterError':
    case 'ZodError':
      message = `Invalid parameters for '${toolName}': ${detail}`
      break
    case 'NotFoundError':
      message = `Not found in '${toolName}': ${detail}`
      break
    case 'OperationNotFoundError':
      message = `Unsupported operation '${toolName}': ${detail}`
      break
    default:
      message = `Error in '${toolName}': [${name}] ${detail}`
  }

  // Redact the assembled message, not just the detail, so nothing reaching the
  // output via the error's name can bypass it.
  return redact(message, secret)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import=tsx --test test/tools/errors.ts`
Expected: 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: map Confetti errors to MCP tool error messages"
```

---

### Task 8: Tool dispatch

**Files:**
- Create: `src/tools/dispatch.ts`
- Test: `test/tools/dispatch.ts`

**Interfaces:**
- Consumes: `GeneratedTool` from `src/tools/definitions.js`; `resourceFor` from `src/confetti/resource-map.js`.
- Produces: `DEFAULT_PAGE_SIZE: 25`, `callTool(tool: GeneratedTool, args: Record<string, unknown>, context: { apiKey: string; apiHost?: string; apiProtocol?: string }): Promise<unknown>`.

The five static methods have five different arities:
`findAll(options)`, `find(id, options)`, `create(json, options)`, `update(id, json, options)`, `delete(id, options)`.

- [ ] **Step 1: Write the failing test**

Create `test/tools/dispatch.ts`:

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import nock from 'nock'
import { buildTools } from '../../src/tools/definitions.js'
import { callTool, DEFAULT_PAGE_SIZE } from '../../src/tools/dispatch.js'

const API = 'https://api.confetti.events'
const tools = new Map(buildTools().map((t) => [t.definition.name, t]))
const context = { apiKey: 'sk_test_key' }

function tool(name: string) {
  const found = tools.get(name)
  assert.ok(found, `${name} not generated`)
  return found
}

afterEach(() => {
  nock.cleanAll()
})

test('find_all sends the api key as an apikey Authorization header', async () => {
  const scope = nock(API, { reqheaders: { authorization: 'apikey sk_test_key' } })
    .get('/events')
    .query(true)
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  await callTool(tool('confetti_events_find_all'), {}, context)
  scope.done()
})

test('find_all applies the default page size', async () => {
  const scope = nock(API)
    .get('/events')
    .query((q) => q['page[size]'] === String(DEFAULT_PAGE_SIZE))
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  await callTool(tool('confetti_events_find_all'), {}, context)
  scope.done()
})

test('an explicit page size overrides the default', async () => {
  const scope = nock(API)
    .get('/events')
    .query((q) => q['page[size]'] === '100')
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  await callTool(tool('confetti_events_find_all'), { page: { size: 100 } }, context)
  scope.done()
})

test('find_all forwards filters', async () => {
  const scope = nock(API)
    .get('/events')
    .query((q) => q['filter[signupType]'] === 'rsvp')
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  await callTool(tool('confetti_events_find_all'), { filter: { signupType: 'rsvp' } }, context)
  scope.done()
})

test('find requests the record by id', async () => {
  const scope = nock(API)
    .get('/events/42')
    .query(true)
    .reply(200, { data: { id: '42', type: 'events', attributes: { name: 'Kickoff' } } }, {
      'content-type': 'application/json',
    })

  const result = (await callTool(tool('confetti_events_find'), { id: 42 }, context)) as { name?: string }
  assert.equal(result.name, 'Kickoff')
  scope.done()
})

test('create posts the whole argument object as the body', async () => {
  const scope = nock(API)
    .post('/events', (body) => body.data.attributes.name === 'Launch')
    .reply(200, { data: { id: '1', type: 'events', attributes: { name: 'Launch' } } }, {
      'content-type': 'application/json',
    })

  await callTool(
    tool('confetti_events_create'),
    { name: 'Launch', startDate: '2026-09-01T10:00:00.000Z' },
    context,
  )
  scope.done()
})

test('update splits id from the body', async () => {
  const scope = nock(API)
    .put('/events/7', (body) => body.data.attributes.name === 'Renamed')
    .reply(200, { data: { id: '7', type: 'events', attributes: { name: 'Renamed' } } }, {
      'content-type': 'application/json',
    })

  await callTool(tool('confetti_events_update'), { id: 7, name: 'Renamed' }, context)
  scope.done()
})

test('delete requests the record by id', async () => {
  const scope = nock(API).delete('/pages/3').query(true).reply(204, '')
  await callTool(tool('confetti_pages_delete'), { id: 3 }, context)
  scope.done()
})

test('a missing id is rejected before the request goes out', async () => {
  await assert.rejects(() => callTool(tool('confetti_events_find'), {}, context), /id is required/)
})

test('upstream 404 propagates as NotFoundError', async () => {
  nock(API)
    .get('/events/999')
    .query(true)
    .reply(404, { message: 'Event not found' }, { 'content-type': 'application/json' })

  await assert.rejects(
    () => callTool(tool('confetti_events_find'), { id: 999 }, context),
    (error: Error) => {
      assert.equal(error.name, 'NotFoundError')
      return true
    },
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import=tsx --test test/tools/dispatch.ts`
Expected: FAIL — cannot find module `../../src/tools/dispatch.js`.

- [ ] **Step 3: Write `src/tools/dispatch.ts`**

```ts
import { resourceFor } from '../confetti/resource-map.js'
import type { GeneratedTool } from './definitions.js'

export const DEFAULT_PAGE_SIZE = 25

export interface CallContext {
  apiKey: string
  apiHost?: string
  apiProtocol?: string
}

type AnyArgs = Record<string, unknown>

function baseOptions(context: CallContext): AnyArgs {
  return {
    apiKey: context.apiKey,
    ...(context.apiHost ? { apiHost: context.apiHost } : {}),
    ...(context.apiProtocol ? { apiProtocol: context.apiProtocol } : {}),
  }
}

/**
 * Keys that control the upstream connection itself. They are never accepted
 * from tool arguments: `findAll` and `find` merge caller args and connection
 * options into one object, so without this a caller could set apiHost and
 * redirect the request — with the real API key attached — to a host of their
 * choosing. Spread order alone is not enough, because CallContext permits
 * apiHost/apiProtocol to be absent, leaving nothing to overwrite the caller's
 * value with.
 */
const RESERVED_OPTION_KEYS = ['apiKey', 'apiHost', 'apiProtocol', 'raw'] as const

function stripReserved(args: AnyArgs): AnyArgs {
  const clean = { ...args }
  for (const key of RESERVED_OPTION_KEYS) delete clean[key]
  return clean
}

function requireId(args: AnyArgs): string | number {
  const id = args['id']
  if (typeof id === 'string' || typeof id === 'number') return id
  throw Object.assign(new Error('id is required'), { name: 'ParameterError' })
}

/**
 * Returns args without `id`. Written as copy-then-delete rather than the
 * `const { id: _, ...rest }` idiom because this repo's no-unused-vars config
 * sets argsIgnorePattern but not ignoreRestSiblings.
 */
function withoutId(args: AnyArgs): AnyArgs {
  const rest = { ...args }
  delete rest['id']
  return rest
}

function withDefaultPage(page: unknown): AnyArgs {
  const provided = typeof page === 'object' && page !== null ? (page as AnyArgs) : {}
  return { size: DEFAULT_PAGE_SIZE, ...provided }
}

export async function callTool(
  tool: GeneratedTool,
  args: AnyArgs,
  context: CallContext,
): Promise<unknown> {
  const resource = resourceFor(tool.modelKey) as unknown as Record<
    string,
    (...callArgs: unknown[]) => Promise<unknown>
  >
  const options = baseOptions(context)

  switch (tool.operation) {
    // Only findAll and find merge caller args into the options object, so only
    // they need stripReserved. create/update pass args as a structurally
    // separate JSON body, where stripping would remove legitimate fields.
    case 'findAll': {
      const { page, ...rest } = stripReserved(args)
      return resource['findAll']!({ ...rest, page: withDefaultPage(page), ...options })
    }
    case 'find': {
      const id = requireId(args)
      return resource['find']!(id, { ...stripReserved(withoutId(args)), ...options })
    }
    case 'create': {
      return resource['create']!(args, options)
    }
    case 'update': {
      const id = requireId(args)
      return resource['update']!(id, withoutId(args), options)
    }
    case 'delete': {
      const id = requireId(args)
      return resource['delete']!(id, options)
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import=tsx --test test/tools/dispatch.ts`
Expected: 13 tests PASS.

If the query-string assertions fail, print the intercepted URL with `nock.recorder.rec()` and adjust the expected `page[size]` / `filter[...]` bracket spelling to match what `qs.stringify` actually emits. Do not change the production code to match a guess.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: dispatch tool calls to Confetti static resources"
```

---

### Task 9: MCP server wiring over stateless streamable HTTP

**Files:**
- Create: `src/server/mcp.ts`
- Modify: `src/server/app.ts`
- Test: `test/server/mcp.ts`

**Interfaces:**
- Consumes: `buildTools`, `GeneratedTool` from `src/tools/definitions.js`; `parseToolFilter`, `selectTools`, `toolSetCacheKey`, `ToolFilterError` from `src/tools/filter.js`; `callTool` from `src/tools/dispatch.js`; `toolErrorMessage` from `src/tools/errors.js`; `extractApiKey` from `src/server/auth.js`.
- Produces: `createMcpServer(options: { tools: GeneratedTool[]; context: CallContext }): Server`, `getToolSet(query: Record<string, unknown>): GeneratedTool[]`.

`McpServer.registerTool` accepts Zod schemas only, so this uses the **low-level `Server`** with raw request handlers — that is the only path that takes generated JSON Schema.

- [ ] **Step 1: Write the failing test**

Create `test/server/mcp.ts`:

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import nock from 'nock'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/config.js'

const API = 'https://api.confetti.events'

async function startServer() {
  const app = createApp(loadConfig({}))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address() as { port: number }
  return { server, port }
}

async function connect(port: number, path = '/mcp', headers: Record<string, string> = {}) {
  const client = new Client({ name: 'test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${path}`), {
    requestInit: { headers: { authorization: 'Bearer sk_test_key', ...headers } },
  })
  await client.connect(transport)
  return { client, transport }
}

afterEach(() => {
  nock.cleanAll()
})

test('lists all 63 tools', async () => {
  const { server, port } = await startServer()
  const { client, transport } = await connect(port)

  const { tools } = await client.listTools()
  assert.equal(tools.length, 63)
  assert.ok(tools.some((t) => t.name === 'confetti_events_find_all'))

  await transport.close()
  server.close()
})

test('ops=read narrows the listed tools to 29', async () => {
  const { server, port } = await startServer()
  const { client, transport } = await connect(port, '/mcp?ops=read')

  const { tools } = await client.listTools()
  assert.equal(tools.length, 29)

  await transport.close()
  server.close()
})

test('calling a tool reaches Confetti with the caller api key', async () => {
  const { server, port } = await startServer()
  const scope = nock(API, { reqheaders: { authorization: 'apikey sk_test_key' } })
    .get('/events')
    .query(true)
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  const { client, transport } = await connect(port)
  const result = await client.callTool({ name: 'confetti_events_find_all', arguments: {} })

  assert.notEqual(result.isError, true)
  scope.done()

  await transport.close()
  server.close()
})

test('an upstream failure comes back as an isError result, not a protocol error', async () => {
  const { server, port } = await startServer()
  nock(API)
    .get('/events/999')
    .query(true)
    .reply(404, { message: 'Event not found' }, { 'content-type': 'application/json' })

  const { client, transport } = await connect(port)
  const result = await client.callTool({ name: 'confetti_events_find', arguments: { id: 999 } })

  assert.equal(result.isError, true)
  const content = result.content as Array<{ type: string; text: string }>
  assert.match(content[0]!.text, /Not found in 'confetti_events_find'/)

  await transport.close()
  server.close()
})

test('an unknown tool name returns an isError result', async () => {
  const { server, port } = await startServer()
  const { client, transport } = await connect(port)

  const result = await client.callTool({ name: 'confetti_nope_find', arguments: {} })
  assert.equal(result.isError, true)

  await transport.close()
  server.close()
})

test('a filtered-out tool is refused when called, not merely hidden from the list', async () => {
  const { server, port } = await startServer()
  const { client, transport } = await connect(port, '/mcp?ops=read')

  const { tools } = await client.listTools()
  assert.equal(
    tools.find((t) => t.name === 'confetti_pages_delete'),
    undefined,
    'a read-only connection must not list a delete tool',
  )

  // The filter must be enforced, not advisory: naming the tool directly must fail.
  const result = await client.callTool({ name: 'confetti_pages_delete', arguments: { id: 1 } })
  assert.equal(result.isError, true, 'a read-only connection must refuse a delete call')
  const content = result.content as Array<{ type: string; text: string }>
  assert.match(content[0]!.text, /not available on this connection/)

  await transport.close()
  server.close()
})

test('every listed tool on a filtered connection belongs to the requested ops', async () => {
  const { server, port } = await startServer()
  const { client, transport } = await connect(port, '/mcp?ops=read')

  const { tools } = await client.listTools()
  assert.equal(tools.length, 29)
  for (const tool of tools) {
    assert.match(
      tool.name,
      /_(find|find_all)$/,
      `${tool.name} is not a read operation but was listed on a ?ops=read connection`,
    )
  }

  await transport.close()
  server.close()
})

test('tool arguments cannot override the connection api key or host', async () => {
  const { server, port } = await startServer()
  const legit = nock(API, { reqheaders: { authorization: 'apikey sk_test_key' } })
    .get('/events')
    .query(true)
    .reply(200, { data: [] }, { 'content-type': 'application/json' })
  const evil = nock('http://evil.example.com').get('/events').query(true).reply(200, { data: [] })

  const { client, transport } = await connect(port)
  await client.callTool({
    name: 'confetti_events_find_all',
    arguments: { apiKey: 'ATTACKER_KEY', apiHost: 'evil.example.com', apiProtocol: 'http' },
  })

  assert.ok(legit.isDone(), 'the trusted connection context must win over tool arguments')
  assert.equal(evil.isDone(), false, 'tool arguments must not be able to redirect the upstream call')

  await transport.close()
  server.close()
})

test('a request with no api key is rejected with 401', async () => {
  const { server, port } = await startServer()
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })

  assert.equal(res.status, 401)
  assert.match(res.headers.get('www-authenticate') ?? '', /Bearer/)
  server.close()
})

test('an invalid ops value is rejected with 400 and lists valid values', async () => {
  const { server, port } = await startServer()
  const res = await fetch(`http://127.0.0.1:${port}/mcp?ops=frobnicate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer sk_test_key',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })

  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(JSON.stringify(body), /frobnicate/)
  server.close()
})

test('GET /mcp is rejected because the server is stateless', async () => {
  const { server, port } = await startServer()
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { authorization: 'Bearer sk_test_key' },
  })
  assert.equal(res.status, 405)
  server.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import=tsx --test test/server/mcp.ts`
Expected: FAIL — cannot find module `../../src/server/mcp.js`.

- [ ] **Step 3: Write `src/server/mcp.ts`**

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildTools, type GeneratedTool } from '../tools/definitions.js'
import { parseToolFilter, selectTools, toolSetCacheKey } from '../tools/filter.js'
import { callTool, type CallContext } from '../tools/dispatch.js'
import { toolErrorMessage } from '../tools/errors.js'

export const SERVER_NAME = 'confetti-mcp'
export const SERVER_VERSION = '0.1.0'

/** All 63 tools, generated once. Definition building walks every Zod schema. */
const ALL_TOOLS = buildTools()

/**
 * Every tool name that exists at all, regardless of filtering. Used only to
 * tell "this tool was filtered out of your connection" apart from "no such
 * tool", so a filtered caller gets an actionable message.
 */
const ALL_TOOL_NAMES = new Set(ALL_TOOLS.map((tool) => tool.definition.name))

/** Filtered tool sets are memoised per normalised query. */
const toolSetCache = new Map<string, GeneratedTool[]>()

export function getToolSet(query: Record<string, unknown>): GeneratedTool[] {
  const key = toolSetCacheKey(query)
  const cached = toolSetCache.get(key)
  if (cached) return cached

  const selected = selectTools(ALL_TOOLS, parseToolFilter(query))
  toolSetCache.set(key, selected)
  return selected
}

export function createMcpServer(options: { tools: GeneratedTool[]; context: CallContext }): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  const byName = new Map(options.tools.map((tool) => [tool.definition.name, tool]))

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map((tool) => tool.definition),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const tool = byName.get(name)
    if (!tool) {
      // `byName` is built from the FILTERED set, so a tool excluded by
      // ?ops= / ?resources= is refused here and not merely hidden from
      // tools/list. Without this the filter would be advisory: a ?ops=read
      // connection could still invoke a delete by naming it directly.
      const text = ALL_TOOL_NAMES.has(name)
        ? `Tool '${name}' is not available on this connection — its operation or resource is excluded by the ?ops= / ?resources= filter in the connect URL.`
        : `Unknown tool '${name}'.`
      return {
        isError: true,
        content: [{ type: 'text' as const, text }],
      }
    }

    try {
      const result = await callTool(tool, request.params.arguments ?? {}, options.context)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    } catch (error) {
      return {
        isError: true,
        // The caller's key is passed so it can be exact-matched out of the
        // message. Confetti enforces no key format, so shape-matching alone
        // would not hold the "key never reaches a client" constraint.
        content: [{ type: 'text' as const, text: toolErrorMessage(error, name, options.context.apiKey) }],
      }
    }
  })

  return server
}
```

- [ ] **Step 4: Rewrite `src/server/app.ts`**

```ts
import express from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Config } from '../config.js'
import { extractApiKey } from './auth.js'
import { createMcpServer, getToolSet, SERVER_NAME, SERVER_VERSION } from './mcp.js'
import { ToolFilterError } from '../tools/filter.js'

export { SERVER_NAME, SERVER_VERSION }

function methodNotAllowed(_req: express.Request, res: express.Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'This server is stateless; use POST /mcp.' },
    id: null,
  })
}

export function createApp(config: Config): express.Express {
  const app = express()
  app.use(express.json({ limit: '4mb' }))

  app.get('/', (_req, res) => {
    res.json({
      status: 'ok',
      server: SERVER_NAME,
      version: SERVER_VERSION,
      usage: 'POST /mcp with an "Authorization: Bearer <confetti-api-key>" header.',
    })
  })

  const handleMcp: express.RequestHandler = async (req, res) => {
    const apiKey = extractApiKey({
      headers: req.headers as Record<string, unknown>,
      params: req.params,
      query: req.query as Record<string, unknown>,
    })
    if (!apiKey) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Missing Confetti API key. Send "Authorization: Bearer <key>".' },
        id: null,
      })
      return
    }

    let tools
    try {
      tools = getToolSet(req.query as Record<string, unknown>)
    } catch (error) {
      if (error instanceof ToolFilterError) {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: error.message }, id: null })
        return
      }
      throw error
    }

    const server = createMcpServer({
      tools,
      context: { apiKey, apiHost: config.apiHost, apiProtocol: config.apiProtocol },
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

    res.on('close', () => {
      void transport.close()
      void server.close()
    })

    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  }

  app.post('/mcp', handleMcp)
  app.get('/mcp', methodNotAllowed)
  app.delete('/mcp', methodNotAllowed)

  return app
}
```

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all tests PASS, including the 11 new ones in `test/server/mcp.ts` and the Task 1 health tests.

If `StreamableHTTPClientTransport`'s import path errors, list the client directory with `ls node_modules/@modelcontextprotocol/sdk/dist/esm/client/` and use the path that exists. Do not stub the transport.

- [ ] **Step 6: Verify lint passes**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: stateless MCP server over streamable HTTP"
```

---

### Task 10: URL-carried API key fallbacks

**Files:**
- Modify: `src/server/app.ts`
- Test: `test/server/url-auth.ts`

**Interfaces:**
- Consumes: everything from Task 9.
- Produces: the route `POST /mcp/k/:apiKey`. The `?apiKey=` carrier needs no new route — Task 9's `handleMcp` already passes `req.query` to `extractApiKey`.

These exist for clients that cannot set headers. Claude Desktop's **Code tab**
reads `.mcp.json` and handles headers natively, so it needs neither; Claude
Desktop's **chat** surface and claude.ai web use the custom-connector UI, whose
only fields are the server URL plus optional OAuth client id and secret. Those
clients must put the key in the URL.

The key lands in the URL either way, so neither route may ever be logged. This
task must also prove that an `apiKey` in the query string does not disturb the
`?ops=` / `?resources=` tool filtering that shares the same query object, and
that a URL-carried key never surfaces in a **response body** — success or error.

Asserting only that nothing is logged is not sufficient: nothing on the request
path logs today, so such a test cannot fail and proves nothing. The exposure that
can actually regress is an error handler widening to echo the request URL or
query back to the caller, which would hand the key straight to the client.

- [ ] **Step 1: Write the failing test**

Create `test/server/url-auth.ts`:

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import nock from 'nock'
import { createApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/config.js'

const API = 'https://api.confetti.events'

async function startServer() {
  const app = createApp(loadConfig({}))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address() as { port: number }
  return { server, port }
}

function rpc(port: number, path: string) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
}

afterEach(() => {
  nock.cleanAll()
})

test('the path route authenticates without a header', async () => {
  const { server, port } = await startServer()
  const res = await rpc(port, '/mcp/k/sk_path_key')
  assert.equal(res.status, 200)
  server.close()
})

test('the path route honours the ops filter', async () => {
  const { server, port } = await startServer()
  const res = await rpc(port, '/mcp/k/sk_path_key?ops=read')
  assert.equal(res.status, 200)
  const text = await res.text()
  const listed = (text.match(/"name":"confetti_/g) ?? []).length
  assert.equal(listed, 29)
  server.close()
})

test('the query carrier authenticates without a header', async () => {
  const { server, port } = await startServer()
  const res = await rpc(port, '/mcp?apiKey=sk_query_key')
  assert.equal(res.status, 200)
  server.close()
})

test('an apiKey in the query does not disturb tool filtering', async () => {
  const { server, port } = await startServer()
  const res = await rpc(port, '/mcp?apiKey=sk_query_key&ops=read')
  assert.equal(res.status, 200)
  const text = await res.text()
  const listed = (text.match(/"name":"confetti_/g) ?? []).length
  assert.equal(listed, 29, 'apiKey must be ignored by parseToolFilter, not rejected as an unknown key')
  server.close()
})

test('an unknown query parameter is still ignored rather than rejected', async () => {
  const { server, port } = await startServer()
  const res = await rpc(port, '/mcp?apiKey=sk_query_key&utm_source=docs')
  assert.equal(res.status, 200)
  server.close()
})

test('the api key never appears in an error response body', async () => {
  const { server, port } = await startServer()

  // ?ops=frobnicate makes ToolFilterError produce a 400 whose message quotes the
  // offending value. If an error message ever widened to include the URL or the
  // whole query, the path-carried key would ride along into the client's hands.
  const res = await fetch(`http://127.0.0.1:${port}/mcp/k/sk_super_secret_value?ops=frobnicate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })

  assert.equal(res.status, 400)
  const body = await res.text()
  assert.ok(!body.includes('sk_super_secret_value'), `api key leaked into the error body: ${body}`)

  server.close()
})

test('the api key never appears in a successful response body', async () => {
  const { server, port } = await startServer()

  const res = await rpc(port, '/mcp/k/sk_super_secret_value?ops=read')
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.ok(!body.includes('sk_super_secret_value'), 'api key leaked into a successful response')

  server.close()
})

// A weaker forward guard than the two above: nothing on the request path logs
// today, so this cannot currently fail. Kept in case request logging is added
// later, but named so it does not overstate what it proves.
test('no request-path logging exists that could capture the api key', async () => {
  const { server, port } = await startServer()
  const captured: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args: unknown[]) => captured.push(args.join(' '))
  console.error = (...args: unknown[]) => captured.push(args.join(' '))

  try {
    await rpc(port, '/mcp/k/sk_super_secret_value')
  } finally {
    console.log = originalLog
    console.error = originalError
    server.close()
  }

  assert.ok(
    !captured.join('\n').includes('sk_super_secret_value'),
    `api key leaked into logs: ${captured.join('\n')}`,
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import=tsx --test test/server/url-auth.ts`
Expected: FAIL — the `/mcp/k/:apiKey` route returns 404.

- [ ] **Step 3: Register the route in `src/server/app.ts`**

Add immediately after the existing `app.post('/mcp', handleMcp)` line:

```ts
  // Fallback for MCP clients that cannot set request headers (notably the
  // claude.ai web connector UI). The key travels in the URL, so this route is
  // deliberately excluded from any request logging.
  app.post('/mcp/k/:apiKey', handleMcp)
  app.get('/mcp/k/:apiKey', methodNotAllowed)
  app.delete('/mcp/k/:apiKey', methodNotAllowed)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import=tsx --test test/server/url-auth.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: url-carried api key fallbacks for header-less clients"
```

---

### Task 11: Dockerfile

**Files:**
- Create: `Dockerfile`, `.dockerignore`

**Interfaces:**
- Consumes: `npm run build`, `npm start` from Task 1.
- Produces: an image exposing port 8080.

- [ ] **Step 1: Create `.dockerignore`**

```
node_modules
dist
.git
test
docs
*.log
.env
```

- [ ] **Step 2: Create `Dockerfile`**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/main.js"]
```

- [ ] **Step 3: Build the image**

Run: `docker build -t confetti-mcp:dev .`
Expected: build succeeds.

- [ ] **Step 4: Verify the container serves the health endpoint**

Run:
```bash
docker run -d --rm -p 8099:8080 --name confetti-mcp-test confetti-mcp:dev
sleep 2
curl -fsS http://127.0.0.1:8099/ | grep -q '"server":"confetti-mcp"' && echo HEALTH_OK
docker stop confetti-mcp-test
```
Expected: prints `HEALTH_OK`.

- [ ] **Step 5: Verify the container rejects an unauthenticated MCP call**

Run:
```bash
docker run -d --rm -p 8099:8080 --name confetti-mcp-test confetti-mcp:dev
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8099/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
docker stop confetti-mcp-test
```
Expected: prints `401`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "build: multi-stage Dockerfile running as non-root"
```

---

### Task 12: CI and Docker Hub release

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Modify: `package.json` (the `test` script — see Step 0)

**Interfaces:**
- Consumes: `npm run lint`, `npm test`, `npm run build`, `Dockerfile`.
- Produces: `deviesdevelopment/confetti-mcp` on Docker Hub, tagged on version tags.

Requires two repository secrets: `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub access token scoped to read/write on this repository, not an account password).

**The test suite hangs on failure, and CI is where that bites.** Tests that start a
server call `server.close()` after their assertions with no `try/finally`, so a
throwing assertion skips cleanup, leaks a listening handle, and `node --test`
never exits. This was found empirically: forcing a failure required
`--test-force-exit` to get any output at all. Locally it is a nuisance; in CI a
genuine test failure would hang the job until the runner timeout rather than
failing fast. Step 0 fixes it, and both workflows carry an explicit
`timeout-minutes` as a second line of defence.

- [ ] **Step 0: Stop a failing test from hanging the run**

In `package.json`, change the `test` script from:

```json
"test": "node --import=tsx --test test/**/*.ts",
```

to:

```json
"test": "node --import=tsx --test --test-force-exit test/**/*.ts",
```

Verify: `npm test` still reports 100 passing. Then confirm the guard works —
temporarily add `assert.equal(1, 2)` to any test, run `npm test`, and check that
it **exits** with a failure rather than hanging. Remove the deliberate failure
afterwards and report what you observed.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      - run: npm ci

      - name: Lint and typecheck
        run: npm run lint

      - name: Test
        run: npm test

      - name: Build
        run: npm run build

  docker:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - name: Build image (no push)
        uses: docker/build-push-action@v6
        with:
          context: .
          push: false
          tags: confetti-mcp:ci
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Create `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags: ['v*']

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      - run: npm ci

      - name: Lint and typecheck
        run: npm run lint

      - name: Test
        run: npm test

      - uses: docker/setup-qemu-action@v3

      - uses: docker/setup-buildx-action@v3

      - name: Log in to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}

      - name: Derive image tags
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: deviesdevelopment/confetti-mcp
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha,format=long

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          platforms: linux/amd64,linux/arm64
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 3: Validate the workflow files parse**

Run: `npx --yes yaml-lint .github/workflows/ci.yml .github/workflows/release.yml || python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in sys.argv[1:]]; print('YAML_OK')" .github/workflows/ci.yml .github/workflows/release.yml`
Expected: prints `YAML_OK` or the linter reports no errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "ci: test on PR, publish multi-arch image to Docker Hub on tag"
```

---

### Task 13: README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: user-facing documentation.

- [ ] **Step 1: Write `README.md`**

````markdown
# confetti-mcp

An MCP server for the [Confetti](https://confetti.events) API. It exposes all 63
Confetti API operations as MCP tools, so assistants like Claude Code can manage
events, tickets, contacts, pages, and payments directly.

> **Beta** — tool definitions may change.

## How it works

`confetti-mcp` is a stateless HTTP server speaking the MCP streamable-http
transport. You supply your own Confetti API key on each connection; the server
stores no credentials and holds no per-user state.

Tools are generated at startup from the `confetti` client's model registry, so
the tool surface tracks the API rather than being hand-maintained.

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

63 tools is a lot of context. Narrow it per connection:

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

## Self-hosting

```bash
docker run -p 8080:8080 deviesdevelopment/confetti-mcp
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `CONFETTI_API_HOST` | `api.confetti.events` | Upstream API host |
| `CONFETTI_API_PROTOCOL` | `https` | Upstream protocol |
| `LOG_LEVEL` | `info` | Log verbosity |

The server never reads an API key from its own environment — keys always come
from the caller.

## Development

```bash
npm install
npm run lint
npm test
npm run dev
```

## License

[MIT](LICENSE)
````

- [ ] **Step 2: Verify every documented command is real**

Run: `npm run lint && npm test && npm run build`
Expected: all succeed, confirming the documented scripts exist.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: README with Claude Code setup and self-hosting"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 public repo, Docker Hub | 11, 12 |
| §1 private deploy repo | Deferred by decision — out of milestone 1 |
| §2 stateless runtime, `GET /` | 1, 9 |
| §3 auth, three carriers, 401 | 2, 9, 10 |
| §4 connect-URL grammar | 6, 9 |
| §5 tool generation, explicit map, annotations | 3, 4, 5 |
| §6 page default, JSON results, error mapping | 7, 8, 9 |
| §7 configuration | 1 |
| §8 testing | every task |
| §9 error-name classification | 7 |

**Placeholder scan:** none — every step carries runnable content.

**Type consistency:** `GeneratedTool` is defined in Task 5 and consumed unchanged in 6, 8, 9. `CallContext` is defined in Task 8 and consumed in 9. `ModelKey` and `Operation` come from Task 3 and are used in 4, 5, 6, 8. `toolName` from Task 4 is used only in Task 5. `ToolFilterError` from Task 6 is caught in Task 9's `app.ts`. `SERVER_NAME` / `SERVER_VERSION` move from `app.ts` (Task 1) to `mcp.ts` (Task 9) and are re-exported from `app.ts` so the Task 1 health test keeps passing.

**Known follow-ups after milestone 1:** upstream PR exporting `confetti-node`'s error classes; Azure hosting and the private deploy repo; optional GHCR mirror.
