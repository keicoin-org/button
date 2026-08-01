/**
 * A green button on a pole, a screen showing what it is worth, and somebody
 * standing nearby who will sell you a better hand.
 *
 * Babylon.js and nothing else — the SDK is framework-agnostic and the demo does
 * its own rendering (SPEC §8). Nothing in this file knows what Kei is: it takes
 * a state object and paints it, and reports presses and clicks back.
 */

/*
 * Babylon 9 is assembled from pure modules plus registrars that attach them to
 * the engine, and a bundler is free to drop an import that exists only for its
 * side effects — including the barrel's. Importing `@babylonjs/core` and hoping
 * gets a build where every light dies on `createUniformBuffer is not a function`.
 *
 * So the extensions this scene needs are asked for by calling the functions
 * Babylon provides for exactly this, which nothing can tree-shake away.
 */
import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PointerEventTypes,
  RegisterFullEngineExtensions,
  RegisterRay,
  RegisterShadowGeneratorSceneComponent,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
  type AbstractMesh,
} from '@babylonjs/core/pure.js'

import type { EconomyState } from './economy.js'
import { BALANCE_SIZE, SHOP_SIZE, drawBalance, drawPop, drawShop, type Row } from './screen.js'

type Ctx = CanvasRenderingContext2D

export interface World {
  onPress(handler: () => void): void
  onBuy(handler: (target: string) => void): void
  onMob(handler: (mob: string) => void): void
  update(state: EconomyState): void
  pop(text: string): void
  dispose(): void
}

const CAP_UP = 2.79
const CAP_DOWN = 2.66

