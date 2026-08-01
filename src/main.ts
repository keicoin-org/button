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

world.onMob((mob) => {
  void economy.loot(mob)
})

economy.on((state) => world.update(state))
world.update(economy.state)

// Auto-pressers press without a pointer, so the screen has to be told.
setInterval(() => world.update(economy.state), 500)

window.addEventListener('beforeunload', () => economy.close())
