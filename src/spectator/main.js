import * as THREE from 'three'
import { Settings } from '../core/settings.js'
import { Engine } from '../core/engine.js'
import { CameraRig } from '../core/camera.js'
import { Colony } from '../game/colony.js'
import { PLANETS } from '../world/planet.js'
import { loadKit } from '../world/kit.js'
import { crewRig, loadCrew } from '../agents/crew.js'
import { CURVE_FULL, bendPoint, installWorldCurve, setCurveView } from '../core/curve.js'
import { Ambience } from '../audio/ambience.js'
import { withErrands } from '../game/errands.js'
import { acceptMessage, outbound } from './messages.js'
import { worldToThreads } from './wire.js'
import { islandRadius, shipLayout } from './layout.js'
import { declutter, easeLift, settleTarget, sweep } from './declutter.js'
import { zoneDistance, zoneExtent, zoneKey, zoneSummary } from './zones.js'

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

/**
 * Give the main thread back before the next piece of boot work. The world shares its thread
 * with the page that frames it, so no single step may hold it for long.
 */
function nextTask() {
  if (globalThis.scheduler?.yield) return globalThis.scheduler.yield()
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => resolve()
    channel.port2.postMessage(null)
  })
}

/** Every texture the scene's visible materials use, once each. */
function sceneTextures(scene) {
  const out = new Set()
  scene.traverseVisible((object) => {
    const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : []
    for (const material of materials) {
      for (const value of Object.values(material)) if (value?.isTexture) out.add(value)
      for (const uniform of Object.values(material.uniforms || {})) if (uniform?.value?.isTexture) out.add(uniform.value)
    }
  })
  return out
}

/**
 * A throwaway scene holding one quad per material the post-processing passes own, so they
 * can be compiled ahead of the first frame like everything else.
 */
function postMaterials(composer) {
  const scene = new THREE.Scene()
  const geometry = new THREE.PlaneGeometry(1, 1)
  const seen = new Set()
  const take = (value) => {
    if (value?.isMaterial && !seen.has(value)) {
      seen.add(value)
      scene.add(new THREE.Mesh(geometry, value))
    }
  }
  for (const pass of composer?.passes || []) {
    for (const value of Object.values(pass)) {
      if (Array.isArray(value)) value.forEach(take)
      else take(value)
      take(value?.material)
      take(value?._mesh?.material)
    }
  }
  return scene
}

/** Resolves once the browser has drawn a frame after this call. */
function afterFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
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
  start().catch((err) => {
    console.error(err)
    fatal('renderer-failed')
  })
}

