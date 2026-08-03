# M8 wallet ownership and room sessions

The multiplayer room must not treat a checksum-valid Kei address as identity.
An address is public: anybody can copy one into Colyseus join options. If the
room keyed its shared press tally by that claim, an attacker could bank another
wallet's presses and receive or discard its recipient-bound claim proof. They
could not spend the victim's coins, but they could destroy the victim's reward
flow.

`shared/session-auth.ts`, `server/auth.ts`, and `server/room.ts` put a
proof-of-control boundary before that shared state, and `src/ownership.ts` plus
`src/multiplayer.ts` are the browser's end of it.

## Wire flow

1. The socket joins with a claimed Kei address. The room checksum-validates it,
   but holds it only in a private pending challenge. It is not an authenticated
   player yet.
2. The room sends that socket an `auth:challenge` message containing the
   structured challenge and its Blake2b-256 hash. A room-owned 10-second
   deadline starts with it.
3. The wallet parses the structure, **recomputes the digest itself**, checks it
   against the one that arrived, checks the challenge names its own address, and
   signs with the same inherited Nano/Banano Ed25519-with-Blake2b key that
   controls that address. It returns `{ "signature": "..." }` in `auth:proof`.
4. The room deletes the pending challenge **before** verification awaits,
   verifies against the public key encoded by the address, and sends one
   `auth:result`. Only a successful proof moves the session into the authorized
   map read by `press` and `bank`. A timeout or terminal proof failure closes
   the unauthenticated socket; success and `onLeave` cancel the deadline.

The signed challenge is canonical JSON under the explicit domain
`keicoin.org/button/session-ownership/v1`. It binds:

- the claimed Kei address;
- the Colyseus room id;
- the Colyseus session id;
- a server-generated opaque player id;
- an independent server-generated 256-bit nonce; and
- the protocol domain and version.

The secure default creates both opaque values with the runtime CSPRNG. The
factory is injectable only when the room class is constructed, so tests can be
deterministic; the deadline scheduler is injectable at that same trusted seam.
Socket and room options cannot replace either policy.

## Domain separation, and why the wallet re-derives the digest

The room sends a digest alongside the challenge. A client that simply signed
that digest would have handed the server a **signing oracle**: the server names
32 bytes, the wallet signs them, and the bytes a hostile server would choose are
the hash of a Kei send. So the digest travels as a checkable courtesy, and
`src/ownership.ts` signs only what it derived itself from the parsed structure.
A mismatch is refused rather than silently corrected.

That leaves the digests themselves, which must not be confusable with anything
a node would accept. `@keicoin/core` hashes blocks two ways, and this is
neither:

| what | the preimage begins with |
|---|---|
| consensus block | `blake2b-256("kei-block-v1")`, 32 raw bytes |
| local-only block | the ASCII `kei-block-local-v0` and a newline |
| session ownership | the ASCII `keicoin.org/button/session-ownership/v1` and a newline |

`test/session-auth.test.ts` asserts this against the real hasher rather than
against this table: it signs a real `state` block and a real local-hashed block
with a real key and shows neither signature authenticates a session, and shows
the accepted ownership signature is not the signature on either block.

The domain and the version are also inside the signed JSON, so a wallet and a
room on different versions disagree on the digest rather than agreeing by
accident. Field values cannot be smuggled across each other's boundaries
because `canonicalJson` quotes and escapes every one of them.

## Threat model

Protected:

- Copying a victim address does not authorize a session. `test/arena.test.ts`
  proves this over a real socket: the attacker signs the exact challenge the
  room issued, with their own key, and is refused.
- A bad or malformed proof consumes its challenge and cannot be retried on the
  same connection. The room closes that still-unauthenticated socket.
- A client cannot occupy room capacity forever without proving its wallet: the
  deadline covers both waiting for a proof and verification itself.
- Concurrent copies of one proof cannot both authorize because challenge
  consumption happens before the verifier yields.
- A signature copied to another session, room, player id, nonce, or address
  verifies against a different digest and fails.
- Leaving while verification is in flight deletes the attempt marker, so a late
  verifier cannot resurrect a disconnected session.
- Before authentication, neither presses nor banks touch the shared
  address-keyed `PressRegistry`, and the issuer is never called.
