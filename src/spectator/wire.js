/**
 * The world a parent page sends, turned into the thread list the colony already draws.
 *
 * The wire format is in SPECTATOR.md. It carries no free text at all, so every title here is
 * built from the harness and the state. Pure and browser-free so it runs under bare node.
 */

export const HARNESS_NAME = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  other: 'Agent',
}

const STATE_TITLE = {
  working: 'working',
  waiting: 'waiting for a reply',
  idle: 'idle',
  errored: 'hit an error',
}

const STATES = new Set(Object.keys(STATE_TITLE))

/** Older than the colony's three-day line, so a thread on a dark machine is asleep. */
export const ASLEEP_AGE = 3 * 24 * 60 * 60 * 1000 + 60 * 1000

/** More subagents than this on one thread is noise, not information. */
const MAX_SUBAGENTS = 12
/** At most this many ships, and so this many machines with a lander of their own. */
export const MAX_MACHINES = 4
const MAX_LABEL = 48

/**
 * Turns into a transcript size, for how far along a thread looks. The colony reads size on a
 * log scale from 1 KB to about 3 MB; this puts one turn near the bottom of it and sixty turns
 * at the top.
 */
export function turnsToBytes(turns) {
  const n = Number(turns)
  if (!Number.isFinite(n) || n <= 0) return 1000
  return Math.round(1900 * Math.pow(n, 1.81))
}

export function titleFor(harness, state) {
  return `${HARNESS_NAME[harness] || HARNESS_NAME.other} agent, ${STATE_TITLE[state] || STATE_TITLE.idle}`
}

const text = (value, fallback) => {
  const s = typeof value === 'string' ? value.trim() : ''
  return s ? s.slice(0, MAX_LABEL) : fallback
}

const time = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback)

/** One wire agent as a colony thread. `live` is whether its machine is pushing right now. */
export function toThread(agent, { live = true, now = Date.now() } = {}) {
  const harness = HARNESS_NAME[agent.harness] ? agent.harness : 'other'
  const state = live && STATES.has(agent.state) ? agent.state : 'idle'
  const since = time(agent.since, now)
  const subagents = live ? Math.max(0, Math.min(MAX_SUBAGENTS, Math.floor(Number(agent.subagents) || 0))) : 0
  return {
    id: agent.id,
    title: titleFor(harness, state),
    project: text(agent.project, 'Private work'),
    harness,
    harnessName: HARNESS_NAME[harness],
    machine: typeof agent.machine === 'string' ? agent.machine : null,
    running: state === 'working',
    unread: state === 'waiting',
    hasError: state === 'errored',
    prState: null,
    // A machine that is not live has gone quiet, and its crew sleeps.
    lastActivityAt: live ? since : Math.min(since, now - ASLEEP_AGE),
    createdAt: time(agent.createdAt, since),
    sizeBytes: turnsToBytes(agent.turns),
    subagents: Array.from({ length: subagents }, (_, i) => ({ id: `s${i}`, task: '', lastActivityAt: since })),
    canOpen: false,
    archived: false,
    ref: null,
  }
}

/**
 * A whole world: the threads, and the ships in the order they stand around the island.
 * A world with no machines still has one ship, dark, so the island is never empty of one.
 */
export function worldToThreads(world, now = Date.now()) {
  const machines = (Array.isArray(world?.machines) ? world.machines : [])
    .filter((m) => m && typeof m.id === 'string')
    .slice(0, MAX_MACHINES)
  const ships = machines.length
    ? machines.map((m) => ({ id: m.id, live: m.live === true }))
    : [{ id: null, live: false }]
  const liveById = new Map(ships.map((s) => [s.id, s.live]))
  const seen = new Set()
  const threads = []
  for (const agent of Array.isArray(world?.agents) ? world.agents : []) {
    if (!agent || typeof agent.id !== 'string' || !agent.id || seen.has(agent.id)) continue
    seen.add(agent.id)
    threads.push(toThread(agent, { live: liveById.get(agent.machine) === true, now }))
  }
  return { threads, ships }
}
