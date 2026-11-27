import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildSnapshot, MAX_AGENTS, PRIVATE } from '../collector/snapshot.mjs'

const now = Date.parse('2026-11-27T00:00:00Z')
const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString()
const base = { machine: 'mac-mini', salt: 'x'.repeat(16), projects: { stefannio: "Stefan's portfolio website" }, now }
const thread = (id, extra = {}) => ({
  id, createdAt: iso(600), updatedAt: iso(5), provider: 'claudeAgent', model: 'claude-opus-5-5',
  relationship: null, root: '/Users/x/Interlinked/stefannio', ...extra,
})

test('keeps only the allowed fields', () => {
  const s = buildSnapshot({ ...base, threads: [thread('t1', { title: 'secret' })], runs: [], waiting: [], subagents: [] })
  assert.deepEqual(Object.keys(s.agents[0]).sort(), ['createdAt', 'harness', 'id', 'model', 'project', 'since', 'state', 'subagents', 'turns'])
  assert.ok(!JSON.stringify(s).includes('secret'))
  assert.ok(!JSON.stringify(s).includes('t1'))
})

test('names only allowlisted projects', () => {
  const s = buildSnapshot({ ...base, threads: [thread('a'), thread('b', { root: '/Users/x/clients/acme' })], runs: [], waiting: [], subagents: [] })
  assert.deepEqual(s.agents.map((a) => a.project).sort(), [PRIVATE, "Stefan's portfolio website"].sort())
})

test('derives the state from runs and requests', () => {
  const s = buildSnapshot({
    ...base,
    threads: [thread('w'), thread('q'), thread('e'), thread('old-e'), thread('i')],
    runs: [
      { id: 'w', status: 'running', at: iso(1), turns: 3 },
      { id: 'q', status: 'completed', at: iso(1), turns: 1 },
      { id: 'e', status: 'failed', at: iso(30), turns: 2 },
      { id: 'old-e', status: 'failed', at: iso(3000), turns: 2 },
    ],
    waiting: [{ id: 'q' }],
    subagents: [{ id: 'w', n: 2 }],
  })
  const by = Object.fromEntries(s.agents.map((a) => [a.state + a.turns, a]))
  assert.equal(s.agents.filter((a) => a.state === 'working').length, 1)
  assert.equal(by.working3.subagents, 2)
  assert.equal(s.agents.filter((a) => a.state === 'waiting').length, 1)
  assert.equal(s.agents.filter((a) => a.state === 'errored').length, 1)
  assert.equal(s.agents[0].state === 'working' || s.agents[0].state === 'waiting', true)
})

test('drops subagents, old threads and odd model names, and caps the list', () => {
  const many = Array.from({ length: 60 }, (_, i) => thread(`n${i}`))
  const s = buildSnapshot({
    ...base,
    threads: [...many, thread('sub', { relationship: 'subagent' }), thread('old', { updatedAt: iso(60 * 24 * 20) }), thread('m', { model: 'x y <b>' })],
    runs: [], waiting: [], subagents: [],
  })
  assert.equal(s.agents.length, MAX_AGENTS)
  assert.ok(s.agents.every((a) => /^a_[0-9a-f]{16}$/.test(a.id)))
  const all = buildSnapshot({ ...base, threads: [thread('m', { model: 'x y <b>' })], runs: [], waiting: [], subagents: [] })
  assert.equal(all.agents[0].model, '')
})

test('refuses an unknown machine or a short salt', () => {
  assert.throws(() => buildSnapshot({ ...base, machine: 'srv1', threads: [], runs: [], waiting: [], subagents: [] }))
  assert.throws(() => buildSnapshot({ ...base, salt: 'short', threads: [], runs: [], waiting: [], subagents: [] }))
})

test('marks settled threads as settled unless they are busy again, after the open ones', () => {
  const s = buildSnapshot({
    ...base,
    threads: [
      thread('open'),
      thread('done', { settled: 'settled' }),
      thread('done-but-running', { settled: 'settled' }),
      thread('done-but-asking', { settled: 'settled' }),
    ],
    runs: [{ id: 'done-but-running', status: 'running', at: iso(1), turns: 4 }],
    waiting: [{ id: 'done-but-asking' }],
    subagents: [],
  })
  assert.deepEqual(s.agents.slice(2).map((a) => a.state), ['idle', 'settled'])
  assert.deepEqual(s.agents.slice(0, 2).map((a) => a.state).sort(), ['waiting', 'working'])
})