- Disconnecting after authentication removes local session identity but not
  already observed presses. The owner can prove the wallet again and bank them.
- A wallet cannot be tricked into signing a block, and an ownership signature
  cannot be replayed at a node as one.
- The address-only `/game/bank` route is **closed** whenever the room is
  running (`bankingPolicy` in `server/arena.ts`), so an attacker cannot answer
  the authenticated path by posting to the unauthenticated one.

Trusted:

- The game server, its CSPRNG, and the code that constructs the room.
- The wallet implementation that holds the player's private key, and — see
  below — the game code that now derives it.
- The authenticated, encrypted transport used in deployment. The signature
  proves wallet control; TLS still protects availability and message privacy.

Not protected:

- **An authenticated wallet can still inflate its own tally.** The room caps a
  press *message* at ten (`server/presses.ts`) but does not rate-limit how many
  messages a session sends, so a scripted client can observe more presses than a
  hand could make. What bounds the damage is the issuer's payout rate cap in
  `server/game.ts`, exactly as it did in single-player. The boundary this
  milestone adds is *whose* presses can be spent, not *how many*. A per-address
  observation ceiling is the obvious next control and is not built.
- This is not human identity, bot detection, or proof that a physical finger
  pressed the button.
- It is not a bearer login token and authorizes no other room, HTTP route, game,
  or chain transaction.
- Multiple independently authenticated sessions for the same wallet are
  allowed. They share that wallet's tally because they proved the same key.
- A dropped socket is not transparently reconnected. The client rejoins and
  re-proves on the next bank; presses made while it was down were observed by
  nobody and do not become payable.

## Where the player's key lives, and what that costs

The SDK deliberately keeps the private key inside `KeiClient` and exposes no
arbitrary-message signer (SPEC §6.3), so there was no supported way for game
code to answer a challenge. Button therefore **provisions the player's seed
itself** — `src/ownership.ts` reads or creates it through the SDK's own
`defaultSeedStore` and `seedStoreKey`, hands it to `Kei.start({ seed })`, which
SPEC §6.7 documents as a first-class option, and closes over the derived key.
Same store, same key, same wallet: a returning player is the same player.

This reverses the earlier draft of this document, which said the correct state
was an unwired room. The reasoning for reversing it:

- The trust boundary this milestone is about is server-side. The key was
  already in this page's heap and this origin's storage; game code reading it
  gives an attacker no capability they did not have.
- The server still never sees a secret, and no press or bank is authorised by
  anything but a signature.
- Deriving through `keyPairFromSeed` keeps the seed and private key on the
  SDK's scrub list, so neither reaches a log, an error, or a network request.
- The signer is narrow by construction: it takes a challenge, not a hash, and
  it will not sign one naming another wallet.

What it genuinely costs is the SDK's *structural* guarantee that game code
cannot sign at all. Button is reference code, and a reader who copies this
pattern for something less careful will not get these four properties for free.

**The gap to close upstream:** `kei-transaction` should grow a narrow,
domain-aware `wallet.signOwnershipChallenge(challenge)` that (1) requires this
exact typed domain and version rather than signing arbitrary hashes, (2)
requires the challenge address to equal the wallet's own, (3) validates the
bounded fields and recomputes the canonical digest itself, (4) signs inside the
existing private-key boundary, and (5) returns only the signature. It can reuse
`signHash` without exposing the seed. When it exists, `src/ownership.ts` should
be deleted and `src/multiplayer.ts` pointed at it; nothing else here changes.

## Deployment shape

`bun run dev` runs the room on its own port (`server/arena.ts`) because
Colyseus brings its own HTTP matchmaking server and WebSocket upgrade. The
catalogue advertises it, and `/game/bank` is closed for as long as it is up.
`BUTTON_MULTIPLAYER=off` asks for the single-player HTTP path deliberately.

The deployed Cloudflare Worker runs **no room at all** — a Durable Object is not
a Colyseus server — so `keicoin.org/examples/button` is single-player, the
catalogue carries no `arena`, and `/game/bank` is the open path there. That is
a real remaining M8 gap, not a configuration choice: multiplayer works locally
and is not deployed.
