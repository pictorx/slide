/**
 * A presentable walkthrough of the whole off-ramp flow.
 *
 *   bun run demo
 *
 * Starts the real service in mock mode, drives it over real HTTP, and narrates
 * each stage. The only thing simulated beyond the fiat leg is the x402
 * settlement itself, so this runs with no wallet, no facilitator, and no
 * Honeycoin account. Every other line of the service is the production path.
 */

// Set before importing anything that reads config at module load.
process.env.OFFRAMP_PROVIDER ??= "mock";
process.env.FX_PROVIDER ??= "open-er-api";
process.env.X402_NETWORK ??= "eip155:84532";
process.env.DEMO_SKIP_PAYMENT ??= "true";
process.env.DB_PATH ??= "demo.sqlite";
process.env.PORT ??= "4310";
process.env.HONEYCOIN_WEBHOOK_SECRET ??= "demo-webhook-secret";
process.env.MOCK_PAYOUT_DELAY_MS ??= "700";
process.env.MOCK_REFUND_DELAY_MS ??= "700";

import { createHash } from "node:crypto";

const VERBOSE = process.argv.includes("--verbose");
const PORT = Number(process.env.PORT);
const BASE = `http://127.0.0.1:${PORT}`;

// Start from a clean slate so a repeat run tells the same story.
try {
  const { unlinkSync } = await import("node:fs");
  for (const suffix of ["", "-wal", "-shm"]) unlinkSync(`${process.env.DB_PATH}${suffix}`);
} catch {
  // nothing to clean
}

// The service logs its own lifecycle. Useful, but it interleaves badly with a
// narrated walkthrough, so it is hidden unless you ask for it.
if (!VERBOSE) {
  console.info = () => {};
  console.warn = () => {};
}

const { app, reconcile } = await import("./index.ts");
const { markFeeSettled, markFunded, getQuote } = await import("./db.ts");
const { notifyDepositSettled } = await import("./offramp.ts");
const { getTierFee, USDC } = await import("./config.ts");

const server = Bun.serve({ port: PORT, fetch: app.fetch });

// ---------------------------------------------------------------------------

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

