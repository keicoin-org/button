# Button

A green button on a pole. Press it, get coins, buy something that presses
better. It is the Kei demo (SPEC §8), and it is deliberately a clicker: the loop
is legible in three seconds, and it exercises every SDK primitive without
anybody having to invent a reason.

```sh
bun install
bun run link-sdk     # once — links ../kei-transaction (SPEC §10.5)
bun run dev          # http://localhost:7777
```

> **M1.** The chain underneath is an in-memory mock served over HTTP by the same
> process. It dies when you stop the server, and nothing here is worth anything.

## The point

Every number in this game is on a chain, and none of it is in a database. There
is no `users` table, no `balances` table, no `inventory` table, and no save file
— the game server has no persistent storage of any kind. Stop it, start it, and
a player's coins and upgrades are still theirs, because they were never the
server's to hold.

What the server does own is what a game server *should* own: what a press is
worth, and what things cost.

## The loop

| | |
|---|---|
| **Press** | Click the button, or hit space. Presses accumulate unbanked. |
| **Bank** | Every 20 presses (or 3 seconds) the client asks the server to pay for them. The server adds you to the next batch. |
| **Claim** | The batch becomes **one** `commit` block; you get a proof and your own wallet writes the claim. |
| **Buy** | Click a row on the shop board. You transfer coins; the shopkeeper mints you the item and burns the coins. |
| **Exchange** | Optional. Pay Kei, get coins at the posted rate. Turn it off and the game is unchanged. |

### Why banking instead of minting

Minting per press would put every player's reward on the issuer's chain, and one
account has one chain (SPEC §5.6.1) — so the issuer becomes a global write lock
and the queue behind it becomes the game.

So presses are batched, and every player who banked in the same window ends up in
**one issuer block**. Each of them then writes their own claim, from their own
account, in parallel, with no contention (SPEC §5.5). With one player it is a
batch of one and the code is identical, which is the property that matters: this
does not need rewriting when there are a thousand.

### Why buying takes two signatures

The game cannot sign for a player's wallet, so a purchase is always the player
signing a transfer and the issuer signing a delivery (SPEC §6.3). A transfer
carries no memo, so the shop takes the order first and matches the arrival to it
— and delivers nothing until the chain says the coins landed. The order is not
the purchase.

## Where things are

```
shared/catalogue.ts   what a press is worth and what upgrades cost — used by both halves
server/game.ts        the issuer: token, items, the batcher, the shop. The whole backend.
server/main.ts        one Bun server: the mock node at /rpc, the game at /game/*, the client at /
src/economy.ts        every line of Kei in the client
src/world.ts          Babylon: the button, the screen, the shopkeeper
src/screen.ts         what the two in-world screens draw
```

`src/economy.ts` is the file to read if you are here to learn the SDK. `server/game.ts`
is the file to read if you are here to learn what a game server still has to do.

## Playing with payments off

SPEC §8 requires the game to be enjoyable with payments disabled, so that is a
switch rather than a claim:

```sh
BUTTON_EXCHANGE=off bun run dev
```

The exchange desk disappears from the shop and Kei buys nothing. Everything else
— pressing, banking, claiming, buying upgrades with coins — is untouched, because
coins come from playing and never from paying.

With no server running at all, the page still loads and the button still presses;
it says on the screen that nothing is being banked.

## Honest about what this is not

- **The client counts its own presses.** In single-player nothing else can see
  them. There is a rate ceiling so the hole is worth a few coins rather than the
  supply, and that is all it is. M8 adds Colyseus, and presses become observed.
- **The chain is a mock.** M2 is the real node; M3 points `/rpc` at it, and
  nothing above that line changes.
- **The issuer seed is generated per run** unless `KEI_GAME_SEED` is set. A new
  issuer means new asset ids, which is fine here because the ledger is new too.

## Controls

Click the button or press space. Drag to look, scroll to zoom. Click a row on
the shop board to buy it.

MIT.
