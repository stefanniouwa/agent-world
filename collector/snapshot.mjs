/**
 * Turn T3 Code's rows into the snapshot SPECTATOR.md describes. Pure, so it can be tested
 * without a database.
 */
import { createHash } from 'node:crypto'

export const MACHINES = ['mac-mini', 'macbook-air', 'cloud-vm', 'grok-vm']
export const PRIVATE = 'Private work'
export const MAX_AGENTS = 40
const DAY_MS = 24 * 60 * 60 * 1000
const WINDOW_MS = 14 * DAY_MS
/** A failure older than this is history, not a slumped bot. */
const ERROR_MS = 24 * 60 * 60 * 1000

const ACTIVE_RUNS = new Set(['queued', 'preparing', 'starting', 'running'])
const HARNESSES = { claudeAgent: 'claude-code', codex: 'codex', cursor: 'cursor' }
const MODEL = /^[a-z0-9][a-z0-9.-]{0,40}$/

const ms = (iso) => {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? t : 0
}

/** The last folder of a path, on any platform. */
const folder = (root) => String(root || '').split(/[\\/]/).filter(Boolean).pop() || ''

export function agentId(machine, salt, threadId) {
  return 'a_' + createHash('sha256').update(`${salt}:${machine}:${threadId}`).digest('hex').slice(0, 16)
}

/** T3's default for "Days of inactivity before auto-settle". The setting lives in the app, out of the collector's reach. */
export const AUTO_SETTLE_DAYS = 3

/**
 * When a thread last had activity, the way T3's auto-settle reads it: the latest user message,
 * or the latest run being asked for, starting or finishing, else when the thread was made. Not
 * the thread's updatedAt, which also moves when it is renamed, settled or linked to a PR.
 */
export function activityAt(thread, run) {
  const latest = Math.max(ms(thread.userMessageAt), ms(run?.requestedAt), ms(run?.startedAt), ms(run?.completedAt))
  return latest || ms(thread.createdAt)
}

export function buildSnapshot({
  machine,
  salt,
  projects,
  threads,
  runs,
  waiting,
  subagents,
  pullRequests = [],
  autoSettleDays = AUTO_SETTLE_DAYS,
  now,
}) {
  if (!MACHINES.includes(machine)) throw new Error(`Unknown machine "${machine}"`)
  if (!salt || salt.length < 16) throw new Error('Set a salt of at least 16 characters')

  const runById = new Map(runs.map((r) => [r.id, r]))
  const waitingIds = new Set(waiting.map((w) => w.id))
  const subagentsById = new Map(subagents.map((s) => [s.id, Number(s.n) || 0]))
  const prStateById = new Map(pullRequests.map((p) => [p.id, p.state]))

  const agents = []
  for (const t of threads) {
    // A subagent is drawn as an errand of the thread that sent it, not as a bot of its own.
    if (t.relationship === 'subagent') continue
    const run = runById.get(t.id)
    const since = Math.max(ms(t.updatedAt), ms(run?.at))
    if (now - since > WINDOW_MS) continue

    let state = 'idle'
    if (waitingIds.has(t.id) || run?.status === 'waiting') state = 'waiting'
    else if (run && ACTIVE_RUNS.has(run.status)) state = 'working'
    else if (run?.status === 'failed' && now - ms(run.at) < ERROR_MS) state = 'errored'

    // Finished work, read the way T3's sidebar settles a thread: Stefan settled it, its PR was
    // merged or closed, or it has had no activity for the auto-settle window. "active" is T3's pin
    // that keeps a thread open. Busy work is never finished. It stays on the island, asleep.
    const pr = prStateById.get(t.id)
    const settled =
      t.settled === 'settled' ||
      (t.settled !== 'active' && (pr === 'merged' || pr === 'closed' || now - activityAt(t, run) > autoSettleDays * DAY_MS))
    if (settled && state !== 'working' && state !== 'waiting') state = 'settled'

    agents.push({
      id: agentId(machine, salt, t.id),
      project: Object.hasOwn(projects, folder(t.root)) ? projects[folder(t.root)] : PRIVATE,
      harness: HARNESSES[t.provider] || 'other',
      model: MODEL.test(t.model || '') ? t.model : '',
      state,
      since,
      createdAt: ms(t.createdAt),
      turns: Number(run?.turns) || 0,
      subagents: subagentsById.get(t.id) || 0,
    })
  }

  // Busy agents first, then open ones, then the most recent, so the cap never hides one that
  // is working and settled threads give way to open ones.
  const rank = (a) => (a.state === 'working' || a.state === 'waiting' ? 2 : a.state === 'settled' ? 0 : 1)
  agents.sort((a, b) => rank(b) - rank(a) || b.since - a.since)

  return { v: 1, machine, sentAt: now, agents: agents.slice(0, MAX_AGENTS) }
}
