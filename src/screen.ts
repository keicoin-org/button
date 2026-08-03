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
import { clearingCovers, countedCoins, pendingCoins, spendableCoins } from './ledger.js'

type Ctx = CanvasRenderingContext2D

const FONT = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif'
const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace'

const INK = '#dff3e4'
const DIM = '#7d9686'
const GREEN = '#4ade80'
const AMBER = '#fbbf24'
const RED = '#f87171'

const KEI_COIN = new Image()
KEI_COIN.src = './kei-coin-64.png'

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

/**
 * Three numbers, and the words that keep them apart.
 *
 * The big one is COUNTED, because it is what this browser has counted and it
 * moves on the press itself — that is what makes the button feel like a button.
 * It is labelled rather than left to be read as a balance, and the two figures
 * under it say which part of it is which: AVAILABLE TO SPEND is the chain's,
 * CLEARING is owed. The shop only ever spends the first one.
 */
export function drawBalance(ctx: Ctx, state: EconomyState): void {
  const { width, height } = BALANCE_SIZE
  panel(ctx, width, height)

  const counted = countedCoins(state.coins)
  const spendable = spendableCoins(state.coins)
  const clearing = pendingCoins(state.coins)

  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillStyle = DIM
  ctx.font = `600 24px ${FONT}`
  ctx.fillText('COUNTED', 34, 58)

  ctx.textAlign = 'right'
  ctx.font = `500 24px ${FONT}`
  const rate = state.pressesPerSecond > 0
    ? `+${number(state.perPress)} per press · ${state.pressesPerSecond}/s auto`
    : `+${number(state.perPress)} per press`
  ctx.fillText(rate, width - 34, 58)

  // Ink rather than green: green is reserved for the confirmed figure below, so
  // that the colour never says "spendable" about a number that includes presses
  // the chain has not paid for yet.
  ctx.textAlign = 'left'
  ctx.fillStyle = state.online ? INK : RED
  ctx.font = `700 96px ${MONO}`
  ctx.fillText(number(counted), 30, 148)

  ctx.strokeStyle = '#1f3a2c'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(34, 170)
  ctx.lineTo(width - 34, 170)
  ctx.stroke()

  ctx.fillStyle = DIM
  ctx.font = `600 19px ${FONT}`
  ctx.fillText('AVAILABLE TO SPEND', 34, 198)
  ctx.fillText('CLEARING', 286, 198)

  ctx.fillStyle = state.online ? GREEN : RED
  ctx.font = `700 42px ${MONO}`
  ctx.fillText(number(spendable), 34, 240)

  ctx.fillStyle = clearing > 0 ? AMBER : DIM
  ctx.fillText(clearing > 0 ? number(clearing) : '0', 286, 240)

  // What the clearing figure is waiting on, in the words of the loop: banked
  // presses waiting for a proof, and proofs waiting for the chain.
  ctx.fillStyle = DIM
  ctx.font = `500 19px ${FONT}`
  ctx.fillText(clearing > 0 ? 'not spendable yet' : 'all confirmed', 286, 264)

  ctx.textAlign = 'right'
  ctx.fillStyle = DIM
  ctx.font = `500 22px ${MONO}`
  const kei = state.online ? `${state.kei.toFixed(3)} kei` : 'offline'
  // `state.banking` and not `coins.banking`, because a batch is still out while
  // its claim is being written and that stage is empty by then.
  const keiStatus = state.banking ? 'banking…' : state.claiming > 0 ? 'claiming…' : kei
  if (state.online && KEI_COIN.complete && KEI_COIN.naturalWidth > 0) {
    const labelWidth = ctx.measureText(keiStatus).width
    ctx.drawImage(KEI_COIN, width - 34 - labelWidth - 37, 216, 28, 28)
  }
  ctx.fillText(keiStatus, width - 34, 238)

  // The message line is the only place errors are shown, and they are shown as
  // the SDK wrote them (SPEC §6.1).
  ctx.textAlign = 'left'
  ctx.font = `500 21px ${FONT}`
  ctx.fillStyle = state.message ? AMBER : DIM
  wrap(ctx, state.message ?? state.address, 34, 302, width - 68, 26, 2)
}

export function drawShop(ctx: Ctx, state: EconomyState): Row[] {
  const { width, height } = SHOP_SIZE
  panel(ctx, width, height)

  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillStyle = INK
  ctx.font = `700 32px ${FONT}`
  ctx.fillText('SHOP', 30, 52)

  // The header spends the same word the balance screen does. A row is priced
  // against this figure and nothing else, so the number the shop shows is the
  // number it is willing to act on.
  const clearing = pendingCoins(state.coins)
  ctx.textAlign = 'right'
  ctx.fillStyle = GREEN
  ctx.font = `600 28px ${MONO}`
  ctx.fillText(`${number(spendableCoins(state.coins))} to spend`, width - 30, 44)

  ctx.fillStyle = clearing > 0 ? AMBER : DIM
  ctx.font = `500 19px ${MONO}`
  ctx.fillText(clearing > 0 ? `${number(clearing)} still clearing` : 'nothing clearing', width - 30, 68)

  const rows: Row[] = []
  let y = 88

  for (const upgrade of state.upgrades) {
    const top = y
    const bottom = y + 66
    rows.push({ target: upgrade.sku, top, bottom })

    ctx.fillStyle = '#132318'
    ctx.fillRect(18, top + 2, width - 36, 62)

    ctx.textAlign = 'left'
    ctx.fillStyle = upgrade.affordable ? INK : DIM
    ctx.font = `600 26px ${FONT}`
    ctx.fillText(upgrade.name, 34, top + 30)

    if (upgrade.owned > 0) {
      const nameWidth = ctx.measureText(upgrade.name).width
      ctx.fillStyle = GREEN
      ctx.font = `600 20px ${MONO}`
      ctx.fillText(`×${upgrade.owned}`, 44 + nameWidth, top + 30)
    }

    // The note shares a line with the description, so it is measured before the
    // description is drawn and the description gets what is left. The longest
    // one here is wider than the gap a shortfall leaves, and two strings drawn
    // over each other are not a legible answer to "why can I not buy this".
    ctx.font = `500 18px ${MONO}`
    const noteWidth = upgrade.note ? ctx.measureText(upgrade.note).width + 18 : 0

    ctx.fillStyle = DIM
    ctx.font = `400 19px ${FONT}`
    ctx.fillText(clip(ctx, upgrade.description, width - 70 - noteWidth), 34, top + 54)

    ctx.textAlign = 'right'
    ctx.fillStyle = upgrade.affordable ? AMBER : DIM
    ctx.font = `600 25px ${MONO}`
    ctx.fillText(number(upgrade.price), width - 36, top + 30)

    // Why a row is out of reach, in the row itself: how short it is, and
    // whether waiting for the clearing coins would be enough. Amber for the
    // second case, because that one is answered by waiting rather than pressing.
    if (upgrade.note) {
      ctx.fillStyle = clearingCovers(state.coins, upgrade.price) ? AMBER : DIM
      ctx.font = `500 18px ${MONO}`
      ctx.fillText(upgrade.note, width - 36, top + 54)
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

/** As much of `text` as fits `maxWidth`, cut on a character with an ellipsis. */
function clip(ctx: Ctx, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (ctx.measureText(text).width <= maxWidth) return text
  let cut = text.length
  while (cut > 0 && ctx.measureText(`${text.slice(0, cut)}…`).width > maxWidth) cut--
  return cut > 0 ? `${text.slice(0, cut)}…` : ''
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
