/**
 * The two screens in the world.
 *
 * SPEC §8 asks for diegetic UI: the balance is a screen on a pole in front of
 * the button, not an HTML overlay. So both panels are canvases painted onto
 * planes, and the shop is clicked in the world like anything else — which is
 * also why `shopRows` hands back where it put each row, so a pick can be turned
 * back into the thing that was clicked.
 */

import type { EconomyState } from './economy.js'

type Ctx = CanvasRenderingContext2D

const FONT = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif'
const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace'

const INK = '#dff3e4'
const DIM = '#7d9686'
const GREEN = '#4ade80'
const AMBER = '#fbbf24'
const RED = '#f87171'

export const BALANCE_SIZE = { width: 640, height: 360 }
export const SHOP_SIZE = { width: 640, height: 520 }

export interface Row {
  /** An upgrade's sku, or the exchange desk. */
  target: string
  top: number
  bottom: number
}

const number = (value: number): string => Math.floor(value).toLocaleString('en-US')

function panel(ctx: Ctx, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#0e1a14'
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = '#1f3a2c'
  ctx.lineWidth = 6
  ctx.strokeRect(3, 3, width - 6, height - 6)
}

export function drawBalance(ctx: Ctx, state: EconomyState): void {
  const { width, height } = BALANCE_SIZE
  panel(ctx, width, height)

  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillStyle = DIM
  ctx.font = `600 26px ${FONT}`
  ctx.fillText('COINS', 34, 62)

  ctx.fillStyle = state.online ? GREEN : RED
  ctx.font = `700 108px ${MONO}`
  ctx.fillText(number(state.coins), 30, 168)

  ctx.font = `500 28px ${FONT}`
  ctx.fillStyle = INK
  ctx.fillText(`+${number(state.perPress)} per press`, 34, 222)
  if (state.pressesPerSecond > 0) {
    ctx.fillStyle = DIM
    ctx.fillText(`${state.pressesPerSecond}/s automatic`, 34, 262)
  }

  ctx.textAlign = 'right'
  ctx.fillStyle = state.unbanked > 0 ? AMBER : DIM
  ctx.font = `600 30px ${MONO}`
  ctx.fillText(state.unbanked > 0 ? `${number(state.unbanked)} unbanked` : 'all banked', width - 34, 222)

  ctx.fillStyle = DIM
  ctx.font = `500 24px ${MONO}`
  const kei = state.online ? `${state.kei.toFixed(3)} kei` : 'offline'
  ctx.fillText(state.banking ? 'banking…' : state.claiming > 0 ? 'claiming…' : kei, width - 34, 262)

  // The message line is the only place errors are shown, and they are shown as
  // the SDK wrote them (SPEC §6.1).
  ctx.textAlign = 'left'
  ctx.font = `500 21px ${FONT}`
  ctx.fillStyle = state.message ? AMBER : DIM
  wrap(ctx, state.message ?? state.address, 34, 306, width - 68, 26, 2)
}

export function drawShop(ctx: Ctx, state: EconomyState): Row[] {
  const { width, height } = SHOP_SIZE
  panel(ctx, width, height)

  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillStyle = INK
  ctx.font = `700 32px ${FONT}`
  ctx.fillText('SHOP', 30, 52)

  ctx.textAlign = 'right'
  ctx.fillStyle = GREEN
  ctx.font = `600 30px ${MONO}`
  ctx.fillText(`${number(state.coins)} coins`, width - 30, 52)

  const rows: Row[] = []
  let y = 78

  for (const upgrade of state.upgrades) {
    const top = y
    const bottom = y + 76
    rows.push({ target: upgrade.sku, top, bottom })

    ctx.fillStyle = '#132318'
    ctx.fillRect(18, top + 4, width - 36, 68)

    const affordable = state.coins >= upgrade.price
    ctx.textAlign = 'left'
    ctx.fillStyle = affordable ? INK : DIM
    ctx.font = `600 27px ${FONT}`
    ctx.fillText(upgrade.name, 34, top + 36)

    ctx.fillStyle = DIM
    ctx.font = `400 20px ${FONT}`
    ctx.fillText(upgrade.description, 34, top + 62)

    ctx.textAlign = 'right'
    ctx.fillStyle = affordable ? AMBER : DIM
    ctx.font = `600 26px ${MONO}`
    ctx.fillText(number(upgrade.price), width - 36, top + 36)

    if (upgrade.owned > 0) {
      ctx.fillStyle = GREEN
      ctx.font = `600 22px ${MONO}`
      ctx.fillText(`owned ×${upgrade.owned}`, width - 36, top + 62)
    }

    y = bottom + 6
  }

  if (state.exchange.open) {
    const top = y + 6
    rows.push({ target: 'exchange', top, bottom: top + 62 })

    ctx.fillStyle = '#1a2416'
    ctx.fillRect(18, top, width - 36, 58)
    ctx.textAlign = 'left'
    ctx.fillStyle = INK
    ctx.font = `600 25px ${FONT}`
    ctx.fillText('Exchange desk', 34, top + 36)

    ctx.textAlign = 'right'
    ctx.fillStyle = AMBER
    ctx.font = `600 23px ${MONO}`
    ctx.fillText(`0.1 kei → ${number(state.exchange.coinsPerKei / 10)}`, width - 36, top + 36)
  }

  return rows
}

/** A popup over the button: "+12". */
export function drawPop(ctx: Ctx, width: number, height: number, text: string): void {
  ctx.clearRect(0, 0, width, height)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `700 64px ${MONO}`
  ctx.lineWidth = 10
  ctx.strokeStyle = '#0b1410'
  ctx.strokeText(text, width / 2, height / 2)
  ctx.fillStyle = AMBER
  ctx.fillText(text, width / 2, height / 2)
}

function wrap(ctx: Ctx, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number): void {
  const words = text.split(' ')
  let line = ''
  let lines = 0

  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate
      continue
    }
    ctx.fillText(line, x, y + lines * lineHeight)
    lines++
    line = word
    if (lines >= maxLines - 1) break
  }
  if (lines < maxLines) ctx.fillText(line, x, y + lines * lineHeight)
}
