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
