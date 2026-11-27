/**
 * The spectator's music, against a fake audio context: it downloads nothing until sound is
 * first on, loops one decoded buffer, fades with the sound switch, and falls back once if the
 * track cannot play.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createMusic, FADE_IN, FADE_OUT, MUSIC_LEVEL } from '../src/spectator/music.js'

function fakeContext() {
  const ctx = {
    currentTime: 10,
    sources: [],
    createGain() {
      const events = []
      return {
        events,
        connected: null,
        connect(dest) {
          this.connected = dest
        },
        disconnect() {},
        gain: {
          value: 1,
          cancelScheduledValues: (t) => events.push(['cancel', t]),
          setValueAtTime: (v, t) => events.push(['set', v, t]),
          linearRampToValueAtTime: (v, t) => events.push(['ramp', v, t]),
        },
      }
    },
    createBufferSource() {
      const source = {
        started: false,
        connect() {},
        disconnect() {},
        start() {
          source.started = true
        },
        stop() {},
      }
      ctx.sources.push(source)
      return source
    },
    decodeAudioData(data, resolve) {
      resolve({ decoded: data })
    },
  }
  return ctx
}

function fakeFetch(ok = true) {
  const calls = []
  const get = async (url) => {
    calls.push(url)
    return { ok, status: ok ? 200 : 404, arrayBuffer: async () => 'bytes' }
  }
  return { get, calls }
}

const settle = () => new Promise((r) => setTimeout(r, 0))
const lastRamp = (gain) => gain.events.filter((e) => e[0] === 'ramp').at(-1)

test('music downloads nothing until sound is first turned on', async () => {
  const { get, calls } = fakeFetch()
  const music = createMusic({ url: 'audio/t.mp3', fetch: get })
  const ctx = fakeContext()
  music.setOn(false, ctx, {})
  music.setOn(true, null, null)
  await settle()
  assert.equal(calls.length, 0)
  assert.equal(music.state, 'idle')

  music.setOn(true, ctx, {})
  music.setOn(true, ctx, {})
  await settle()
  assert.deepEqual(calls, ['audio/t.mp3'])
})

test('music loops one decoded buffer and fades in over FADE_IN', async () => {
  const { get } = fakeFetch()
  const music = createMusic({ url: 'u', fetch: get })
  const ctx = fakeContext()
  const master = {}
  music.setOn(true, ctx, master)
  await settle()
  assert.equal(music.state, 'playing')
  assert.equal(ctx.sources.length, 1)
  const [source] = ctx.sources
  assert.equal(source.loop, true)
  assert.equal(source.started, true)
  assert.deepEqual(source.buffer, { decoded: 'bytes' })
  assert.equal(music.gain.connected, master)
  assert.deepEqual(lastRamp(music.gain), ['ramp', MUSIC_LEVEL, 10 + FADE_IN])
})

test('music fades out when sound goes off and back up when it comes on, without reloading', async () => {
  const { get, calls } = fakeFetch()
  const music = createMusic({ url: 'u', fetch: get })
  const ctx = fakeContext()
  music.setOn(true, ctx, {})
  await settle()
  ctx.currentTime = 20
  music.setOn(false, ctx, {})
  assert.deepEqual(lastRamp(music.gain), ['ramp', 0, 20 + FADE_OUT])
  ctx.currentTime = 30
  music.setOn(true, ctx, {})
  assert.deepEqual(lastRamp(music.gain), ['ramp', MUSIC_LEVEL, 30 + FADE_IN])
  assert.equal(calls.length, 1)
  assert.equal(ctx.sources.length, 1)
})

test('sound turned off while the track loads starts it silent', async () => {
  const { get } = fakeFetch()
  const music = createMusic({ url: 'u', fetch: get })
  const ctx = fakeContext()
  music.setOn(true, ctx, {})
  music.setOn(false, ctx, {})
  await settle()
  assert.equal(music.state, 'playing')
  assert.equal(music.gain.gain.value, 0)
  assert.equal(lastRamp(music.gain), undefined)
})

test('a track that cannot load calls onFail once and plays nothing', async () => {
  const { get, calls } = fakeFetch(false)
  const failures = []
  const music = createMusic({ url: 'u', fetch: get, onFail: (err) => failures.push(err.message) })
  const ctx = fakeContext()
  music.setOn(true, ctx, {})
  await settle()
  music.setOn(false, ctx, {})
  music.setOn(true, ctx, {})
  await settle()
  assert.equal(music.state, 'failed')
  assert.deepEqual(failures, ['HTTP 404'])
  assert.equal(calls.length, 1)
  assert.equal(ctx.sources.length, 0)
})

test('a track that cannot decode falls back too', async () => {
  const { get } = fakeFetch()
  const failures = []
  const music = createMusic({ url: 'u', fetch: get, onFail: (err) => failures.push(err) })
  const ctx = fakeContext()
  ctx.decodeAudioData = (data, resolve, reject) => reject(new Error('bad data'))
  music.setOn(true, ctx, {})
  await settle()
  assert.equal(music.state, 'failed')
  assert.equal(failures.length, 1)
})
