import type { ModelKey, Operation } from '../confetti/resource-map.js'

/**
 * The single home for facts a model needs that no upstream data structure
 * states. Everything a description can be *generated* from — required fields,
 * relationships, filters, includes, missing operations — is generated in
 * definitions.ts and must NOT be repeated here; this table is only for rules
 * that cross tool boundaries and would otherwise cost a failed call to learn.
 *
 * Keep it short: one or two sentences per entry, at most a couple of dozen
 * entries. `all` applies to every operation of that resource; an operation key
 * applies to that operation only, and both are emitted when both exist.
 *
 * Every key is checked against the live registry by test/tools/notes.ts, so an
 * upstream rename fails the build instead of silently orphaning a note.
 */
export type NoteScope = Operation | 'all'

export const NOTES: Partial<Record<ModelKey, Partial<Record<NoteScope, string>>>> = {
  event: {
    create: 'A new event is a draft until you set status to "open".',
    update:
      'Events cannot be deleted through the API: call the event off with status "cancelled", or take it offline with status "draft".',
  },
  ticket: {
    all: 'A Ticket is one person\'s registration for one event. Workspace-level people are Contacts.',
    create:
      'Ticket-based events need a ticketBatchId, and ticket batches can only be created in the Confetti UI. sendEmailConfirmation true emails the attendee immediately; pass false to register someone without contacting them.',
  },
  contact: {
    all: 'Contacts are workspace-level people and are not attached to an event. To register someone for an event, use confetti_tickets_create.',
  },
  payment: {
    all: 'Payments are read-only through the API — they are written by Confetti checkout.',
  },
  category: {
    all: 'Categories are read-only through the API; create them in the Confetti UI.',
  },
  ticketBatch: {
    all: 'Ticket batches are read-only through the API; create them in the Confetti UI.',
  },
  workspace: {
    all: 'Workspaces are read-only through the API. A workspace id is what events, contacts, pages and webhooks belong to.',
  },
  form: {
    all: 'Forms themselves are read-only through the API; their fields can be created and edited with the confetti_form_fields_* tools.',
  },
}

/**
 * Field descriptions this server states differently from upstream. Merging is
 * fill-gaps-only everywhere else — upstream prose always wins — so an entry
 * here is a deliberate override and needs a reason.
 *
 * ticket.values: the upstream text tells agents to prefer `formValues`. No such
 * field exists anywhere in the package (the string occurs only inside this one
 * description), so a model that followed it sent answers under a key that is
 * dropped, and the ticket was created with no form answers and no error.
 */
export const FIELD_DESCRIPTIONS: Partial<Record<ModelKey, Record<string, string>>> = {
  ticket: {
    values:
      'Form field answers, keyed by each field\'s name (e.g. {"dietary-needs": "Vegan"}). Field names come from confetti_form_fields_find; titles and ids are not accepted, and answers sent under any other argument are ignored.',
  },
}

/** Notes that apply to one generated tool, in a stable order. */
export function notesFor(modelKey: ModelKey, operation: Operation): string[] {
  const entry = NOTES[modelKey]
  if (!entry) return []
  return [entry['all'], entry[operation]].filter((note): note is string => typeof note === 'string')
}

/** The override for one field, if this server states one. */
export function fieldDescription(modelKey: ModelKey, field: string): string | undefined {
  return FIELD_DESCRIPTIONS[modelKey]?.[field]
}
