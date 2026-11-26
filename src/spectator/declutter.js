/**
 * Keep zone name plates from overlapping on screen.
 *
 * Plates are placed busiest zone first. A plate that would overlap one already placed moves
 * straight up until it clears, with a small gap. Only up, so the loop always ends, and the
 * order never depends on where the camera is, so the same view gives the same answer every
 * frame. Pure, so it runs under bare node.
 */

/**
 * @param plates `[{ id, x, y, w, h, priority, minLift }]`, centres and sizes in CSS pixels,
 *   y down. `minLift` starts a plate already that far up, so a lift being held stays counted.
 * @param gap pixels kept clear between two things
 * @param obstacles `[{ x, y, w, h }]` that never move, such as status badges. Plates clear
 *   them the same way they clear each other.
 * @returns Map of id to how many pixels that plate is lifted, 0 or more
 */
export function declutter(plates, gap = 4, obstacles = []) {
  const order = [...plates].sort((a, b) => b.priority - a.priority || String(a.id).localeCompare(String(b.id)))
  const placed = obstacles.map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }))
  const lifts = new Map()
  for (const plate of order) {
    let y = plate.y - Math.max(0, plate.minLift || 0)
    for (let pass = 0; pass < placed.length + 1; pass++) {
      let moved = false
      for (const other of placed) {
        const apartX = Math.abs(plate.x - other.x) >= (plate.w + other.w) / 2 + gap
        const apartY = Math.abs(y - other.y) >= (plate.h + other.h) / 2 + gap
        if (apartX || apartY) continue
        // Sit just above the other plate.
        y = other.y - (plate.h + other.h) / 2 - gap
        moved = true
      }
      if (!moved) break
    }
    placed.push({ x: plate.x, y, w: plate.w, h: plate.h })
    lifts.set(plate.id, plate.y - y)
  }
  return lifts
}

/**
 * Which lift to aim for, so plates do not twitch as badges bob and bots walk by. Up at once,
 * in whole steps, so a badge creeping a pixel at a time does not drag the plate with it. Down
 * only once a lower lift, with `margin` pixels to spare, has been enough for `hold` seconds
 * in a row.
 *
 * @param state `{ target, lowerFor }`, kept per plate between frames
 * @param needed the lift this frame's layout asks for
 */
export function settleTarget(state, needed, dt, { step = 4, hold = 1.5, margin = 2, now = false } = {}) {
  const up = Math.max(0, Math.ceil(needed / step - 1e-6) * step)
  // Coming down needs room to spare, so a need that hovers on a step's edge cannot flip the
  // plate between two steps every few seconds.
  const down = needed <= 0 ? 0 : Math.ceil((needed + margin) / step - 1e-6) * step
  if (up > state.target || (now && up !== state.target)) {
    state.target = up
    state.lowerFor = 0
  } else if (down < state.target) {
    state.lowerFor += dt
    if (state.lowerFor >= hold) {
      state.target = down
      state.lowerFor = 0
    }
  } else {
    state.lowerFor = 0
  }
  return state.target
}

/**
 * The ground a moving thing has covered lately, as a rectangle: it grows at once to take in
 * the latest rectangle and shrinks back by `relax` pixels a second. A bot pacing round its
 * building ends up with one steady box over its whole loop, so the plates near it hold still.
 */
export function sweep(envelope, rect, dt, relax = 3) {
  const x0 = rect.x - rect.w / 2
  const x1 = rect.x + rect.w / 2
  const y0 = rect.y - rect.h / 2
  const y1 = rect.y + rect.h / 2
  if (!envelope) return { x0, x1, y0, y1 }
  const give = relax * dt
  envelope.x0 = Math.min(x0, envelope.x0 + give)
  envelope.x1 = Math.max(x1, envelope.x1 - give)
  envelope.y0 = Math.min(y0, envelope.y0 + give)
  envelope.y1 = Math.max(y1, envelope.y1 - give)
  return envelope
}

/** Ease a lift toward its target, frame-rate independent, settling exactly once close. */
export function easeLift(current, target, dt, rate = 10) {
  const next = current + (target - current) * (1 - Math.exp(-rate * dt))
  return Math.abs(next - target) < 0.05 ? target : next
}
