# Button

A green button on a pole. Press it, get coins, buy something that presses
better. It is the Kei demo (SPEC §8), and it is deliberately a clicker: the loop
is legible in three seconds, and it exercises every SDK primitive without
anybody having to invent a reason.

```sh
bun install
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

### What the screen is allowed to call a balance

A clicker has to answer the finger immediately, and a chain does not. The screen
therefore shows three deliberately different figures:

- **COUNTED** is the headline tally. It includes this browser's unbanked and
  clearing rewards, so it moves on the press itself; it is not a balance.
- **AVAILABLE TO SPEND** is the confirmed balance read from the chain.
- **CLEARING** is counted but unconfirmed and explicitly not spendable yet.

`src/ledger.ts` keeps each coin in one accounting stage:

| stage | what it means |
|---|---|
| `unbanked` | pressed for, counted by this browser, the server has not been asked yet |
| `banking` | the server is pricing them; no proof back. A batch whose answer was lost stays here rather than going back to `unbanked`, because the server may already have published a root for it — the browser retries it under the same batch id until it has the proof or the server says it signed nothing |
| `settling` | on their way: something is out that the chain is expected to pay out — a signed proof waiting on this wallet's claim, or a payment waiting on the issuer's mint |
| `confirmed` | accepted chain state (SPEC §5.5) — the balance, and the only spendable figure |

Affordability and the client-side gate before `/game/order` read only
`confirmed`; the server then checks the chain itself and remains authoritative.
Moving a reward between stages keeps COUNTED stable, while a server rate cap or
failed claim rolls it back to the supported amount. All claim writes — press
banks and mob drops alike — share one serialized queue through completion, so
two SDK sweeps cannot race the same proof.

CLEARING is session bookkeeping, not chain state. Reloading loses unbanked
presses and in-memory claim bundles, and unrelated inbound transfers can make the
clearing estimate briefly conservative. Neither case can increase AVAILABLE TO
SPEND or make a shop row affordable.

### Why banking instead of minting

Minting per press would put every player's reward on the issuer's chain, and one
account has one chain (SPEC §5.6.1) — so the issuer becomes a global write lock
and the queue behind it becomes the game.

So presses are batched, and every player who banked in the same window ends up in
**one issuer block**. Each of them then writes their own claim, from their own
account, in parallel, with no contention (SPEC §5.5). With one player it is a
batch of one and the code is identical, which is the property that matters: this
does not need rewriting when there are a thousand.

### Why a bank carries a batch id

Banking empties the press tally and publishes an issuer block, and both are done
before the response is written. So a response lost after that — a dropped
connection, a gateway's own error page, an eviction between the commit and the
reply — leaves the player paid and unable to collect, because the proof is the
only route to the coins and it went with the response.

The client therefore names each attempt, and reuses that name when it retries.
The server answers a name it has already published with the proof it published,
so a retry recovers the first payout instead of buying a second one, and no
second root is minted for presses that were already paid for. Retries are only
safe to make when the two failures can be told apart, so `post()` distinguishes
a refusal the game *sent* — nothing was signed, start again — from a failure
that says nothing about what the game did.

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
server/rpc.ts         what the public is allowed to ask the node for — reads and its own blocks, never a mint
src/economy.ts        every line of Kei in the client
src/ledger.ts         where a coin is — counted, clearing, or confirmed. Pure arithmetic.
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

- **The server counts the presses, and bounds them by elapsed time.** One press
  is one request that reached the server, drawn against a token bucket per proven
  address: 25 a second sustained however often the server is asked, plus two
  seconds' worth of headroom for a session that has been idle, and no more
  however long it idles. An address whose on-chain machines press for it earns
  that rate on top — nine Auto-Pressers Mk II are 27 a second and are not clipped
  for it, because the ceiling reads what they own off the chain rather than out of
  the request. What is left is a wallet whose holder has proved they hold it (#10)
  pressing at about a finger's speed, rather than a client that could claim any
  number it liked. M8 adds Colyseus, and presses become observed by other players
  too.
- **The chain is a mock, and `/rpc` is public.** M2 is the real node; M3 points
  `/rpc` at it, and nothing above that line changes. The browser is a real wallet
  and needs a node, so the path stays open — but only for reads and for blocks
  the caller signed. The mock's faucet is not on it: it took its amount from the
  request body, and one POST minted a million Kei, which at the exchange desk is
  COIN's entire max supply and the end of the shop for everybody (#30). A
  starting balance comes from `/game/faucet` instead: a fixed ten Kei, to a
  wallet that has proved it holds its key, once an hour, and only into an empty
  one. Free keypairs mean an attacker can still ask many times — but each ask
  costs a challenge, a signature and an hour, which is a hundred thousand of them
  to reach the cap rather than two curls.
- **The issuer seed is generated per run** unless `KEI_GAME_SEED` is set. A new
  issuer means new asset ids, which is fine here because the ledger is new too.

## Controls

Click the button or press space. Drag to look, scroll to zoom. Click a row on
the shop board to buy it.

MIT.
