import yayson from 'yayson'
import type { JsonApiDocument } from 'yayson'

/**
 * Response shaping for tool results.
 *
 * Two problems are solved here. First, `confetti`'s adapter deserialises every
 * response through ONE module-level yayson `Store`, which never resets and
 * resolves relationship references by scanning every record synced by any
 * earlier request in the process — so on a multi-tenant deployment one
 * tenant's fetched record can be spliced into another's response, and memory
 * grows for the life of the process. Dispatch therefore asks for `raw: true`
 * and flattens here with a **per-call** `Store`.
 *
 * Second, flattening throws away the JSON:API `meta` and `links`, so a caller
 * could not tell "25 records is everything" from "the first 25 of 137", and a
 * 204 surfaced as the literal empty string. Reads come back in an envelope
 * that states what was returned and whether more exists; writes and deletes
 * come back as explicit confirmations.
 */

const { Store } = yayson()

export interface PageInfo {
  number: number
  size: number
}

export interface ListEnvelope {
  returned: number
  page: PageInfo
  /** 'yes' from links.next; 'likely' is the honest heuristic when links are absent. */
  more: 'yes' | 'no' | 'likely'
  total?: number
  records: unknown[]
}

export interface DeleteConfirmation {
  deleted: true
  resource: string
  id: string
}

export interface OkConfirmation {
  ok: true
  operation: string
  resource: string
  id?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A body is only a JSON:API document if it actually carries `data`. */
function asDocument(body: unknown): JsonApiDocument | undefined {
  if (!isRecord(body) || !('data' in body)) return undefined
  return body as unknown as JsonApiDocument
}

/** A fresh Store per call is the whole point — see the file comment. */
function flatten(document: JsonApiDocument): unknown {
  return new Store().sync(document)
}

function totalFrom(meta: unknown): number | undefined {
  if (!isRecord(meta)) return undefined
  for (const key of ['total', 'totalCount', 'count']) {
    const value = meta[key]
    if (typeof value === 'number') return value
  }
  return undefined
}

function moreFrom(returned: number, size: number, links: unknown): ListEnvelope['more'] {
  // links are authoritative when present; otherwise a full page is the only
  // signal there is, and it is a hint rather than a fact.
  if (isRecord(links)) return links['next'] ? 'yes' : 'no'
  return returned > 0 && returned >= size ? 'likely' : 'no'
}

export function shapeList(body: unknown, page: PageInfo): ListEnvelope {
  const document = asDocument(body)
  const synced = document ? flatten(document) : []
  const records = Array.isArray(synced) ? [...synced] : synced == null ? [] : [synced]
  const total = totalFrom(document?.meta)

  return {
    returned: records.length,
    page,
    more: moreFrom(records.length, page.size, document?.links),
    ...(total === undefined ? {} : { total }),
    records,
  }
}

/** Returns undefined when the body was not a JSON:API document at all. */
export function shapeRecord(body: unknown): unknown {
  const document = asDocument(body)
  if (!document) return undefined
  const synced = flatten(document)
  return Array.isArray(synced) ? synced[0] : synced
}

export function shapeDeleted(resource: string, id: string): DeleteConfirmation {
  return { deleted: true, resource, id }
}

export function shapeOk(operation: string, resource: string, id?: string): OkConfirmation {
  return { ok: true, operation, resource, ...(id === undefined ? {} : { id }) }
}