export function createWorld(canvas: HTMLCanvasElement): World {
  // Here rather than at module scope: the bundler puts these calls before the
  // classes they patch have finished initialising, and the scene component
  // registrar then attaches to `undefined`. Both are idempotent.
  RegisterFullEngineExtensions()
  RegisterShadowGeneratorSceneComponent(ShadowGenerator)
  // Picking is ray casting, and ray casting is an opt-in module: without this
  // `scene.pick` quietly misses every mesh in the world and nothing is clickable.
  RegisterRay()

  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false })
  const scene = new Scene(engine)
  scene.clearColor = new Color4(0.055, 0.078, 0.09, 1)
  scene.ambientColor = new Color3(0.2, 0.24, 0.22)

  // Explicit, because the camera taking the canvas is not the same thing as the
  // scene listening for picks, and without this a click reaches the camera and
  // nothing else.
  scene.attachControl()

  const camera = new ArcRotateCamera('camera', -Math.PI / 2 + 0.2, 1.18, 13.5, new Vector3(-1.3, 2.1, 0), scene)
  camera.attachControl(canvas, true)
  camera.lowerRadiusLimit = 7
  camera.upperRadiusLimit = 24
  camera.upperBetaLimit = 1.45
  camera.wheelPrecision = 24

  const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), scene)
  sky.intensity = 0.75
  sky.groundColor = new Color3(0.1, 0.14, 0.12)

  const sun = new DirectionalLight('sun', new Vector3(-0.45, -1, 0.55), scene)
  sun.position = new Vector3(9, 14, -9)
  sun.intensity = 1.1

  const shadows = new ShadowGenerator(1024, sun)
  shadows.usePercentageCloserFiltering = true

  // ------------------------------------------------------------------- ground

  const ground = MeshBuilder.CreateGround('ground', { width: 70, height: 70 }, scene)
  ground.material = solid(scene, 'grass', '#1b2b21')
  ground.receiveShadows = true

  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * Math.PI * 2 + 0.4
    const distance = 13 + ((i * 7) % 9)
    const tree = MeshBuilder.CreateCylinder(`tree${i}`, { diameterTop: 0, diameterBottom: 1.6, height: 3 + (i % 4) }, scene)
    tree.position.set(Math.cos(angle) * distance, (3 + (i % 4)) / 2, Math.sin(angle) * distance)
    tree.material = solid(scene, `tree${i}`, i % 2 === 0 ? '#20402c' : '#1a3524')
  }

  // ------------------------------------------------------------------- button

  const plinth = MeshBuilder.CreateCylinder('plinth', { diameter: 2.3, height: 0.35 }, scene)
  plinth.position.y = 0.17
  plinth.material = solid(scene, 'plinth', '#2a3138')
  plinth.receiveShadows = true

  const pole = MeshBuilder.CreateCylinder('pole', { diameter: 0.34, height: 2.2 }, scene)
  pole.position.y = 1.3
  pole.material = solid(scene, 'pole', '#525f6b')

  const housing = MeshBuilder.CreateCylinder('housing', { diameter: 1.55, height: 0.42 }, scene)
  housing.position.y = 2.55
  housing.material = solid(scene, 'housing', '#8b2f2f')

  const cap = MeshBuilder.CreateCylinder('cap', { diameter: 1.28, height: 0.34 }, scene)
  cap.position.y = CAP_UP
  const capMaterial = solid(scene, 'cap', '#2fbf5e')
  capMaterial.emissiveColor = new Color3(0.06, 0.28, 0.14)
  cap.material = capMaterial

  for (const mesh of [pole, housing, cap]) shadows.addShadowCaster(mesh)

  // -------------------------------------------------------------- the screen

  const strutLeft = MeshBuilder.CreateBox('strutLeft', { width: 0.09, height: 1.3, depth: 0.09 }, scene)
  strutLeft.position.set(-0.85, 3.3, 0)
  const strutRight = strutLeft.clone('strutRight')
  strutRight.position.x = 0.85
  for (const strut of [strutLeft, strutRight]) strut.material = solid(scene, 'strut', '#3d4750')

  const balance = createPanel(scene, 'balance', 3.4, 1.9125, BALANCE_SIZE)
  balance.mesh.position.set(0, 4.35, 0)

  const backing = MeshBuilder.CreateBox('backing', { width: 3.6, height: 2.1, depth: 0.12 }, scene)
  backing.position.set(0, 4.35, 0.08)
  backing.material = solid(scene, 'backing', '#161d1a')
  shadows.addShadowCaster(backing)

  // ---------------------------------------------------------------- the shop

  const shopAt = new Vector3(-5.8, 0, 1.4)

  const counter = MeshBuilder.CreateBox('counter', { width: 2.8, height: 1, depth: 0.9 }, scene)
  counter.position.set(shopAt.x, 0.5, shopAt.z + 0.75)
  counter.material = solid(scene, 'counter', '#4a3a2a')
  counter.receiveShadows = true
  shadows.addShadowCaster(counter)

  const body = MeshBuilder.CreateCapsule('npcBody', { radius: 0.36, height: 1.5 }, scene)
  body.position.set(shopAt.x, 0.75, shopAt.z)
  body.material = solid(scene, 'npcBody', '#3f6ea8')

  const head = MeshBuilder.CreateSphere('npcHead', { diameter: 0.56 }, scene)
  head.position.set(shopAt.x, 1.62, shopAt.z)
  head.material = solid(scene, 'npcHead', '#d8b48c')

  const hat = MeshBuilder.CreateCylinder('npcHat', { diameter: 0.66, height: 0.22 }, scene)
  hat.position.set(shopAt.x, 1.92, shopAt.z)
  hat.material = solid(scene, 'npcHat', '#8b2f2f')

  for (const mesh of [body, head, hat]) shadows.addShadowCaster(mesh)

  const shop = createPanel(scene, 'shop', 2.7, 2.194, SHOP_SIZE)
  shop.mesh.position.set(shopAt.x, 3.1, shopAt.z + 0.2)
  shop.mesh.rotation.y = 0.28

  const shopPost = MeshBuilder.CreateBox('shopPost', { width: 0.12, height: 2.2, depth: 0.12 }, scene)
  shopPost.position.set(shopAt.x, 1.1, shopAt.z + 0.35)
  shopPost.material = solid(scene, 'shopPost', '#4a3a2a')

  // -------------------------------------------------------------- interaction

  const pressHandlers: Array<() => void> = []
  const buyHandlers: Array<(target: string) => void> = []
  const mobHandlers: Array<(mob: string) => void> = []
  const pressable = new Set<AbstractMesh>([cap, housing, pole, plinth])
  const mobs = new Map<AbstractMesh, string>()
  for (let index = 1; index <= 3; index++) {
    const slime = MeshBuilder.CreateSphere(`slime-${index}`, { diameter: 1.05, segments: 12 }, scene)
    slime.scaling.y = 0.65
    slime.position.set(3.2 + index * 1.35, 0.35, -1.2 + (index % 2) * 2.1)
    slime.material = solid(scene, `slimeMaterial-${index}`, '#6bbf59')
    shadows.addShadowCaster(slime)
    mobs.set(slime, `slime-${index}`)
  }
  let rows: Row[] = []

  let pressedFor = 0

  const doPress = (): void => {
    pressedFor = 0.09
    for (const handler of pressHandlers) handler()
  }

  // A click is a press and a release in roughly the same place. Doing it by hand
  // rather than taking Babylon's POINTERPICK keeps dragging the camera from
  // buying an upgrade on the way past, and keeps the two cases — a mesh, and a
  // spot on a screen — in one place.
  let downAt: { x: number; y: number } | null = null

  scene.onPointerObservable.add((info) => {
    if (info.type === PointerEventTypes.POINTERDOWN) {
      downAt = { x: scene.pointerX, y: scene.pointerY }
      return
    }
    if (info.type !== PointerEventTypes.POINTERUP || !downAt) return

    const travelled = Math.hypot(scene.pointerX - downAt.x, scene.pointerY - downAt.y)
    downAt = null
    if (travelled > 6) return

    const pick = scene.pick(scene.pointerX, scene.pointerY)
    if (!pick?.hit || !pick.pickedMesh) return

    if (pressable.has(pick.pickedMesh)) {
      doPress()
      return
    }
    const mob = mobs.get(pick.pickedMesh)
    if (mob) {
      pick.pickedMesh.setEnabled(false)
      for (const handler of mobHandlers) handler(mob)
      return
    }
    if (pick.pickedMesh === shop.mesh) {
      const uv = pick.getTextureCoordinates()
      if (!uv) return
      // v runs from the bottom of the texture; the rows were laid out from the top.
      const y = (1 - uv.y) * SHOP_SIZE.height
      const row = rows.find((candidate) => y >= candidate.top && y <= candidate.bottom)
      if (row) for (const handler of buyHandlers) handler(row.target)
    }
  })

  const onKey = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' && event.code !== 'Enter') return
    event.preventDefault()
    if (!event.repeat) doPress()
  }
  window.addEventListener('keydown', onKey)

  // -------------------------------------------------------------------- pops

  const pops = Array.from({ length: 12 }, (_, index) => createPop(scene, index))
  let nextPop = 0

  // ------------------------------------------------------------------- frame

  let pending: EconomyState | null = null
  let repaintAt = 0

  scene.onBeforeRenderObservable.add(() => {
    const delta = engine.getDeltaTime() / 1000

    pressedFor = Math.max(0, pressedFor - delta)
    const target = pressedFor > 0 ? CAP_DOWN : CAP_UP
    cap.position.y += (target - cap.position.y) * Math.min(1, delta * 22)

    for (const pop of pops) {
      if (pop.life <= 0) continue
      pop.life -= delta
      pop.mesh.position.y += delta * 1.4
      pop.mesh.visibility = Math.max(0, Math.min(1, pop.life / 0.5))
      if (pop.life <= 0) pop.mesh.setEnabled(false)
    }

    // Presses can arrive twenty times a second and a canvas repaint is not free,
    // so the screens settle at twenty frames rather than every state change.
    const now = performance.now()
    if (pending && now >= repaintAt) {
      const state = pending
      pending = null
      repaintAt = now + 50
      drawBalance(balance.ctx, state)
      balance.texture.update()
      rows = drawShop(shop.ctx, state)
      shop.texture.update()
    }
  })

  engine.runRenderLoop(() => scene.render())
  const onResize = (): void => engine.resize()
  window.addEventListener('resize', onResize)

  return {
    onPress(handler) {
      pressHandlers.push(handler)
    },
    onBuy(handler) {
      buyHandlers.push(handler)
    },
    onMob(handler) {
      mobHandlers.push(handler)
    },
    update(state) {
      pending = state
    },
    pop(text) {
      const pop = pops[nextPop++ % pops.length]!
      drawPop(pop.ctx, 256, 128, text)
      pop.texture.update()
      pop.mesh.position.set(cap.position.x + (Math.random() - 0.5) * 0.7, CAP_UP + 0.55, cap.position.z - 0.2)
      pop.mesh.setEnabled(true)
      pop.mesh.visibility = 1
      pop.life = 0.8
    },
    dispose() {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
      engine.stopRenderLoop()
      scene.dispose()
      engine.dispose()
    },
  }
}

