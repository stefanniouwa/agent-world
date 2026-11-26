import * as THREE from 'three'
import { Settings } from '../core/settings.js'
import { Engine } from '../core/engine.js'
import { CameraRig } from '../core/camera.js'
import { Colony } from '../game/colony.js'
import { PLANETS } from '../world/planet.js'
import { loadKit } from '../world/kit.js'
import { crewRig, loadCrew } from '../agents/crew.js'
import { CURVE_FULL, installWorldCurve, setCurveView } from '../core/curve.js'
import { Ambience } from '../audio/ambience.js'
import { withErrands } from '../game/errands.js'
import { acceptMessage, outbound } from './messages.js'
import { worldToThreads } from './wire.js'
import { islandRadius, shipLayout } from './layout.js'

/**
 * The spectator build: the colony, drawn from a world the framing page sends, and nothing
 * else. No HUD, no requests of its own, no writes. The contract is SPECTATOR.md.
 */

const deg = THREE.MathUtils.degToRad
const app = document.getElementById('app')
const origin = location.origin
const framed = window.parent && window.parent !== window

let stopped = false
let engine = null

function post(type, fields) {
  if (!framed) return
  window.parent.postMessage(outbound(type, fields), origin)
}

function fatal(reason) {
  if (stopped) return
  stopped = true
  try {
    engine?.stop()
  } catch {
    /* already gone */
  }
  post('fatal', { reason })
}

function hasWebGL2() {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'))
  } catch {
    return false
  }
}

if (!hasWebGL2()) fatal('webgl2-unavailable')
else {
  try {
    start()
  } catch (err) {
    console.error(err)
    fatal('renderer-failed')
  }
}

