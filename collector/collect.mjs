#!/usr/bin/env node
/**
 * Push this machine's agents to the site, keeping only the fields SPECTATOR.md lists.
 *
 * Reads T3 Code's database read-only. Titles, prompts, paths and branches are read by nothing
 * here: the queries below never select them, so they cannot reach the snapshot by mistake.
 *
 *   node collector/collect.mjs            push when something changed, or as a heartbeat
 *   node collector/collect.mjs --dry-run  print the snapshot and push nothing
 *
 * Config lives in ~/.config/agent-world/config.json (see config.example.json). The push key
 * lives in the login keychain, never in a file.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { buildSnapshot } from './snapshot.mjs'

const CONFIG = process.env.AGENT_WORLD_CONFIG || path.join(os.homedir(), '.config', 'agent-world', 'config.json')
const STATE = path.join(os.homedir(), '.config', 'agent-world', 'last-push.json')
/** The site calls a machine stale after five minutes, so an unchanged snapshot still goes out every two. */
const HEARTBEAT_MS = 2 * 60 * 1000
const KEYCHAIN_SERVICE = 'agent-world-push'

const dryRun = process.argv.includes('--dry-run')
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
const dbPath = (config.database || '~/.t3/userdata/statev2.sqlite').replace(/^~(?=\/)/, os.homedir())

const db = new DatabaseSync(dbPath, { readOnly: true })
db.exec('PRAGMA busy_timeout = 5000')

const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

// Only ids, times, statuses, the provider, the model and the project's folder. Never the title,
// the payload's free text, the worktree path or the branch. A user message gives only its time.
const threads = db
  .prepare(
    `SELECT t.thread_id AS id,
            t.created_at AS createdAt,
            t.updated_at AS updatedAt,
            t.default_provider AS provider,
            json_extract(t.payload_json, '$.modelSelection.model') AS model,
            json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship,
            json_extract(t.payload_json, '$.settledOverride') AS settled,
            (SELECT MAX(m.updated_at) FROM orchestration_v2_projection_messages m
              WHERE m.thread_id = t.thread_id AND m.role = 'user') AS userMessageAt,
            p.workspace_root AS root
       FROM orchestration_v2_projection_threads t
       LEFT JOIN projection_projects p USING (project_id)
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND t.updated_at > ?`
  )
  .all(since)

const runs = db
  .prepare(
    `SELECT thread_id AS id, status, COALESCE(completed_at, requested_at) AS at, turns,
            requested_at AS requestedAt, started_at AS startedAt, completed_at AS completedAt
       FROM (SELECT thread_id, status, completed_at, requested_at,
                    json_extract(payload_json, '$.startedAt') AS started_at,
                    COUNT(*) OVER (PARTITION BY thread_id) AS turns,
                    ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY ordinal DESC) AS n
               FROM orchestration_v2_projection_runs
              WHERE requested_at > ?)
      WHERE n = 1`
  )
  .all(since)

const waiting = db
  .prepare(`SELECT DISTINCT thread_id AS id FROM orchestration_v2_projection_runtime_requests WHERE status = 'pending'`)
  .all()

// Only each thread's latest PR state, never its title or branch.
const pullRequests = db
  .prepare(
    `SELECT thread_id AS id, json_extract(snapshot_json, '$.state') AS state
       FROM (SELECT thread_id, snapshot_json,
                    ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY linked_at DESC) AS n
               FROM projection_thread_pull_requests)
      WHERE n = 1`
  )
  .all()

const subagents = db
  .prepare(
    `SELECT thread_id AS id, COUNT(*) AS n FROM orchestration_v2_projection_subagents
      WHERE status IN ('queued', 'starting', 'running') GROUP BY thread_id`
  )
  .all()

db.close()

const snapshot = buildSnapshot({
  machine: config.machine,
  salt: config.salt,
  projects: config.projects || {},
  threads,
  runs,
  waiting,
  subagents,
  pullRequests,
  ...(Number.isFinite(config.autoSettleDays) ? { autoSettleDays: config.autoSettleDays } : {}),
  now: Date.now(),
})

if (dryRun) {
  console.log(JSON.stringify(snapshot, null, 2))
  process.exit(0)
}

// Push only when the agents changed, or when the heartbeat is due.
const digest = createHash('sha256').update(JSON.stringify(snapshot.agents)).digest('hex')
let last = { digest: '', at: 0 }
try {
  last = JSON.parse(fs.readFileSync(STATE, 'utf8'))
} catch {
  /* first run */
}
if (last.digest === digest && Date.now() - last.at < HEARTBEAT_MS) process.exit(0)

const key = execFileSync('security', ['find-generic-password', '-a', 'agent-world', '-s', KEYCHAIN_SERVICE, '-w'], {
  encoding: 'utf8',
}).trim()

const res = await fetch(config.endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify(snapshot),
  signal: AbortSignal.timeout(15_000),
})
if (!res.ok) {
  console.error(`${new Date().toISOString()} push failed: ${res.status}`)
  process.exit(1)
}
fs.writeFileSync(STATE, JSON.stringify({ digest, at: Date.now() }))
const working = snapshot.agents.filter((a) => a.state === 'working').length
console.log(`${new Date().toISOString()} pushed ${snapshot.agents.length} agents, ${working} working`)
