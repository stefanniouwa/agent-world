# Spectator mode

Agent world is a fork of [Bot Crossing](https://github.com/Station-Sciences/bot-crossing) by Jarren Rocks, under its MIT licence. Bot Crossing shows the coding agents on your own machine and lets you act on them. This fork adds a spectator build that only watches, for a public page: stefannio.tech/lab.

The spectator build has no server, reads no files and makes no requests of its own. The page that frames it sends it the world, and it draws what it is sent.

## The two halves

- `collector/` runs on each of Stefan's machines. It reads T3 Code's database read-only, keeps only the fields below, and pushes a snapshot to the site every minute.
- `npm run build:spectator` builds the world into `dist-spectator/`, with relative paths so it runs from any folder. CI attaches it to a release, and the site downloads a pinned release at build time.

## What leaves a machine

Only these fields, per agent. No title, prompt, path, branch, transcript or thread id.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | `a_` and 16 hex characters, a salted hash of the thread id |
| `project` | string | A display name from the machine's allowlist, or `Private work` |
| `harness` | string | `claude-code`, `codex`, `cursor` or `other` |
| `model` | string | The model id, or `''` |
| `state` | string | `working`, `waiting`, `idle` or `errored` |
| `since` | number | Last activity, epoch ms |
| `createdAt` | number | Epoch ms |
| `turns` | number | How many turns the thread has run. Sets how finished its building looks |
| `subagents` | number | Subagents out right now |

A snapshot is `{ v: 1, machine, sentAt, agents }`. `machine` is `mac-mini`, `macbook-air`, `cloud-vm` or `grok-vm`, and each has its own push key.

## The world the page sends

```js
{
  v: 1,
  generatedAt,      // epoch ms
  machines: [{ id, name, live, lastSeenAt }],  // lastSeenAt is null if it never pushed
  agents: [{ ...agent, machine }],             // every agent of a machine that is not live is idle
}
```

## Messages

Every message carries `source: 'agent-world'`, and each side checks the other's origin.

The page sends:

- `{ type: 'world', world }`, first and on every refresh
- `{ type: 'home' }` to frame the whole island
- `{ type: 'focus', id }` to fly to one agent
- `{ type: 'deselect' }`
- `{ type: 'sound', on }`
- `{ type: 'visible', on }`, false while the frame is off screen or the tab is hidden, so the world stops drawing

The world sends:

- `{ type: 'ready' }` once it can take a world
- `{ type: 'select', id }`, with `id` null when the selection clears
- `{ type: 'fatal', reason }` when it cannot draw, so the page shows its still picture
