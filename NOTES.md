# x402 → Honeycoin off-ramp: what got built

## The flow

```
POST /api/quotes            (x402 pays TIER FEE  → your fee wallet)
  └─ handler creates the Honeycoin off-ramp, returns deposit address + expectedAmount
POST /api/quotes/:id/pay    (x402 pays AMOUNT    → Honeycoin's deposit address)
  └─ Honeycoin detects the deposit, converts, pays M-Pesa
POST /api/webhooks/honeycoin  → transaction_updated
GET  /api/quotes/:id          → status
```

Your wallet only ever receives fees. The payout amount goes from the developer's
wallet straight to the address Honeycoin generated, so you are never a custodian
and there is no relay transaction, no hot key on the server, and no second gas
fee.

## Two payments, not one

Option A costs you strict atomicity, and it is worth being explicit about why
rather than discovering it later. An x402 `exact` settlement pays exactly one
`payTo`. The amount has to go to Honeycoin's one-time deposit address, and the
fee has to go to you, so they cannot ride in the same transfer. Hence two
x402-gated calls.

The failure modes that leaves:

- Fee paid, deposit never sent. The off-ramp expires (`expiresAt`, currently
  about an hour), the quote flips to `expired`, you keep the fee. That is the
  same "reserve and ghost" case your original 0.5% proof-of-funds was designed
  to punish, except now the fee is real revenue instead of refundable collateral.
- Deposit sent, payout fails. Honeycoin refunds on-chain to `refundAddress`, or
  to the detected sender if you omit it, which is the developer's own wallet.
  You are not in that path at all.
- Fee charged for a quote that could not be created. Cannot happen: the handler
  calls Honeycoin *before* settlement, and `@x402/hono` cancels settlement when
  the handler returns 4xx/5xx.

## Corrections to earlier assumptions

- **Avalanche is out.** Honeycoin's chain enum is `eth, arb, base, matic, bsc,
  optimism, solana, tron, tempo`. Everything is on Base now. `config.ts` refuses
  to boot if `X402_NETWORK` has no Honeycoin chain mapping, so the two legs
  cannot silently drift onto different chains.
- **The off-ramp API takes `senderAmount` in crypto, not fiat.** You specify
  USDC in, Honeycoin converts to KES at its own rate when it detects the
  deposit. There is no "pay out exactly N KES" field, so `amount` on the wire
  is USDC. The fee schedule stays in KES and is converted at request time from
  Honeycoin's own FX Hub rate. See the fee section below.
- **`onAfterSettle` is the only trustworthy trigger.** The route handler runs
  before settlement (`await next()` then `processSettlement`), so nothing that
  matters keys off the handler.
- **Prices are atomic units, not `$` strings.** Honeycoin refunds any deposit
  that is not exactly `expectedAmount`, so the price is pinned to
  `{ asset, amount, extra }` and never goes through dollar-string parsing.

## Idempotency

`fee_tx_hash`, `deposit_tx_hash`, `deposit_address` and `honeycoin_tx_id` are all
UNIQUE, and the status transitions are guarded in the WHERE clause
(`markFunded` only fires on `quoted`/`fee_settled`). A replayed hook or a
duplicate webhook updates the same row instead of creating a second charge or
walking a completed payout backwards. `externalReference` on the off-ramp is the
quote id, which is what Honeycoin reconciles against on their side.

## Reconciliation

A 60s sweep expires dead quotes and polls `GET /transactions/{id}` for anything
deposited without a terminal webhook, and for failed payouts with no confirmed
refund. Per the docs, a `failed` webhook is not refund confirmation — only
`refundTransactionHash` is — so `refunded` is only set from the polled response.

## The KES fee table, priced off Honeycoin FX Hub

`FEE_BANDS_KES` in `config.ts` is your table, verbatim, still in shillings.
The KES/USDC rate comes from `GET /api/b2b/fx/rate?from=USDC&to=KES`.

Pyth was the plan and Pyth has no USD/KES feed, which `find-feeds` confirmed.
That turned out fine, and arguably better than the original plan: Honeycoin's
desk is the one that will actually convert the deposit, so its rate already
carries their spread. A mid-market oracle price would have been more precise
about a number that is not the number being applied. It is also one fewer
provider to onboard, key, and monitor, on an endpoint you are already
authenticated against.

### The rate lock, which is not optional

The x402 price callback runs **twice** per payment: once to build the 402
challenge, once on the retry to check what the client signed. If the rate
moves between them the requirements no longer match, verification fails, and
the client is stuck in a 402 loop it cannot escape. Calling any live rate
source directly from that callback is a guaranteed intermittent bug.

So `lockRate()` hashes the request body, reads the rate once, and persists it
in `rate_locks` for 15 minutes. Every later evaluation of the same body reuses
it. Live rate, deterministic pricing. This is why the lock survived swapping
the provider, and why it has to survive the next swap too. The rate that
priced each quote is stored on the quote row (`kes_per_usdc`,
`rate_publish_time`, `rate_source`), so any charge can be explained later.

### Guards on every reading

- **Orientation.** `from=USDC&to=KES` should give ~130 and the reverse ~0.0077.
  Rather than trust the direction, the sanity band decides: a value inside
  60-400 is used as-is, a value whose reciprocal is inside it was inverted,
  anything else is rejected. This is what stops a silent orientation flip from
  charging fees 16,000x off.
- **Response shape.** The FX Hub reference page is behind a login, so the exact
  field name is unverified. `extractRate()` in `honeycoin.ts` walks the likely
  candidates (`rate`, `exchangeRate`, `conversionRate`, `value`, `price`,
  `amount`) at both the top level and under `data`, and throws loudly with the
  full body if none hold a usable number. **Confirm the real shape against a
  sandbox call and replace that function with a direct field read** — it is a
  deliberate stopgap, not a design.
- **Fail closed.** If FX Hub is unreachable the quote endpoint returns 503.
  `FALLBACK_KES_PER_USDC` is unset by default; if you set it, every use is
  logged as an error, because a stale constant quietly standing in for a live
  rate is how fee drift goes unnoticed for months.

### What the rate is *not* used for

The payout amount stays USDC on the wire. Honeycoin converts at its own rate
when it detects the deposit, which may not be the rate the FX Hub quoted you
minutes earlier. Converting a KES-denominated payout through this endpoint
would look exact and would not be. The rate only decides which fee band an
amount falls into and what that band's KES fee is in USDC — where being off by
a few percent costs a few percent of ~1%.

Sample at 129.38 KES/USDC:

```
    500 KES =    3.864706 USDC -> fee 0.054106 USDC   1.400%
   5000 KES =   38.647061 USDC -> fee 0.440577 USDC   1.140%
  20001 KES =  154.595975 USDC -> fee 0.834777 USDC   0.540%
 250000 KES = 1932.353064 USDC -> fee 0.834777 USDC   0.043%
 250001 KES = 1932.360794 USDC -> fee 1.545883 USDC   0.080%
