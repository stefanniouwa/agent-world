/**
 * Keep zone name plates from overlapping on screen.
 *
 * Plates are placed busiest zone first. A plate that would overlap one already placed moves
 * straight up until it clears, with a small gap. Only up, so the loop always ends, and the
 * order never depends on where the camera is, so the same view gives the same answer every
 * frame. Pure, so it runs under bare node.
 */

/**
 * @param plates `[{ id, x, y, w, h, priority }]`, centres and sizes in CSS pixels, y down
 * @param gap pixels kept clear between two plates
 * @returns Map of id to how many pixels that plate is lifted, 0 or more
 */
export function declutter(plates, gap = 4) {
  const order = [...plates].sort((a, b) => b.priority - a.priority || String(a.id).localeCompare(String(b.id)))
  const placed = []
  const lifts = new Map()
  for (const plate of order) {
    let y = plate.y
    for (let pass = 0; pass < plates.length + 1; pass++) {
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

/** Ease a lift toward its target, frame-rate independent, settling exactly once close. */
export function easeLift(current, target, dt, rate = 10) {
  const next = current + (target - current) * (1 - Math.exp(-rate * dt))
  return Math.abs(next - target) < 0.05 ? target : next
}
