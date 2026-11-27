/**
 * The spectator build: wire agents into colony threads, the postMessage checks, and where the
 * ships stand. The checks are the part worth guarding: a world that took a message from any
 * frame or origin would draw whatever a stranger sent it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ASLEEP_AGE, toThread, turnsToBytes, worldToThreads } from '../src/spectator/wire.js'
import { acceptMessage, outbound } from '../src/spectator/messages.js'
import { shipLayout } from '../src/spectator/layout.js'
import { ZONE_MIN_DISTANCE, zoneDistance, zoneExtent, zoneKey, zoneSummary } from '../src/spectator/zones.js'
import { hexDistance } from '../src/world/plot-move.js'

const now = Date.parse('2026-11-27T00:00:00Z')
const agent = (extra = {}) => ({
  id: 'a_0123456789abcdef',
  project: 'bizsec.io',
  harness: 'claude-code',
  model: 'claude-opus-5-5',
  state: 'working',
  since: now - 60_000,
  createdAt: now - 3_600_000,
  turns: 12,
  subagents: 2,
  machine: 'mac-mini',
  ...extra,
})

test('a wire agent becomes a thread with a generic title and no way to open it', () => {
  const t = toThread(agent(), { now })
  assert.equal(t.id, 'a_0123456789abcdef')
  assert.equal(t.title, 'Claude Code agent, working')
  assert.equal(t.project, 'bizsec.io')
  assert.equal(t.machine, 'mac-mini')
  assert.equal(t.harness, 'claude-code')
  assert.equal(t.lastActivityAt, now - 60_000)
  assert.equal(t.canOpen, false)
  assert.equal(t.archived, false)
  assert.equal(t.subagents.length, 2)
  assert.ok(t.subagents.every((s) => s.task === '' && s.id))
})

test('each state maps onto the flags the colony reads', () => {
  const flags = (state) => {
    const t = toThread(agent({ state }), { now })
    return [t.running, t.unread, t.hasError]
  }
  assert.deepEqual(flags('working'), [true, false, false])
  assert.deepEqual(flags('waiting'), [false, true, false])
  assert.deepEqual(flags('errored'), [false, false, true])
  assert.deepEqual(flags('idle'), [false, false, false])
  assert.equal(toThread(agent({ state: 'nonsense' }), { now }).title, 'Claude Code agent, idle')
  assert.equal(toThread(agent({ harness: 'mystery' }), { now }).title, 'Agent agent, working')
})

test('turns set how finished a thread looks, on a log scale', () => {
  const progress = (turns) => Math.min(1, Math.max(0.05, (Math.log10(turnsToBytes(turns)) - 3) / 3.5))
  assert.ok(progress(1) < 0.12, `one turn barely started (${progress(1)})`)
  assert.ok(progress(60) > 0.97, `sixty turns finished (${progress(60)})`)
  assert.ok(progress(10) > progress(3) && progress(30) > progress(10))
  assert.equal(turnsToBytes(0), 1000)
  assert.equal(turnsToBytes(undefined), 1000)
})

test('every agent of a machine that is not live sleeps, with no errands out', () => {
  const world = {
    v: 1,
    machines: [
      { id: 'mac-mini', live: true },
      { id: 'macbook-air', live: false },
    ],
    agents: [agent(), agent({ id: 'a_1111111111111111', machine: 'macbook-air', state: 'working' })],
  }
  const { threads, ships } = worldToThreads(world, now)
  assert.deepEqual(ships, [
    { id: 'mac-mini', live: true },
    { id: 'macbook-air', live: false },
  ])
  const air = threads.find((t) => t.machine === 'macbook-air')
  assert.equal(air.running, false)
  assert.equal(air.subagents.length, 0)
  assert.ok(now - air.lastActivityAt >= ASLEEP_AGE)
})

test('a settled agent sleeps while the rest of its live machine stays awake', () => {
  const world = {
    v: 1,
    machines: [{ id: 'mac-mini', live: true }],
    agents: [
      agent({ id: 'a_2222222222222222', state: 'idle', subagents: 0 }),
      agent({ id: 'a_3333333333333333', state: 'settled', subagents: 0 }),
    ],
  }
  const { threads } = worldToThreads(world, now)
  const [idle, settled] = threads
  // The colony puts a bot to sleep when its last activity is past its three-day line.
  assert.equal(idle.lastActivityAt, now - 60_000)
  assert.equal(settled.title, 'Claude Code agent, done')
  assert.deepEqual([settled.running, settled.unread, settled.hasError], [false, false, false])
  assert.ok(now - settled.lastActivityAt >= ASLEEP_AGE)
  assert.ok(ASLEEP_AGE > 3 * 24 * 60 * 60 * 1000)
})

test('a world with no machines still has one ship, dark', () => {
  assert.deepEqual(worldToThreads({ v: 1, machines: [], agents: [] }, now).ships, [{ id: null, live: false }])
})

test('at most four machines, and a repeated agent id is drawn once', () => {
  const machines = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, live: true }))
  const { ships, threads } = worldToThreads({ v: 1, machines, agents: [agent(), agent()] }, now)
  assert.equal(ships.length, 4)
  assert.equal(threads.length, 1)
})

test('project names are used as given, and a missing one is private', () => {
  assert.equal(toThread(agent({ project: "Stefan's portfolio website" }), { now }).project, "Stefan's portfolio website")
  assert.equal(toThread(agent({ project: '' }), { now }).project, 'Private work')
})

// ── messages ────────────────────────────────────────────────────────────────────────────

const parent = { name: 'parent' }
const self = { name: 'self' }
const origin = 'https://stefannio.tech'
const event = (data, extra = {}) => ({ origin, source: parent, data: { source: 'agent-world', ...data }, ...extra })
const accept = (e, ctx = {}) => acceptMessage(e, { origin, parent, self, ...ctx })

test('a message from the parent on the same origin is accepted', () => {
  assert.equal(accept(event({ type: 'home' })).type, 'home')
  assert.equal(accept(event({ type: 'focus', id: 'a_0123456789abcdef' })).id, 'a_0123456789abcdef')
  assert.equal(accept(event({ type: 'sound', on: true })).on, true)
  assert.equal(accept(event({ type: 'visible', on: false })).on, false)
  assert.ok(accept(event({ type: 'world', world: { v: 1, machines: [], agents: [] } })))
})

test('another origin, another frame, or the window itself is ignored', () => {
  assert.equal(accept(event({ type: 'home' }, { origin: 'https://evil.example' })), null)
  assert.equal(accept(event({ type: 'home' }, { source: { name: 'sibling' } })), null)
  assert.equal(accept(event({ type: 'home' }, { source: null })), null)
  // Not framed: `window.parent` is the window, and its own messages are not the page's.
  assert.equal(accept(event({ type: 'home' }, { source: self }), { parent: self }), null)
})

test('a message without the source tag, of an unknown type, or malformed is ignored', () => {
  assert.equal(accept({ origin, source: parent, data: { type: 'home' } }), null)
  assert.equal(accept({ origin, source: parent, data: 'home' }), null)
  assert.equal(accept(event({ type: 'open', id: 'x' })), null)
  assert.equal(accept(event({ type: 'focus' })), null)
  assert.equal(accept(event({ type: 'sound', on: 'yes' })), null)
  assert.equal(accept(event({ type: 'world', world: { v: 2, agents: [] } })), null)
  assert.equal(accept(event({ type: 'world', world: { v: 1 } })), null)
})

test('a zone message names a project of 1 to 60 characters', () => {
  assert.equal(accept(event({ type: 'zone', project: 'fleet' })).project, 'fleet')
  assert.equal(accept(event({ type: 'zone', project: 'x'.repeat(60) })).project.length, 60)
  assert.equal(accept(event({ type: 'zone', project: 'x'.repeat(61) })), null)
  assert.equal(accept(event({ type: 'zone', project: '' })), null)
  assert.equal(accept(event({ type: 'zone' })), null)
  assert.equal(accept(event({ type: 'zone', project: 7 })), null)
  assert.equal(accept(event({ type: 'zone', project: ['fleet'] })), null)
})

test('outgoing messages carry the source tag and cannot be retyped by their fields', () => {
  assert.deepEqual(outbound('select', { id: null }), { id: null, source: 'agent-world', type: 'select' })
  assert.equal(outbound('ready', { type: 'fatal', source: 'x' }).type, 'ready')
})

// ── ships ───────────────────────────────────────────────────────────────────────────────

test('ships stand on a ring outside the colony, apart, and never on the fill', () => {
  for (const count of [1, 2, 3, 4]) {
    const { ring, ships, fill } = shipLayout([7, 5, 3, 3, 2], count)
    assert.equal(ships.length, count)
    assert.ok(ring >= 2)
    for (const ship of ships) assert.equal(hexDistance(ship, { q: 0, r: 0 }), ring)
    const keys = new Set(ships.map((c) => `${c.q},${c.r}`))
    assert.equal(keys.size, count)
    for (const c of fill) assert.ok(!keys.has(`${c.q},${c.r}`))
    for (let i = 0; i < ships.length; i++) {
      for (let j = i + 1; j < ships.length; j++) assert.ok(hexDistance(ships[i], ships[j]) >= 2, 'clear space between ships')
    }
  }
})

test('a bigger colony pushes the ships further out', () => {
  assert.ok(shipLayout(Array(20).fill(14), 4).ring > shipLayout([3], 4).ring)
})

// ── name plates ─────────────────────────────────────────────────────────────────────────

import { declutter, easeLift, settleTarget, sweep } from '../src/spectator/declutter.js'

const overlaps = (a, b, gap = 0) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + gap

test('overlapping plates are lifted apart, the busier zone staying put', () => {
  const plates = [
    { id: 'portfolio', x: 400, y: 300, w: 220, h: 20, priority: 6 },
    { id: 'barista', x: 330, y: 296, w: 120, h: 20, priority: 3 },
    { id: 'fleet', x: 420, y: 304, w: 50, h: 20, priority: 2 },
    { id: 'bizsec', x: 700, y: 300, w: 90, h: 20, priority: 4 },
  ]
  const lifts = declutter(plates, 3)
  assert.equal(lifts.get('portfolio'), 0)
  assert.equal(lifts.get('bizsec'), 0, 'a plate with nobody near it does not move')
  const placed = plates.map((p) => ({ ...p, y: p.y - lifts.get(p.id) }))
  for (let i = 0; i < placed.length; i++) {
    assert.ok(lifts.get(placed[i].id) >= 0, 'only ever lifted, never pushed down')
    for (let j = i + 1; j < placed.length; j++) assert.ok(!overlaps(placed[i], placed[j], 2.9), `${placed[i].id} clears ${placed[j].id}`)
  }
})

test('the same plates give the same lifts, whatever order they arrive in', () => {
  const plates = [
    { id: 'a', x: 100, y: 100, w: 80, h: 20, priority: 1 },
    { id: 'b', x: 110, y: 105, w: 80, h: 20, priority: 1 },
    { id: 'c', x: 90, y: 95, w: 80, h: 20, priority: 5 },
  ]
  assert.deepEqual([...declutter(plates)].sort(), [...declutter([...plates].reverse())].sort())
})

test('lifts ease toward their target and settle exactly', () => {
  let lift = 0
  for (let i = 0; i < 120; i++) lift = easeLift(lift, 30, 1 / 60)
  assert.equal(lift, 30)
  assert.ok(easeLift(0, 30, 1 / 60) < 30)
})

test('plates lift clear of status badges, and the badges stay where they are', () => {
  const badge = { x: 205, y: 300, w: 24, h: 24 }
  const plates = [
    { id: 'barista', x: 200, y: 300, w: 120, h: 20, priority: 3 },
    { id: 'fleet', x: 500, y: 300, w: 50, h: 20, priority: 2 },
  ]
  const lifts = declutter(plates, 3, [badge])
  const barista = { ...plates[0], y: 300 - lifts.get('barista') }
  assert.ok(lifts.get('barista') > 0)
  assert.ok(!overlaps(barista, badge, 2.9), 'the plate clears the badge')
  assert.equal(lifts.get('fleet'), 0, 'a plate with no badge on it stays put')
})

test('a held lift rises at once in whole steps and comes down only after a pause', () => {
  const state = { target: 0, lowerFor: 0 }
  assert.equal(settleTarget(state, 9.2, 1 / 60), 12)
  assert.equal(settleTarget(state, 10.5, 1 / 60), 12, 'a pixel of bob does not move it')
  for (let i = 0; i < 60; i++) settleTarget(state, 0, 1 / 60)
  assert.equal(state.target, 12, 'still held after a second')
  for (let i = 0; i < 40; i++) settleTarget(state, 0, 1 / 60)
  assert.equal(state.target, 0)
  // A need hovering on the edge of a step settles on the higher step and stays there.
  settleTarget(state, 8.1, 1 / 60)
  for (let i = 0; i < 600; i++) settleTarget(state, i % 2 ? 7.9 : 8.05, 1 / 60)
  assert.equal(state.target, 12)
})

test('a badge pacing back and forth ends up with one steady box over its path', () => {
  let env = null
  const boxes = []
  for (let i = 0; i < 600; i++) {
    const x = 100 + Math.sin(i / 30) * 20
    env = sweep(env, { x, y: 50, w: 10, h: 10 }, 1 / 60)
    if (i >= 540) boxes.push({ ...env })
  }
  assert.ok(Math.min(...boxes.map((b) => b.x0)) <= 81 && Math.max(...boxes.map((b) => b.x1)) >= 119, 'covers the path')
  const spread = Math.max(...boxes.map((b) => b.x0)) - Math.min(...boxes.map((b) => b.x0))
  assert.ok(spread < 7, `the box barely moves once settled (${spread.toFixed(2)}px)`)
})

// ── zones ───────────────────────────────────────────────────────────────────────────────

const plot = (id, accent, cells = [{ x: 0, z: 0 }]) => ({
  id,
  accent,
  center: { x: 10, z: 5 },
  localCenters: cells,
  middle: { x: 10 + cells.reduce((s, c) => s + c.x, 0) / cells.length, z: 5 + cells.reduce((s, c) => s + c.z, 0) / cells.length },
})

test('each zone goes to the page with its accent as a six digit hex colour', () => {
  assert.deepEqual(zoneSummary([plot('fleet', 0x4f9a63), plot('Private work', 0x0000ff)]), [
    { project: 'fleet', color: '#4f9a63' },
    { project: 'Private work', color: '#0000ff' },
  ])
})

test('the zones key changes with the list and with any colour, and only then', () => {
  const a = zoneSummary([plot('fleet', 0x4f9a63), plot('lab', 0xc96442)])
  assert.equal(zoneKey(a), zoneKey(zoneSummary([plot('fleet', 0x4f9a63), plot('lab', 0xc96442)])))
  assert.notEqual(zoneKey(a), zoneKey(zoneSummary([plot('fleet', 0x4f9a63)])))
  assert.notEqual(zoneKey(a), zoneKey(zoneSummary([plot('fleet', 0x4f9a63), plot('lab', 0x4f7ec9)])))
})

test('a zone is framed from further back than a bot, and a bigger zone from further still', () => {
  const lens = { fov: (38 * Math.PI) / 180, aspect: 16 / 9 }
  const small = zoneDistance(zoneExtent(plot('a', 0)), lens)
  const step = 7.6 * Math.sqrt(3)
  const big = zoneDistance(zoneExtent(plot('b', 0, [{ x: 0, z: 0 }, { x: step, z: 0 }, { x: 0, z: step }, { x: step, z: step }])), lens)
  assert.ok(small >= ZONE_MIN_DISTANCE && small > 28)
  assert.ok(big > small)
  // A portrait frame needs to stand further back for the same zone.
  assert.ok(zoneDistance(20, { ...lens, aspect: 9 / 16 }) > zoneDistance(20, lens))
  // Never further than the whole island needs.
  assert.equal(zoneDistance(200, { ...lens, max: 90 }), 90)
})