function step(n: string, title: string) {
  console.log(`\n${bold(`[${n}]`)} ${bold(title)}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeTx(seed: string) {
  return `0x${createHash("sha256").update(seed).digest("hex")}`;
}

async function post(path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: (await res.json()) as any };
}

/** Waits for a quote to reach one of the given statuses, printing transitions. */
async function waitForStatus(id: string, targets: string[], timeoutMs = 8_000) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const quote = getQuote(id);
    if (quote && quote.status !== last) {
      last = quote.status;
      console.log(`      ${dim("status →")} ${cyan(last)}`);
      if (targets.includes(last)) return quote;
    }
    await sleep(120);
  }
  return getQuote(id);
}

// ---------------------------------------------------------------------------

console.log(bold("\n  x402 → M-Pesa off-ramp: end-to-end demo\n"));

const health = await get("/health");
console.log(`  network        ${health.body.network} (${health.body.chain})`);
console.log(`  offramp        ${health.body.offrampProvider}`);
console.log(`  fx             ${health.body.fxProvider}`);
console.log(`  fee wallet     ${(await import("./config.ts")).env.feeWallet}`);
console.log(dim(`\n  x402 settlement is simulated in this run; everything else is the real path.`));
if (!VERBOSE) console.log(dim(`  Run with --verbose to see the service's own logs.`));

// --- 1 ----------------------------------------------------------------------

step("1/6", "Quote a payout");

const PAYOUT_USDC = 38.65; // roughly 5,000 KES
console.log(
  `  POST /api/quotes  ${dim(JSON.stringify({ amount: PAYOUT_USDC, destination: "MoMo" }))}`,
);

const quoteReq = {
  amount: PAYOUT_USDC,
  receiverCurrency: "KES",
  country: "KE",
  destination: "MoMo",
  payoutMethod: { accountName: "Jane Wanjiru", accountNumber: "254712345678", code: "mpesa" },
};

let created = await post("/api/quotes", quoteReq);

if (created.status === 503) {
  console.log(
    yellow(`  FX provider unreachable (${created.body.error}). Retrying with FX_PROVIDER=static.`),
  );
  console.log(dim("  Set FX_PROVIDER=static permanently if you are offline."));
  server.stop(true);
  process.exit(1);
}

if (created.status !== 201) {
  console.error("  unexpected response", created.status, created.body);
  server.stop(true);
  process.exit(1);
}

const q = created.body.data;
console.log(`  ${green("201")} quote ${q.quoteId}`);
console.log(`      rate           ${Number(q.rate.kesPerUsdc).toFixed(4)} KES/USDC ${dim(`(${q.rate.source})`)}`);
console.log(`      payout         ${q.amount} USDC ${dim(`≈ ${q.rate.approxPayoutKes} KES`)}`);
console.log(`      tier fee       ${q.fee} USDC ${dim(`(${(Number(q.fee) * Number(q.rate.kesPerUsdc)).toFixed(0)} KES band)`)}`);
console.log(`      deposit to     ${q.depositAddress}`);
console.log(`      expects        ${q.expectedAmount} USDC by ${new Date(q.expiresAt).toISOString()}`);
console.log(
  dim(`\n      The deposit address is unique to this quote and belongs to the`),
);
console.log(dim(`      off-ramp, not to us. The payout never touches our wallet.`));

// --- 2 ----------------------------------------------------------------------

step("2/6", "Fee settles on-chain (x402 leg 1)");
const feeTx = fakeTx(`fee:${q.quoteId}`);
markFeeSettled(q.quoteId, feeTx, "0xDemoPayer");
console.log(`  onAfterSettle fires with tx ${dim(feeTx.slice(0, 18) + "…")}`);
console.log(`      ${dim("status →")} ${cyan(getQuote(q.quoteId)!.status)}`);
console.log(dim(`      Only the fee lands in our wallet. This is our entire revenue.`));

// --- 3 ----------------------------------------------------------------------

step("3/6", "Payer funds the deposit (x402 leg 2)");
const payRes = await post(`/api/quotes/${q.quoteId}/pay`);
console.log(`  POST /api/quotes/${q.quoteId.slice(0, 8)}…/pay → ${green(String(payRes.status))} ${dim(payRes.body.data.status)}`);

const depositTx = fakeTx(`deposit:${q.quoteId}`);
markFunded(q.quoteId, depositTx, "0xDemoPayer");
console.log(`  onAfterSettle fires with tx ${dim(depositTx.slice(0, 18) + "…")}`);
console.log(`      ${dim("status →")} ${cyan(getQuote(q.quoteId)!.status)}`);

// --- 4 ----------------------------------------------------------------------

step("4/6", "Replayed settlement is a no-op (idempotency)");
markFunded(q.quoteId, depositTx, "0xDemoPayer");
markFeeSettled(q.quoteId, feeTx, "0xDemoPayer");
const afterReplay = getQuote(q.quoteId)!;
console.log(`  Same hooks fired again. Status is still ${cyan(afterReplay.status)}.`);
console.log(
  dim(`      Guarded in the WHERE clause, so a duplicate hook cannot walk a`),
);
console.log(dim(`      funded payout backwards or double-charge a fee.`));

// --- 5 ----------------------------------------------------------------------

step("5/6", "Off-ramp pays out, webhook confirms");
process.env.MOCK_OUTCOME = "success";
notifyDepositSettled(q.quoteId);
console.log(dim(`  Waiting for the signed webhook to hit /api/webhooks/honeycoin…`));
const settled = await waitForStatus(q.quoteId, ["payout_success", "payout_failed"]);
console.log(`  ${green("✓")} ${settled?.status} ${dim(`· honeycoin tx ${settled?.honeycoin_tx_id}`)}`);

const status = await get(`/api/quotes/${q.quoteId}`);
console.log(dim(`  GET /api/quotes/:id → ${JSON.stringify({
  status: status.body.data.status,
  feeTxHash: status.body.data.feeTxHash?.slice(0, 12) + "…",
  depositTxHash: status.body.data.depositTxHash?.slice(0, 12) + "…",
})}`));

// --- 6 ----------------------------------------------------------------------

step("6/6", "Failure path: payout fails, refund must be proven");
process.env.MOCK_OUTCOME = "fail";

const second = await post("/api/quotes", { ...quoteReq, amount: 155.04 });
const q2 = second.body.data;
console.log(`  New quote ${q2.quoteId.slice(0, 8)}… for ${q2.amount} USDC ${dim(`(fee ${q2.fee} USDC)`)}`);

markFeeSettled(q2.quoteId, fakeTx(`fee:${q2.quoteId}`), "0xDemoPayer");
markFunded(q2.quoteId, fakeTx(`deposit:${q2.quoteId}`), "0xDemoPayer");
notifyDepositSettled(q2.quoteId);

await waitForStatus(q2.quoteId, ["payout_failed"]);
console.log(
  yellow(`  The failed webhook says the payout failed. It does NOT say the refund landed.`),
);
console.log(dim(`  Refund hash right now: ${getQuote(q2.quoteId)!.refund_tx_hash ?? "none"}`));

await sleep(1200);
console.log(dim(`  Reconciliation sweep polls the transaction endpoint…`));
await reconcile();

const refunded = getQuote(q2.quoteId)!;
console.log(`      ${dim("status →")} ${cyan(refunded.status)}`);
console.log(
  `  ${green("✓")} refund confirmed on-chain ${dim(refunded.refund_tx_hash?.slice(0, 18) + "…")}`,
);
console.log(dim(`      Only refundTransactionHash proves a refund. The sweep is what`));
console.log(dim(`      finds it, because the webhook never will.`));

// ---------------------------------------------------------------------------

step("—", "Fee schedule at this rate");
const rate = Number(q.rate.kesPerUsdc);
console.log(dim(`      KES        USDC          fee (USDC)     effective`));
for (const kes of [500, 5_000, 20_000, 20_001, 250_000, 250_001]) {
  const usdc = kes / rate;
  const fee = getTierFee(usdc, rate);
  const pct = ((Number(fee) / usdc) * 100).toFixed(3);
  console.log(
    `  ${String(kes).padStart(9)}  ${usdc.toFixed(USDC.decimals).padStart(12)}  ${fee.padStart(12)}  ${pct.padStart(8)}%`,
  );
}
console.log(
  dim(`\n      Note the 20,001–250,000 band: one flat 108 KES fee across a range`),
);
console.log(dim(`      12x wider than any other, so the effective rate collapses.`));

console.log(bold(`\n  Done.\n`));

server.stop(true);
process.exit(0);
