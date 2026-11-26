/**
 * Where the ships stand: one per machine, on a ring just outside the colony, spread round the
 * back and sides so none of them stands between the camera and the work.
 *
 * Pure, so it runs under bare node. The island under the ships is filled in as a disc of bare
 * cells out to the ring inside them, which joins every ship to the colony whatever shape the
 * zones happen to take.
 */
import { HEX_DIRS, hexDistance } from '../world/plot-move.js'

/** Matches plots.js: one building slot in the middle of a cell and six round it. */
const SLOTS_PER_CELL = 7
const MAX_CELLS = 9
/** The heading the camera looks from at rest (azimuth π/4 in camera.js), as an angle in XZ. */
const CAMERA_ANGLE = Math.PI / 4
/** The share of the circle in front of the camera that is kept clear of ships. */
const FRONT_GAP = (Math.PI * 2) / 3

const cellsNeeded = (threads) => Math.max(1, Math.min(MAX_CELLS, Math.ceil(threads / SLOTS_PER_CELL)))

/** How many cells a disc of `k` rings holds, the middle cell included. */
const discSize = (k) => 1 + 3 * k * (k + 1)

export function hexRing(radius) {
  if (radius === 0) return [{ q: 0, r: 0 }]
  const out = []
  let q = HEX_DIRS[4][0] * radius
  let r = HEX_DIRS[4][1] * radius
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < radius; j++) {
      out.push({ q, r })
      q += HEX_DIRS[i][0]
      r += HEX_DIRS[i][1]
    }
  }
  return out
}

/** The angle of a cell's centre in the XZ plane, from the same axial maths as `hexToWorld`. */
function angleOf({ q, r }) {
  const x = 1.5 * q
  const z = Math.sqrt(3) * (r + q / 2)
  return Math.atan2(z, x)
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))

/**
 * @param projectSizes threads per zone, errands included
 * @param shipCount how many ships, 1 to 4
 * @returns `{ ring, ships: [{q, r}], fill: [{q, r}] }`
 */
export function shipLayout(projectSizes, shipCount) {
  const cells = projectSizes.reduce((n, size) => n + cellsNeeded(size), 0)
  // A couple of spare cells, because zones are blobs and do not pack a disc perfectly.
  let k = 0
  while (discSize(k) < cells + 2) k++
  const ring = Math.max(2, k + 1)

  const count = Math.max(1, Math.min(4, shipCount))
  // The ring walks round in order, so ships spaced evenly along it are spaced evenly round
  // the island. The middle of the group sits at the back, furthest from the camera.
  const candidates = hexRing(ring)
  const back = CAMERA_ANGLE + Math.PI
  let middle = 0
  let bestD = Infinity
  candidates.forEach((cell, i) => {
    const d = Math.abs(wrap(angleOf(cell) - back))
    if (d < bestD) {
      bestD = d
      middle = i
    }
  })
  const span = Math.PI * 2 - FRONT_GAP
  const step = Math.max(2, Math.round((candidates.length * span) / count / (Math.PI * 2)))
  const ships = Array.from({ length: count }, (_, i) => {
    const at = Math.round(middle + (i - (count - 1) / 2) * step)
    return candidates[((at % candidates.length) + candidates.length) % candidates.length]
  })

  const fill = []
  for (let i = 0; i < ring; i++) fill.push(...hexRing(i))
  return { ring, ships: ships.map((c) => ({ q: c.q, r: c.r })), fill: fill.filter((c) => hexDistance(c, { q: 0, r: 0 }) < ring) }
}

/** Roughly how far the island reaches from the middle, ships included, in world units. */
export function islandRadius(ring, cell = 7.6) {
  return (ring + 0.75) * cell * Math.sqrt(3)
}