async function start() {
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
  await nextTask()

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

  // The ground is laid later, a step at a time, once the models are in.
  const colony = new Colony(engine.scene, settings, engine.camera, engine.renderer, { deferGround: true })
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

  /** Fly to the middle of a project's zone, far enough back to see all of it. */
  function showZone(project) {
    const plot = colony.plots.get(project)
    if (!plot) return
    select(null)
    const { w, h } = engine.viewport || { w: innerWidth, h: innerHeight }
    const distance = zoneDistance(zoneExtent(plot), { fov: deg(settings.get('fov')), aspect: w / Math.max(1, h), max: homeDistance() })
    rig.focus(plot.middle, { distance })
  }

  /** The zones and their accents, posted when either changes, so the page's cards match. */
  let sentZones = null
  function postZones() {
    const zones = zoneSummary(colony.plotOrder)
    const key = zoneKey(zones)
    if (key === sentZones) return
    sentZones = key
    post('zones', { zones })
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
  /** Threads per zone, for which name plate gives way when two would overlap. */
  let zoneSizes = new Map()

  // ── name plates ─────────────────────────────────────────────────────────────────────

  const anchor = new THREE.Vector3()
  /**
   * Where each visible plate lands on screen this frame, without any lift, and then the lift
   * that keeps it clear of the others. The measure mirrors the plate's own vertex shader: the
   * anchor is bent like the ground, and the quad grows with distance.
   */
  function declutterPlates(dt) {
    const { w, h } = engine.viewport || { w: innerWidth, h: innerHeight }
    const p = engine.camera.projectionMatrix.elements
    const plates = []
    const labels = new Map()
    for (const plot of colony.plotOrder) {
      const label = plot.label
      if (!label?.visible || !label.userData.screenOffset) continue
      const view = bendPoint(anchor.copy(label.position)).applyMatrix4(engine.camera.matrixWorldInverse)
      const dist = -view.z
      if (dist <= 0.01) continue
      const k = 0.55 + dist * 0.03
      const geo = label.geometry.parameters
      // The plate's canvas pads the text all round; only the lettering and its dot need room.
      plates.push({
        id: plot.id,
        x: ((view.x * p[0]) / dist) * 0.5 * w + w / 2,
        y: h / 2 - ((view.y * p[5]) / dist) * 0.5 * h,
        // The canvas pads 14 of its 62 pixels of height on every side; see `createLabel`.
        w: (((geo.width - (geo.height * 28) / 62) * k * p[0]) / dist) * 0.5 * w,
        h: ((geo.height * k * p[5]) / dist) * 0.5 * h * 0.62,
        priority: zoneSizes.get(plot.id) || 0,
      })
      labels.set(plot.id, label)
    }
    // While the view moves everything on screen moves with it, so nothing is held: the plates
    // take whatever the layout says, and the badges' swept boxes start again.
    const m = engine.camera.matrixWorld.elements
    let moved = false
    for (let i = 0; i < 16; i++) if (Math.abs(m[i] - lastView[i]) > 1e-5) moved = true
    lastView.set(m)
    if (moved) sweeps.clear()
    const badges = badgeRects(w, h, p, dt)
    // First what each plate needs on its own this frame, which decides whether a held lift
    // may come down; then the layout itself, with every plate starting from the lift it holds.
    const free = declutter(plates, 3, badges)
    for (const plate of plates) {
      const state = (labels.get(plate.id).userData.settle ||= { target: 0, lowerFor: 0 })
      plate.minLift = settleTarget(state, free.get(plate.id) ?? 0, dt, { hold: 3, now: moved })
    }
    const lifts = declutter(plates, 3, badges)
    for (const [id, label] of labels) {
      const wanted = Math.max(0, Math.ceil((lifts.get(id) ?? 0) / 4 - 1e-6) * 4)
      const lift = easeLift(label.userData.lift ?? 0, wanted, dt)
      label.userData.lift = lift
      label.userData.screenOffset.y = (lift * 2) / h
    }
    shownPlates = plates.map((plate) => ({ ...plate, y: plate.y - (labels.get(plate.id).userData.lift ?? 0) }))
  }
  /** Where the plates were last drawn, for the visual checks. */
  let shownPlates = []

  /**
   * Every status badge that is on screen and not faded out, as a rectangle in CSS pixels.
   * Mirrors the badge shader in indicators.js: a quad of `size * (2 + dist * 0.22)` view
   * units, lifted by half its height above its anchor over the helmet.
   */
  function badgeRects(w, h, p, dt) {
    const rects = []
    const seen = new Set()
    for (const agent of colony.astronauts.agents) {
      // Only bots settled at their own site. One walking across the island passes a plate in a
      // moment, and lifting every plate it passes would keep the names bobbing for nothing.
      if (!agent.badgeSize || agent.state !== 'at-site') continue
      const view = bendPoint(anchor.set(agent.pos.x, agent.badgeY, agent.pos.z)).applyMatrix4(engine.camera.matrixWorldInverse)
      const dist = -view.z
      if (dist <= 0.01) continue
      const t = THREE.MathUtils.smoothstep(dist, 19, 44)
      if (1 - (agent.badgeFade ?? 0) * t < 0.35) continue
      const scale = agent.badgeSize * (2 + dist * 0.22)
      const rect = {
        x: ((view.x * p[0]) / dist) * 0.5 * w + w / 2,
        y: h / 2 - (((view.y + scale * 0.5) * p[5]) / dist) * 0.5 * h,
        w: ((scale * p[0]) / dist) * 0.5 * w,
        h: ((scale * p[5]) / dist) * 0.5 * h,
      }
      const env = sweep(sweeps.get(agent.id), rect, dt)
      sweeps.set(agent.id, env)
      seen.add(agent.id)
      rects.push({ x: (env.x0 + env.x1) / 2, y: (env.y0 + env.y1) / 2, w: env.x1 - env.x0, h: env.y1 - env.y0 })
    }
    for (const id of [...sweeps.keys()]) if (!seen.has(id)) sweeps.delete(id)
    shownBadges = rects
    return rects
  }
  let shownBadges = []
  /** Each badge's swept box, by agent id; see `sweep`. */
  const sweeps = new Map()
  const lastView = new Float32Array(16)
  let ready = false
  let pending = null

  /**
   * A world is applied in steps, a task each: the roster, then the ground the zones moved,
   * then the grass. A world that arrives while one is going in waits, and only the newest
   * waiting one is applied.
   */
  let waiting = null
  let applying = false
  function queueWorld(world) {
    waiting = world
    if (!applying) drainWorlds()
  }

  async function drainWorlds() {
    applying = true
    try {
      while (waiting && !stopped) {
        const world = waiting
        waiting = null
        await applyWorld(world)
      }
    } finally {
      applying = false
    }
  }

  async function applyWorld(world) {
    const now = Date.now()
    const { threads, ships } = worldToThreads(world, now)
    const list = withErrands(threads)
    const sizes = new Map()
    for (const t of list) sizes.set(t.project, (sizes.get(t.project) || 0) + 1)
    zoneSizes = sizes
    const layout = shipLayout([...sizes.values()], ships.length)
    ring = layout.ring
    colony.setShips(
      ships.map((ship, i) => ({ ...ship, cell: layout.ships[i] })),
      layout.fill,
      { rebuild: false }
    )
    colony.setThreads(list, new Set(), new Set(), known)
    for (const t of list) known.add(t.id)
    postZones()
    if (!framedOnce) {
      framedOnce = true
      home({ snap: true })
    }
    if (selectedId && !colony.agentFor(selectedId)) select(null, { notify: true })
    await nextTask()
    colony.settleGround()
    await nextTask()
    colony.buildGrass()
  }

  // The loop starts once the first frame has something to show; see the end of `start`.
  let running = false
  let booted = false
  let shown = true
  function setVisible(on) {
    shown = on
    ambience.setVisible(on)
    if (!booted) return
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
        if (ready) queueWorld(data.world)
        else pending = data.world
        break
      case 'home':
        select(null)
        home()
        break
      case 'focus':
        select(data.id, { fly: true })
        break
      case 'zone':
        showZone(data.project)
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
      declutterPlates(dt)
      if (selectedId && !colony.agentFor(selectedId)) select(null, { notify: true })
      ambience.update(dt, engine.camera, soundWorld())
    },
  })

  // For poking at the world from a dev console and the visual checks. Not in the build.
  if (import.meta.env.DEV) window.agentWorld = { engine, rig, colony, settings, select, plates: () => shownPlates, badges: () => shownBadges }

  // The rest of boot, one short task at a time: models, the ground, the grass, the shaders,
  // and then the first frame. Only after that frame is the world ready.
  const settle = (p) => p.then(() => null, (err) => err)
  const [kitError, crewError] = await Promise.all([settle(loadKit()), settle(loadCrew())])
  if (kitError || crewError) {
    console.error(kitError || crewError)
    fatal('assets-failed')
    return
  }
  await nextTask()
  colony.astronauts.setRig(crewRig())
  await nextTask()
  colony.onAssetsReady()
  await nextTask()
  colony.buildGrass()
  await nextTask()
  // Every material compiles now, in parallel where the driver allows, rather than all at
  // once inside the first frame.
  // Compiled against the buffer the scene is really drawn into: a program built for the
  // canvas (tone mapped, sRGB) is not the one the post chain's linear buffer asks for.
  const target = engine.composer?.readBuffer ?? null
  engine.renderer.setRenderTarget(target)
  const compiling = engine.renderer.compileAsync(engine.scene, engine.camera)
  engine.renderer.setRenderTarget(null)
  await compiling
  await nextTask()
  // The post-processing passes draw with materials of their own, outside the scene.
  const passes = postMaterials(engine.composer)
  if (passes.children.length) await engine.renderer.compileAsync(passes, engine.camera)
  passes.children[0]?.geometry.dispose()
  await nextTask()
  // Textures upload a few at a time rather than all inside the first frame.
  let uploaded = 0
  for (const texture of sceneTextures(engine.scene)) {
    engine.renderer.initTexture(texture)
    if (++uploaded % 3 === 0) await nextTask()
  }
  await nextTask()
  if (stopped) return
  booted = true
  if (shown) {
    running = true
    engine.start()
    await afterFrame()
  }
  ready = true
  post('ready')
  if (pending) queueWorld(pending)
  pending = null
}
