/**
 * Where the selected bot is on screen, for the page's speech bubble. The world posts it as an
 * `anchor` message; see SPECTATOR.md. Pure, so it runs under bare node.
 */

/** How far a point may sit past the frame's edge, in CSS pixels, and still count as on screen. */
export const ANCHOR_MARGIN = 8
/** How far the point has to move, in CSS pixels, before the page hears about it again. */
export const ANCHOR_STEP = 0.5

const round = (n) => Math.round(n * 10) / 10

/**
 * A view-space point as CSS pixels in a `w` by `h` frame, y down, the way the name plates
 * measure it: a symmetric perspective, so the projection's two scale terms are all it needs.
 *
 * @param view `{ x, y, z }` in the camera's view space, so a point in front has z below 0
 * @param p the camera's `projectionMatrix.elements`
 * @returns `{ x, y, visible }`. A point behind the camera has `x` and `y` null.
 */
export function viewToCss(view, p, w, h, margin = ANCHOR_MARGIN) {
  const dist = -view.z
  if (!(dist > 0.01)) return { x: null, y: null, visible: false }
  const x = ((view.x * p[0]) / dist) * 0.5 * w + w / 2
  const y = h / 2 - ((view.y * p[5]) / dist) * 0.5 * h
  const visible = x >= -margin && x <= w + margin && y >= -margin && y <= h + margin
  return { x: round(x), y: round(y), visible }
}

/**
 * Whether an anchor differs enough from the one last sent to be worth sending: another bot,
 * a change in whether it shows, or a move of `step` pixels or more on either axis.
 */
export function anchorMoved(last, next, step = ANCHOR_STEP) {
  if (!last) return true
  if (last.id !== next.id || last.visible !== next.visible) return true
  if (last.x === null || next.x === null) return last.x !== next.x || last.y !== next.y
  return Math.abs(next.x - last.x) >= step || Math.abs(next.y - last.y) >= step
}
