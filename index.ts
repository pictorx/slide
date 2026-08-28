import { Hono, type Context, type Next } from "hono";
import { paymentMiddleware, x402ResourceServer, HonoAdapter } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import z from "zod";
import {
  createForwardRecord,
  updateStatus,
  incrementAttempts,
  findStuck,
  getByTxHash,
} from "./db";
import { transferToHoneycoin } from "./honeycoin";

const testnet = "eip155:43113"; // Avalanche Fuji testnet
const mainnet = "eip155:43114"; // Avalanche C-Chain mainnet

// Fail fast rather than silently accepting payments into nowhere.
const payTo = process.env.PAY_TO_ADDRESS;
if (!payTo) {
  throw new Error("PAY_TO_ADDRESS env var is required");
}

const MAX_FORWARD_ATTEMPTS = 5;

type Variables = {
  validatedData: { amount: number };
};

const app = new Hono<{ Variables: Variables }>();

const facilitatorClient = new HTTPFacilitatorClient({
  url: process.env.FACILITATOR_URL ?? "https://facilitator.payai.network",
});

const resourceServer = new x402ResourceServer(facilitatorClient).register(
  testnet,
  new ExactEvmScheme(),
);
// Register mainnet once you're ready to go live:
// resourceServer.register(mainnet, new ExactEvmScheme());

// ---- Fee schedule -----------------------------------------------------
// Tiered flat fee in USD, banded by requested mpesa payout amount.
// This is the final schedule per your call — not derived from a % anymore.
function getTierFee(amount: number): number {
  if (amount <= 500) return 7;
  if (amount <= 1000) return 13;
  if (amount <= 1500) return 23;
  if (amount <= 2500) return 33;
  if (amount <= 3500) return 53;
  if (amount <= 5000) return 57;
  if (amount <= 7500) return 78;
  if (amount <= 10000) return 90;
  if (amount <= 15000) return 100;
  if (amount <= 20000) return 105;
  if (amount <= 250000) return 108;
  return 200;
}

const requestSchema = z.object({
  amount: z.number().positive().max(250_000).min(100),
});

// ---- Body validation ----------------------------------------------------
// Runs first so we reject malformed requests before ever touching payment
// logic. Hono caches the parsed body internally, so the later re-read
// inside `price` (see below) doesn't re-consume the stream.
const validateBody = async (c: Context<{ Variables: Variables }>, next: Next) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Bad Request: Invalid JSON body" }, 400);
  }

  const result = requestSchema.safeParse(body);
  if (!result.success) {
    return c.json(
      {
        success: false,
        error: "Bad Request: Invalid or missing parameters in body",
        details: result.error.format(),
      },
      400,
    );
  }

  c.set("validatedData", result.data);
  await next();
};

// ---- Payment middleware ---------------------------------------------------
app.post(
  "/api/process",
  validateBody,
  paymentMiddleware(
    {
      "POST /api/process": {
        accepts: {
          scheme: "exact",
          // DynamicPrice callback: receives HTTPRequestContext, can be async.
          // context.adapter is a HonoAdapter at runtime (this app only uses
          // the Hono transport), so the cast to read the body is safe here.
          price: async (context) => {
            const adapter = context.adapter as HonoAdapter;
            const body = (await adapter.getBody()) as { amount?: number } | undefined;
            const parsed = requestSchema.safeParse(body);
            if (!parsed.success) {
              // Should already have been rejected by validateBody, but
              // don't let an unpriceable request fall through to a
              // default price — refuse it outright.
              throw new Error("Unable to determine amount for pricing");
            }
            const amount = parsed.data.amount;
            const fee = getTierFee(amount);
            // Atomic: the full mpesa payout amount plus the tiered fee is
            // charged in a single x402 settlement.
            return `$${(amount + fee).toFixed(2)}`;
          },
          network: testnet,
          payTo,
        },
      },
    },
    resourceServer,
  ),
  async (c) => {
    // IMPORTANT: this handler runs after payment is *verified*, but
    // BEFORE it is settled on-chain — @x402/hono settles using this
    // handler's response, immediately after it returns. Don't trigger
    // the Honeycoin transfer from here; do it in the onAfterSettle hook
    // below, which only fires once settlement is actually confirmed.
    const validated = c.get("validatedData") as { amount: number };
    return c.json({
      success: true,
      status: "processing",
      message: "Payment verified, settling and forwarding for payout",
      amount: validated.amount,
    });
  },
);

// ---- Post-settlement trigger --------------------------------------------
// This is the real "x402 succeeded" signal — fires once, only after the
// facilitator confirms settlement on-chain. Wire the Honeycoin call here,
// not inside the route handler.
resourceServer.onAfterSettle(async (ctx) => {
  const txHash = ctx.result.transaction;
  const amount = ctx.result.amount ?? ctx.requirements.amount;

  const record = createForwardRecord({
    id: crypto.randomUUID(),
    txHash,
    amount,
    payer: ctx.result.payer,
  });

  // createForwardRecord is idempotent on tx_hash, so if onAfterSettle
  // somehow fires twice for the same settlement, this just returns the
  // existing row instead of creating a second forward attempt.
  if (record.status === "pending") {
    await attemptForward(record.id, txHash, amount);
  }
});

resourceServer.onSettleFailure(async (ctx) => {
  // Settlement itself failed on-chain — nothing was forwarded, nothing to
  // reconcile. Log for visibility; no Honeycoin call happens.
  console.error("x402 settlement failed", {
    error: ctx.error.message,
    requirements: ctx.requirements,
  });
});

async function attemptForward(id: string, txHash: string, amount: string) {
  updateStatus(id, "forwarding");
  try {
    const result = await transferToHoneycoin({ amount, idempotencyKey: txHash });
    updateStatus(id, "completed", { honeycoinRef: result.ref });
  } catch (err) {
    incrementAttempts(id);
    updateStatus(id, "failed", {
      lastError: err instanceof Error ? err.message : String(err),
    });
    // Not re-thrown: onAfterSettle must not block the client response on
    // Honeycoin's availability. The retry sweep below picks this back up.
  }
}

// ---- Status check ----------------------------------------------------
// Repurposed from the old (broken, unconditional-success) endpoint: this
// now reports real forwarding status for a given settlement, looked up by
// on-chain tx hash.
app.get("/api/process-payment", (c) => {
  const txHash = c.req.query("tx");
  if (!txHash) {
    return c.json({ success: false, error: "Missing tx query param" }, 400);
  }
  const record = getByTxHash(txHash);
  if (!record) {
    return c.json({ success: false, error: "No settlement found for that tx" }, 404);
  }
  return c.json({ success: true, data: record });
});

// ---- Retry sweep for stuck forwards -------------------------------------
// Covers the one real failure window in the atomic model: on-chain payment
// settled, but the Honeycoin call never completed (crash, timeout, 5xx).
// Honeycoin's own escrow handles refunds once a transfer *reaches* them;
// this sweep exists for the case where it never reached them at all.
setInterval(async () => {
  const stuck = findStuck(MAX_FORWARD_ATTEMPTS);
  for (const record of stuck) {
    await attemptForward(record.id, record.tx_hash, record.amount);
  }
}, 60_000);

export default {
  port: Number(process.env.PORT ?? 4000),
  fetch: app.fetch,
};