```

Two things that table shows which no rate source can fix, because they are in
the schedule itself:

1. The 20,001-250,000 band is 12x wider than everything before it at a flat 108
   KES, so the effective rate collapses from 0.54% to 0.043% inside one band.
2. The fee *rises* at 250,001 (108 to 200 KES) after falling for ten bands.
   Fine as a decision, odd as an accident.

## Running a demo without a Honeycoin account

Honeycoin onboarding needs an incorporated business. `OFFRAMP_PROVIDER=mock`
runs the identical flow with a simulated fiat leg, so the parts you are
actually building stay real:

```
cp .env.demo .env
bun install
bun run dev
```

What is genuinely real in a mock run:

- Both x402 payments settle actual testnet USDC on Base Sepolia. The fee
  payment, the deposit payment, verification, settlement, the `onAfterSettle`
  hook, all of it.
- Deposit addresses are real, unique per quote, and HD-derived from a mnemonic
  (index 1 upward). Nothing is shared or reused, so the `deposit_address`
  correlation in the settlement hook is exercised exactly as in production.
- The webhook is signed with the configured secret and posted over HTTP to
  your own `/api/webhooks/honeycoin`. The real handler runs, signature check
  included.
- `MOCK_OUTCOME=fail` produces a failed payout, then a refund hash a few
  seconds later, so the reconciliation sweep has to notice that a `failed`
  webhook is not refund confirmation. That is the subtlest part of the design
  and the mock makes it demonstrable.

What is fake: nobody receives M-Pesa, and the hashes the mock invents for the
fiat leg are synthetic.

The fee wallet defaults to index 0 of the demo mnemonic
(`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`), so a demo needs no wallet
setup. The mnemonic is Anvil's public test one, which is the point: everyone
can derive those keys, so nobody mistakes a demo deposit for custody. Set
`MOCK_MNEMONIC` to your own if you want to sweep the testnet USDC back out.

Mock mode refuses to start on Base mainnet. On mainnet it would mean real USDC
sent to a well-known key in exchange for a payout that never happens.

### FX without an account

`FX_PROVIDER=open-er-api` is the demo default: free, keyless, has KES. It
treats USDC as USD, which is wrong by whatever the peg is off by and entirely
irrelevant for choosing a fee band. `FX_PROVIDER=static` works with no network
at all. Switch to `honeycoin` alongside `OFFRAMP_PROVIDER=honeycoin` once you
have credentials.

I could not reach open.er-api.com from where I built this, so verify it
returns a KES rate on your first run. If it does not, `static` is one env var
away and the rest of the service does not care.

### The swap itself

`src/offramp.ts` picks the provider; `src/types.ts` holds the contract both
implement. Nothing above that line knows which is running, which is why
swapping Pyth for Honeycoin FX earlier, and Honeycoin for the mock now, both
touched one file each.

## The demo run

```
bun install
bun run demo              # narrated walkthrough, ~10 seconds
bun run demo -- --verbose # same, with the service's own logs interleaved
```

No wallet, no facilitator, no Honeycoin account. It boots the real service in
mock mode, drives it over real HTTP on localhost, and narrates six stages. The
only thing simulated beyond the fiat leg is the x402 settlement itself
(`DEMO_SKIP_PAYMENT`, which refuses to run on mainnet); every other line is the
production path. Each run starts from a fresh database, so it tells the same
story every time.

The two stages worth pausing on when presenting:

- **Stage 4** fires both settlement hooks a second time with the same tx hashes
  and nothing moves. That is the idempotency guarantee, visible rather than
  asserted.
- **Stage 6** is the one that justifies the whole reconciliation layer. The
  payout fails, the webhook says `failed`, and the refund hash is *not there
  yet*. Only after the sweep polls the transaction endpoint does the quote
  reach `refunded`. A webhook can never tell you a refund landed.

To run the real x402 legs instead, drop `DEMO_SKIP_PAYMENT`, point
`FACILITATOR_URL` at a Base Sepolia facilitator, and pay with an x402 client
from a wallet holding testnet USDC. The mock off-ramp still stands in for the
fiat side, so you get genuine on-chain settlement without Honeycoin.

### Captured transcript

```
x402 → M-Pesa off-ramp: end-to-end demo

  network        eip155:84532 (base)
  offramp        mock
  fx             static
  fee wallet     0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

  x402 settlement is simulated in this run; everything else is the real path.
  Run with --verbose to see the service's own logs.

