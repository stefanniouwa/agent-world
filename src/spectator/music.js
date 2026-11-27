/**
 * The spectator's music: one CC0 track, looped, in place of the island's wind and birds.
 *
 * The file is not fetched until the visitor first turns sound on, because the page that
 * frames the world counts every byte it loads. It is decoded into one buffer and looped by
 * the source node itself, which is the only way Web Audio loops without a gap. A track that
 * cannot be fetched or decoded calls `onFail` once, and the world falls back to the ambience
 * it had before.
 *
 * It plays into the ambience's master bus, so the mute that silences the world while it is
 * off screen or the sound is off silences the music with it. Pure apart from what it is
 * handed, so it runs under bare node with a fake context.
 */

/** Gain into the master bus. The track is mastered quietly, around -25 LUFS, so it sits at unity. */
export const MUSIC_LEVEL = 1
/** The effects bus under the music: work sounds keep their place in the world, a little quieter. */
export const EFFECTS_UNDER_MUSIC = 0.55
/** Seconds to fade in when sound turns on. */
export const FADE_IN = 2
/** Seconds to fade out when sound turns off, inside the 0.6 s the ambience waits before it suspends. */
export const FADE_OUT = 0.5

export function createMusic({ url, fetch: get = globalThis.fetch, onFail = () => {} }) {
  let state = 'idle'
  let on = false
  let ctx = null
  let gain = null
  let source = null

  function ramp(to, seconds) {
    if (!gain) return
    const now = ctx.currentTime
    const g = gain.gain
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(to, now + seconds)
  }

  function fail(err) {
    if (state === 'failed') return
    state = 'failed'
    onFail(err)
  }

  async function load(context, destination) {
    state = 'loading'
    try {
      if (typeof get !== 'function') throw new Error('no fetch')
      const response = await get(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.arrayBuffer()
      const buffer = await new Promise((resolve, reject) => {
        const p = context.decodeAudioData(data, resolve, reject)
        if (p && typeof p.then === 'function') p.then(resolve, reject)
      })
      ctx = context
      gain = ctx.createGain()
      gain.gain.value = 0
      gain.connect(destination)
      source = ctx.createBufferSource()
      source.buffer = buffer
      source.loop = true
      source.connect(gain)
      source.start()
      state = 'playing'
      if (on) ramp(MUSIC_LEVEL, FADE_IN)
    } catch (err) {
      fail(err)
    }
  }

  return {
    get state() {
      return state
    },
    /** The node the track plays through, for checks. Null until it is playing. */
    get gain() {
      return gain
    },
    /**
     * Sound on or off. The first `on` with a context starts the download; later ones fade
     * the loop back up from wherever it was.
     */
    setOn(next, context, destination) {
      on = Boolean(next)
      if (state === 'failed') return
      if (state === 'idle') {
        if (on && context && destination) load(context, destination)
        return
      }
      if (state === 'playing') ramp(on ? MUSIC_LEVEL : 0, on ? FADE_IN : FADE_OUT)
    },
    dispose() {
      try {
        source?.stop()
        source?.disconnect()
        gain?.disconnect()
      } catch {}
      source = null
      gain = null
    },
  }
}
