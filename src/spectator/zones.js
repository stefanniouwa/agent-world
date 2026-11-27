/**
 * Zones as the page sees them: each project's accent, and how far back the camera stands to
 * frame one. Pure, so it runs under bare node.
 */

/** Matches plots.js: a hex cell's centre to corner. */
const CELL = 7.6
/** Never closer than this, so a zone reads as a place and not as one bot. A bot focus is 28. */
export const ZONE_MIN_DISTANCE = 30

const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`

/** `[{ project, color }]` for every zone on the island, in the colony's order. */
export function zoneSummary(plots) {
  return plots.map((plot) => ({ project: plot.id, color: hex(plot.accent) }))
}

/** A key that changes whenever the list or any colour does. */
export const zoneKey = (zones) => zones.map((z) => `${z.project}\u0000${z.color}`).join('\u0001')

/**
 * How far the zone reaches from its middle: the furthest cell centre plus a whole cell, so
 * the far corner of the last tile is inside the frame.
 *
 * @param plot `{ center, localCenters, middle }` as plots.js builds them
 */
export function zoneExtent(plot) {
  let far = 0
  for (const c of plot.localCenters) {
    const dx = plot.center.x + c.x - plot.middle.x
    const dz = plot.center.z + c.z - plot.middle.z
    far = Math.max(far, Math.hypot(dx, dz))
  }
  return far + CELL
}

/**
 * The camera distance that fits a zone of this extent in a frame of this lens and aspect,
 * never closer than a zone deserves and never further than the whole island needs.
 *
 * @param fov vertical field of view, radians
 */
export function zoneDistance(extent, { fov, aspect, max = Infinity }) {
  const hz = 2 * Math.atan(Math.tan(fov / 2) * aspect)
  const half = Math.min(fov, hz) / 2
  // A sphere round the zone, with a little room so the border does not touch the edge.
  const fit = (extent * 1.1) / Math.sin(half)
  return Math.min(Math.max(ZONE_MIN_DISTANCE, fit), Math.max(ZONE_MIN_DISTANCE, max))
}