[1/6] Quote a payout
  POST /api/quotes  {"amount":38.65,"destination":"MoMo"}
  201 quote 02ae0575-f29b-4940-a86a-bd8eb5abf2ed
      rate           129.0000 KES/USDC (static:USDC/KES)
      payout         38.65 USDC ≈ 4985.85 KES
      tier fee       0.441861 USDC (57 KES band)
      deposit to     0x70997970C51812dc3A010C7d01b50e0d17dc79C8
      expects        38.65 USDC by 2026-08-29T01:49:34.086Z

      The deposit address is unique to this quote and belongs to the
      off-ramp, not to us. The payout never touches our wallet.

[2/6] Fee settles on-chain (x402 leg 1)
  onAfterSettle fires with tx 0xf256537fd28dc472…
      status → fee_settled
      Only the fee lands in our wallet. This is our entire revenue.

[3/6] Payer funds the deposit (x402 leg 2)
  POST /api/quotes/02ae0575…/pay → 200 settling
  onAfterSettle fires with tx 0x4971fe37207179d0…
      status → funded

[4/6] Replayed settlement is a no-op (idempotency)
  Same hooks fired again. Status is still funded.
      Guarded in the WHERE clause, so a duplicate hook cannot walk a
      funded payout backwards or double-charge a fee.

[5/6] Off-ramp pays out, webhook confirms
  Waiting for the signed webhook to hit /api/webhooks/honeycoin…
      status → funded
      status → payout_success
  ✓ payout_success · honeycoin tx mock_213f6d62847e8be96ae8
  GET /api/quotes/:id → {"status":"payout_success","feeTxHash":"0xf256537fd2…","depositTxHash":"0x4971fe3720…"}

[6/6] Failure path: payout fails, refund must be proven
  New quote 6d6a7d75… for 155.04 USDC (fee 0.837210 USDC)
      status → funded
      status → payout_failed
  The failed webhook says the payout failed. It does NOT say the refund landed.
  Refund hash right now: none
  Reconciliation sweep polls the transaction endpoint…
      status → refunded
  ✓ refund confirmed on-chain 0xcaafd0e94e2b1f26…
      Only refundTransactionHash proves a refund. The sweep is what
      finds it, because the webhook never will.

[—] Fee schedule at this rate
      KES        USDC          fee (USDC)     effective
        500      3.875969      0.054264     1.400%
       5000     38.759690      0.441861     1.140%
      20000    155.038760      0.813954     0.525%
      20001    155.046512      0.837210     0.540%
     250000   1937.984496      0.837210     0.043%
     250001   1937.992248      1.550388     0.080%

      Note the 20,001–250,000 band: one flat 108 KES fee across a range
      12x wider than any other, so the effective rate collapses.

  Done.
```

## Still open

1. **Sandbox hosts.** The defaults are production. Honeycoin has a testing
   section per product; point `HONEYCOIN_AUTH_URL` / `HONEYCOIN_CRYPTO_URL` at
   the sandbox before touching Base mainnet.
3. **`chain` casing.** The guide's example sends `"BASE"`, the API reference
   enum lists `base`. Lowercase is used here. Worth one sandbox call to confirm.
4. **IP allowlisting.** Production payouts can be restricted to your server IPs
   (`IP_NOT_ALLOWED` otherwise). Nothing to build, just configure it.
5. **Webhook signature.** Honeycoin's "signature" is a plain shared secret, not
   an HMAC of the body. That means anyone who ever sees the header can replay
   arbitrary webhooks at you, which is why nothing in this code moves money off
   a webhook — the webhook only updates status, and money movement is confirmed
   against `GET /transactions/{id}`. Keep it that way.

## Running

```
bun install
cp .env.example .env   # fill it in
bun run dev
```