function start() {
  const touch = window.matchMedia('(pointer: coarse)').matches
  const maxPixelRatio = touch ? 1.5 : 2
  const settings = new Settings({ persist: false })
  settings.applyPreset('low')
  // The low preset draws at 70% of the display. On a 1x screen that is below one buffer pixel
  // per CSS pixel and the whole island goes soft, so it never starts under that. The governor
  // still drops it on a machine that cannot keep up.
  const dpr = Math.min(window.devicePixelRatio || 1, maxPixelRatio)
  settings.values.renderScale = Math.max(settings.values.renderScale, Math.min(1, 1 / dpr))
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  Object.assign(settings.values, {
    planet: 'sky',
    autoQuality: true,
    sound: false,
    // A machine that goes quiet puts its crew to sleep; their zones stay on the map.
    hideDormant: false,
    followSelected: true,
    autoFrame: false,
    showFps: false,
    showLabels: true,
    reducedMotion: reduced,
  })

  installWorldCurve()
  engine = new Engine(settings, { maxPixelRatio }).mount(app)
  engine.canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    fatal('context-lost')
  })
  engine.setPlanetGrade(PLANETS.sky.grade)

  // The wheel belongs to the page around the frame until the visitor has clicked into the
  // world, or holds ctrl or cmd. Leaving the world hands it back.
  let engaged = false
  const rig = new CameraRig(engine.camera, engine.canvas, settings, {
    minDistance: 14,
    maxDistance: 110,
    minPolar: deg(26),
    maxPolar: deg(68),
    worldLimit: 40,
    pan: false,
    wheelAllowed: (e) => engaged || e.ctrlKey || e.metaKey,
  })
  engine.canvas.addEventListener('pointerdown', () => (engaged = true))
  engine.canvas.addEventListener('pointerleave', () => (engaged = false))
  window.addEventListener('blur', () => (engaged = false))

  const colony = new Colony(engine.scene, settings, engine.camera, engine.renderer)
  colony.labelsAlways = true
  // The frame is a slice of a page, not a whole window, so the names are drawn larger.
  colony.labelSize = touch ? 1.6 : 1.9

  const ambience = new Ambience(settings, { manifest: false })
  ambience.setPlanet(colony.planet)
  colony.onSound = (name, x, y, z) => ambience.play(name, { x, y, z, kind: colony.fauna.flock?.kind })

  // ── framing ─────────────────────────────────────────────────────────────────────────

  let ring = 2
  let framedOnce = false
  let following = false

  /** The distance that keeps the whole island in view at the current aspect. */
  function homeDistance() {
    const { w, h } = engine.viewport || { w: innerWidth, h: innerHeight }
    const v = deg(settings.get('fov'))
    const hz = 2 * Math.atan(Math.tan(v / 2) * (w / Math.max(1, h)))
    // Seen from the resting tilt the island's depth is foreshortened, so it needs less room
    // top to bottom than across. The rock underneath and the ships stand in for the rest.
    const r = islandRadius(ring)
    // A tall, narrow frame lets the rim and the outermost ships brush the sides rather than
    // pulling so far back that the haze takes the whole island.
    const across = w < h ? r * 0.88 : r
    return Math.max((r * 0.64) / Math.tan(v / 2), across / Math.tan(hz / 2)) * 1.04
  }

  function home({ snap = false } = {}) {
    following = false
    const d = homeDistance()
    rig.maxDistance = Math.max(40, d * 1.12)
    rig.resetView()
    rig.desiredDistance = THREE.MathUtils.clamp(d, rig.minDistance, rig.maxDistance)
    if (snap) {
      rig.distance = rig.desiredDistance
      rig.target.set(0, 0, 0)
      rig.azimuth = rig.desiredAzimuth
      rig.polar = rig.desiredPolar
    }
  }

  /** A portrait frame gets a wider lens, so it can stand closer and still see the island across. */
  function fitLens() {
    const { w, h } = engine.viewport || { w: innerWidth, h: innerHeight }
    const fov = w < h ? 48 : 38
    if (settings.get('fov') === fov) return
    settings.values.fov = fov
    engine.applySettings()
  }
  fitLens()

  window.addEventListener('resize', () => {
    fitLens()
    rig.maxDistance = Math.max(40, homeDistance() * 1.12)
    rig.desiredDistance = Math.min(rig.desiredDistance, rig.maxDistance)
  })

  // ── selection ───────────────────────────────────────────────────────────────────────

  let selectedId = null

  /** The id the page knows: an errand answers for the thread that sent it. */
  const wireId = (agent) => agent?.thread?.parentId || agent?.id || null

  function select(id, { fly = false, notify = false } = {}) {
    const agent = id ? colony.agentFor(id) : null
    if (!agent) {
      const had = selectedId
      selectedId = null
      following = false
      colony.astronauts.setSelected(null)
      rig.setFollow(null)
      if (notify && (had || id === null)) post('select', { id: null })
      return
    }
    selectedId = agent.id
    following = true
    colony.astronauts.setSelected(agent)
    if (fly) rig.focus(new THREE.Vector3(agent.pos.x, 0, agent.pos.z), { distance: Math.min(rig.desiredDistance, 28) })
    if (notify) post('select', { id: wireId(agent) })
  }

  function ndc(e) {
    const rect = engine.canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
      aspect: rect.width / rect.height,
    }
  }

  engine.canvas.addEventListener('pointermove', (e) => {
    if (rig.interacting) {
      engine.canvas.style.cursor = 'grabbing'
      return
    }
    const p = ndc(e)
    const agent = colony.pick(p.x, p.y, p.aspect)
    colony.astronauts.setHover(agent)
    engine.canvas.style.cursor = agent ? 'pointer' : 'grab'
  })

  engine.canvas.addEventListener('pointerleave', () => colony.astronauts.setHover(null))

  engine.canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || !rig.wasClick) return
    const p = ndc(e)
    const agent = colony.pick(p.x, p.y, p.aspect)
    if (agent) select(agent.id, { notify: true })
    else select(null, { notify: true })
  })

  // ── the world ───────────────────────────────────────────────────────────────────────

  const known = new Set()
  let ready = false
  let pending = null

  function applyWorld(world) {
    const now = Date.now()
    const { threads, ships } = worldToThreads(world, now)
    const list = withErrands(threads)
    const sizes = new Map()
    for (const t of list) sizes.set(t.project, (sizes.get(t.project) || 0) + 1)
    const layout = shipLayout([...sizes.values()], ships.length)
    ring = layout.ring
    colony.setShips(
      ships.map((ship, i) => ({ ...ship, cell: layout.ships[i] })),
      layout.fill
    )
    colony.setThreads(list, new Set(), new Set(), known)
    for (const t of list) known.add(t.id)
    if (!framedOnce) {
      framedOnce = true
      home({ snap: true })
    }
    if (selectedId && !colony.agentFor(selectedId)) select(null, { notify: true })
  }

  let running = true
  function setVisible(on) {
    ambience.setVisible(on)
    if (on && !running && !stopped) {
      running = true
      engine.start()
    } else if (!on && running) {
      running = false
      engine.stop()
    }
  }

  window.addEventListener('message', (event) => {
    if (stopped) return
    const data = acceptMessage(event, { origin, parent: window.parent, self: window })
    if (!data) return
    switch (data.type) {
      case 'world':
        if (ready) applyWorld(data.world)
        else pending = data.world
        break
      case 'home':
        select(null)
        home()
        break
      case 'focus':
        select(data.id, { fly: true })
        break
      case 'deselect':
        select(null)
        break
      case 'sound':
        settings.set('sound', data.on)
        if (data.on) ambience.unlock()
        break
      case 'visible':
        setVisible(data.on)
        break
    }
  })

  settings.onChange((changed, scope) => {
    if (scope.render) engine.applySettings()
    colony.onSettingsChanged(changed, scope)
  })

  // ── frame ───────────────────────────────────────────────────────────────────────────

  const sources = []
  function soundWorld() {
    let n = 0
    const take = (id, sound, x, y, z, gain = 1) => {
      const s = sources[n] || (sources[n] = { id: '', sound: '', x: 0, y: 0, z: 0, gain: 1 })
      Object.assign(s, { id, sound, x, y, z, gain })
      n++
    }
    for (const agent of colony.astronauts.agents) {
      if (agent.state === 'at-site' && agent.status === 'working' && agent.scale > 0.5) {
        take(`work:${agent.id}`, 'work-hammer', agent.pos.x, agent.pos.y + 0.6, agent.pos.z, 0.9)
      }
    }
    colony.ships.forEach((ship, i) => {
      if (!ship.live) return
      const p = ship.group.position
      take(`ship:${i}`, 'ship-hum', p.x, p.y + 3, p.z, 0.7)
    })
    colony.fauna.drones.forEach((d, i) => take(`drone:${i}`, 'drone-whine', d.x, d.y, d.z, d.busy ? 1 : 0.35))
    sources.length = n
    return { night: colony.sky.nightFactor ?? 0, sources, water: null }
  }

  engine.add({
    update(dt, elapsed) {
      const agent = following && selectedId ? colony.agentFor(selectedId) : null
      rig.setFollow(agent)
      rig.update(dt)
      setCurveView(rig.target, rig.azimuth, settings.get('worldCurve') * CURVE_FULL)
      colony.update(dt, elapsed, rig.target)
      // The haze starts past the island at whatever distance the camera sits, so pulling
      // back to see all of it never fades it into the sky.
      const fog = engine.scene.fog
      if (fog) {
        fog.near = Math.max(colony.planet.fog.near, rig.distance + 40)
        fog.far = fog.near + colony.planet.fog.far - colony.planet.fog.near
      }
      engine.setFocusDistance(rig.distance)
      if (selectedId && !colony.agentFor(selectedId)) select(null, { notify: true })
      ambience.update(dt, engine.camera, soundWorld())
    },
  })

  engine.start()
  // For poking at the world from a dev console and the visual checks. Not in the build.
  if (import.meta.env.DEV) window.agentWorld = { engine, rig, colony, settings, select }

  const settle = (p) => p.then(() => null, (err) => err)
  Promise.all([settle(loadKit()), settle(loadCrew())]).then(([kitError, crewError]) => {
    if (kitError || crewError) {
      console.error(kitError || crewError)
      fatal('assets-failed')
      return
    }
    colony.astronauts.setRig(crewRig())
    colony.onAssetsReady()
    ready = true
    if (pending) applyWorld(pending)
    pending = null
    post('ready')
  })
}