// ----------------------------------------------------------------- materials

function solid(scene: Scene, name: string, hex: string): StandardMaterial {
  const material = new StandardMaterial(name, scene)
  material.diffuseColor = Color3.FromHexString(hex)
  material.specularColor = new Color3(0.05, 0.06, 0.06)
  return material
}

interface Panel {
  mesh: Mesh
  texture: DynamicTexture
  ctx: Ctx
}

/** A canvas on a plane, lit by nothing, so the colours drawn are the colours seen. */
function createPanel(scene: Scene, name: string, width: number, height: number, pixels: { width: number; height: number }): Panel {
  const mesh = MeshBuilder.CreatePlane(name, { width, height }, scene)
  const texture = new DynamicTexture(`${name}Texture`, pixels, scene, false)
  const material = new StandardMaterial(`${name}Material`, scene)
  material.diffuseTexture = texture
  material.emissiveColor = new Color3(1, 1, 1)
  material.disableLighting = true
  material.backFaceCulling = false
  mesh.material = material
  return { mesh, texture, ctx: texture.getContext() as unknown as Ctx }
}

interface Pop extends Panel {
  life: number
}

function createPop(scene: Scene, index: number): Pop {
  const mesh = MeshBuilder.CreatePlane(`pop${index}`, { width: 1, height: 0.5 }, scene)
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL
  mesh.isPickable = false
  mesh.setEnabled(false)

  const texture = new DynamicTexture(`pop${index}Texture`, { width: 256, height: 128 }, scene, false)
  texture.hasAlpha = true

  const material = new StandardMaterial(`pop${index}Material`, scene)
  material.diffuseTexture = texture
  material.emissiveColor = new Color3(1, 1, 1)
  material.disableLighting = true
  material.useAlphaFromDiffuseTexture = true
  material.backFaceCulling = false
  mesh.material = material

  return { mesh, texture, ctx: texture.getContext() as unknown as Ctx, life: 0 }
}
