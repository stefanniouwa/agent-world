/**
 * The postMessage protocol between the spectator world and the page that frames it. See
 * SPECTATOR.md. Pure, so the origin checks run under bare node.
 */

export const SOURCE = 'agent-world'

const INBOUND = new Set(['world', 'home', 'focus', 'zone', 'deselect', 'sound', 'visible'])
/** The longest project name a `zone` message may carry. */
export const MAX_PROJECT = 60

/**
 * The message's data if it is one the world should act on, else null.
 *
 * It has to come from the framing page itself: the same origin as this document, sent by
 * `window.parent`, and never by this window to itself, which is what `parent` is when the
 * world is opened on its own rather than in a frame.
 */
export function acceptMessage(event, { origin, parent, self }) {
  if (!event || typeof origin !== 'string' || event.origin !== origin) return null
  if (!parent || parent === self || event.source !== parent) return null
  const data = event.data
  if (!data || typeof data !== 'object' || data.source !== SOURCE || !INBOUND.has(data.type)) return null
  if (data.type === 'world' && !isWorld(data.world)) return null
  if (data.type === 'focus' && (typeof data.id !== 'string' || !data.id)) return null
  if (data.type === 'zone' && (typeof data.project !== 'string' || !data.project || data.project.length > MAX_PROJECT)) return null
  if ((data.type === 'sound' || data.type === 'visible') && typeof data.on !== 'boolean') return null
  return data
}

export function isWorld(world) {
  return Boolean(world && typeof world === 'object' && world.v === 1 && Array.isArray(world.agents))
}

/** A message for the parent, stamped with the source it checks for. */
export function outbound(type, fields = {}) {
  return { ...fields, source: SOURCE, type }
}
