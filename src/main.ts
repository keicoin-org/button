/**
 * Press it, get coins.
 *
 * The whole game is three files: this one joins the world to the economy, and
 * neither of them knows anything about the other.
 */

import { connect } from './economy.js'
import { createWorld } from './world.js'

const canvas = document.getElementById('game') as HTMLCanvasElement
const world = createWorld(canvas)

const economy = await connect()

world.onPress(() => {
  economy.press()
  world.pop(`+${Math.floor(economy.state.perPress)}`)
  world.update(economy.state)
})

world.onBuy((target) => {
  if (target === 'exchange') void economy.topUp(0.1)
  else void economy.buy(target)
})

// A slime takes several hits, and only the server knows which one killed it —
// so the mesh goes away when the drop lands rather than when the pointer lifts.
// Clicking a slime the server refuses leaves it standing, which is the honest
// picture: nothing was paid for it.
world.onMob((mob) => {
  void economy.hit(mob).then((defeated) => {
    if (defeated) world.defeat(mob)
  })
})

economy.on((state) => world.update(state))
world.update(economy.state)

// Auto-pressers press without a pointer, so the screen has to be told.
setInterval(() => world.update(economy.state), 500)

window.addEventListener('beforeunload', () => economy.close())
