import { Hono, type Context, type Next } from "hono";
import { paymentMiddleware, x402ResourceServer, type HonoAdapter } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { HTTPRequestContext, SettleResultContext } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  env,
  NETWORK,
  OFFRAMP_PROVIDER,
  FX_PROVIDER,
  DEMO_SKIP_PAYMENT,
  HONEYCOIN_CHAIN,
  SENDER_CURRENCY,
  getTierFee,
  payoutLimitError,
  usdcPrice,
  ABSOLUTE_MIN_USDC,
  ABSOLUTE_MAX_USDC,
  USDC,
} from "./config";
import { lockRate, rateLockKey, RateUnavailableError } from "./rates";
import {
  expireStaleQuotes,
  findUnreconciled,
  getQuote,
  getQuoteByDepositAddress,
  getQuoteByHoneycoinTxId,
  incrementPollAttempts,
  insertQuote,
  pruneRateLocks,
  markFeeSettled,
  markFunded,
  updateQuote,
  type Quote,
  type RateLock,
} from "./db";
import { createOfframp, getTransaction, notifyDepositSettled } from "./offramp";

const MAX_POLL_ATTEMPTS = 20;
const SWEEP_INTERVAL_MS = 60_000;

type Variables = { quoteInput: QuoteInput; quote: Quote; rate: RateLock };
const app = new Hono<{ Variables: Variables }>();

const facilitator = new HTTPFacilitatorClient({ url: env.facilitatorUrl });
export const resourceServer = new x402ResourceServer(facilitator).register(
  NETWORK,
  new ExactEvmScheme(),
);

/**
 * The x402 gate, or a loud passthrough when DEMO_SKIP_PAYMENT is set. Wrapping
 * it here keeps the route definitions identical either way, so the demo walks
 * the same code path a paying client does apart from the payment itself.
 */
function gate(routes: Parameters<typeof paymentMiddleware>[0]) {
  if (!DEMO_SKIP_PAYMENT) return paymentMiddleware(routes, resourceServer);
  return async (c: Context<{ Variables: Variables }>, next: Next) => {
    console.warn("[demo] x402 gate bypassed for", c.req.path);
    await next();
  };
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

const quoteSchema = z.object({
  // Denominated in USDC, because that is what Honeycoin's off-ramp takes
  // (senderAmount + senderCurrency). Honeycoin converts to KES at its own
  // rate at deposit time; there is no field for "pay out exactly N KES", so
  // the recipient gets whatever this converts to on the day.
  //
  // These bounds are only a sanity filter. The real limits are in KES and are
  // checked against the locked rate in lockRequestRate below, because they
  // cannot be known until a rate exists. Precision is capped at USDC's 6
  // decimals: Honeycoin refunds any deposit that is not exactly
  // expectedAmount, so a value we cannot represent on-chain has to be rejected
  // here rather than silently rounded later.
  amount: z
    .number()
    .min(ABSOLUTE_MIN_USDC)
    .max(ABSOLUTE_MAX_USDC)
    .refine(
      (v) => Number.isInteger(Number((v * 10 ** USDC.decimals).toFixed(0))) &&
        Math.abs(v * 10 ** USDC.decimals - Math.round(v * 10 ** USDC.decimals)) < 1e-6,
      `amount cannot have more than ${USDC.decimals} decimal places`,
    ),
  receiverCurrency: z.string().length(3).default("KES"),
  country: z.string().length(2).default("KE"),
  destination: z.enum(["MoMo", "Bank Account", "Paybill", "Till"]).default("MoMo"),
  payoutMethod: z.record(z.string(), z.string()),
  // Same chain as NETWORK. Optional: Honeycoin falls back to the detected
  // sender, which is the developer's own wallet.
  refundAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "refundAddress must be a 0x EVM address")
    .optional(),
});

type QuoteInput = z.infer<typeof quoteSchema>;

const validateQuoteBody = async (c: Context<{ Variables: Variables }>, next: Next) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const parsed = quoteSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: "Invalid request body", details: z.treeifyError(parsed.error) },
      400,
    );
  }

  c.set("quoteInput", parsed.data);
  await next();
};

/**
 * Reads the FX rate once per request body and pins the result, so the price
 * callback below sees the same rate on the 402 challenge and on the paid
 * retry. Also the first place a rate exists, so the KES payout limits get
 * checked here.
 */
const lockRequestRate = async (c: Context<{ Variables: Variables }>, next: Next) => {
  const input = c.get("quoteInput");

  let rate: RateLock;
  try {
    rate = await lockRate(rateLockKey(input));
  } catch (err) {
    if (err instanceof RateUnavailableError) {
      console.error("rate unavailable, refusing to quote", err.message);
      return c.json(
        { success: false, error: "Exchange rate unavailable, try again shortly" },
        503,
      );
    }
    throw err;
  }

  const limitError = payoutLimitError(input.amount, Number(rate.kes_per_usdc));
  if (limitError) return c.json({ success: false, error: limitError }, 400);

  c.set("rate", rate);
  await next();
};

// ---------------------------------------------------------------------------
// Route 1: buy a quote. The tier fee is the x402 charge; the response is the
// Honeycoin deposit address the payout will be sent to.
// ---------------------------------------------------------------------------

app.post(
  "/api/quotes",
  validateQuoteBody,
  lockRequestRate,
  gate(
    {
      "POST /api/quotes": {
        description: "Create an M-Pesa off-ramp quote",
        accepts: {
          scheme: "exact",
          network: NETWORK,
          payTo: env.feeWallet,
          // The middleware re-runs this on the 402 challenge and again on the
          // paid retry, so it has to be a pure function of the body. The rate
          // lock is what makes that true while still using a live rate:
          // lockRate returns the already-stored rate for this exact body
          // instead of calling FX Hub a second time.
          price: async (context: HTTPRequestContext) => {
            const body = await (context.adapter as HonoAdapter).getBody();
            const parsed = quoteSchema.safeParse(body);
            if (!parsed.success) {
              throw new Error("Cannot price a request that failed validation");
            }
            const rate = await lockRate(rateLockKey(parsed.data));
            return usdcPrice(getTierFee(parsed.data.amount, Number(rate.kes_per_usdc)));
          },
        },
      },
    },
  ),
  async (c) => {
    // Payment is verified here but not yet settled: @x402/hono settles after
    // the handler returns, and cancels settlement if we respond 4xx/5xx. So
    // failing here means the developer is not charged the fee.
    const input = c.get("quoteInput");
    const rate = c.get("rate");
    const kesPerUsdc = Number(rate.kes_per_usdc);
    const id = crypto.randomUUID();

    let offramp;
    try {
      offramp = await createOfframp({
        senderAmount: input.amount,
        senderCurrency: SENDER_CURRENCY as "USDC",
        receiverCurrency: input.receiverCurrency,
        country: input.country,
        chain: HONEYCOIN_CHAIN,
        destination: input.destination,
        payoutMethod: input.payoutMethod,
        externalReference: id,
        refundAddress: input.refundAddress,
      });
    } catch (err) {
      console.error("off-ramp creation failed", { id, err });
      return c.json(
        { success: false, error: "Could not open a payout with Honeycoin. Not charged." },
        502,
      );
    }

    const quote = insertQuote({
      id,
      amount: String(input.amount),
      fee: getTierFee(input.amount, kesPerUsdc),
      receiverCurrency: input.receiverCurrency,
      country: input.country,
      destination: input.destination,
      payoutMethod: input.payoutMethod,
      refundAddress: input.refundAddress ?? null,
      honeycoinTxId: offramp.transactionId,
      depositAddress: offramp.address,
      expectedAmount: String(offramp.expectedAmount),
      expiresAt: offramp.expiresAt,
      kesPerUsdc: rate.kes_per_usdc,
      ratePublishTime: rate.publish_time,
      rateSource: rate.source,
    });

    return c.json(
      {
        success: true,
        data: {
          quoteId: quote.id,
          amount: quote.amount,
          fee: quote.fee,
          expectedAmount: quote.expected_amount,
          depositAddress: quote.deposit_address,
          expiresAt: quote.expires_at,
          network: NETWORK,
          asset: SENDER_CURRENCY,
          rate: {
            kesPerUsdc: quote.kes_per_usdc,
            publishTime: quote.rate_publish_time,
            source: quote.rate_source,
            approxPayoutKes: (Number(quote.amount) * kesPerUsdc).toFixed(2),
          },
          payEndpoint: `/api/quotes/${quote.id}/pay`,
        },
      },
      201,
    );
  },
);

// ---------------------------------------------------------------------------
// Route 2: fund the quote. payTo is the deposit address Honeycoin generated,
// so the payout never touches our wallet.
// ---------------------------------------------------------------------------

/** Pull the quote id out of /api/quotes/<id>/pay for the dynamic callbacks. */
function quoteIdFromPath(path: string): string | null {
  return path.match(/^\/api\/quotes\/([^/]+)\/pay\/?$/)?.[1] ?? null;
}

function payableQuote(path: string): Quote {
  const id = quoteIdFromPath(path);
  const quote = id ? getQuote(id) : null;
  if (!quote?.deposit_address || !quote.expected_amount) {
    throw new Error(`No payable quote for path ${path}`);
  }
  return quote;
}

/**
 * Runs before the payment middleware so a dead quote gets a clean 4xx instead
 * of a thrown 500 from inside the price callback.
 */
const loadQuote = async (c: Context<{ Variables: Variables }>, next: Next) => {
  const quote = getQuote(c.req.param("id") ?? "");
  if (!quote) return c.json({ success: false, error: "Quote not found" }, 404);

  if (quote.status === "expired" || (quote.expires_at && quote.expires_at <= Date.now())) {
    updateQuote(quote.id, { status: "expired" });
    return c.json(
      { success: false, error: "Deposit window closed. Create a new quote." },
      409,
    );
  }

  if (quote.status !== "quoted" && quote.status !== "fee_settled") {
    return c.json(
      { success: false, error: `Quote already funded (status: ${quote.status})` },
      409,
    );
  }

  c.set("quote", quote);
  await next();
};

app.post(
  "/api/quotes/:id/pay",
  loadQuote,
  gate(
    {
      "POST /api/quotes/:id/pay": {
        description: "Fund an M-Pesa off-ramp quote",
        accepts: {
          scheme: "exact",
          network: NETWORK,
          // Both callbacks read the same persisted row, so the challenge and
          // the paid retry always produce identical requirements. Generating a
          // fresh off-ramp here instead would hand the client a different
          // address on the retry and fail verification.
          payTo: (context: HTTPRequestContext) => payableQuote(context.path).deposit_address!,
          // Honeycoin refunds anything that is not exactly expectedAmount, so
          // this is pinned to atomic units rather than a dollar string.
          price: (context: HTTPRequestContext) =>
            usdcPrice(payableQuote(context.path).expected_amount!),
        },
      },
    },
  ),
  (c) => {
    const quote = c.get("quote");
    return c.json({
      success: true,
      data: {
        quoteId: quote.id,
        status: "settling",
        message: "Deposit verified, settling on-chain. Honeycoin pays out once it confirms.",
      },
    });
  },
);

// ---------------------------------------------------------------------------
// Settlement hooks. This is the only place a payment counts as real: the
// handler above runs pre-settlement, so nothing may key off it.
// ---------------------------------------------------------------------------

resourceServer.onAfterSettle(async (ctx: SettleResultContext) => {
  // Multi-settle flows fire this hook per phase. The exact scheme only settles
  // after the handler, but branch anyway so an escrow flow later cannot
  // double-run any of this.
  if (ctx.phase !== "after-handler" || !ctx.result.success) return;

  const txHash = ctx.result.transaction;
  const payer = ctx.result.payer ?? null;
  const path = (ctx.transportContext as { request?: { path?: string } } | undefined)?.request?.path;

  // A settlement to a one-time deposit address can only be a payout deposit,
  // and the address is unique per quote, so it identifies the row on its own.
  const byAddress = getQuoteByDepositAddress(ctx.requirements.payTo);
  if (byAddress) {
    markFunded(byAddress.id, txHash, payer);
    console.info("quote funded", { quoteId: byAddress.id, txHash });
    // Honeycoin watches its own deposit addresses; the mock cannot, so it
    // gets told here. A no-op for the real provider.
    notifyDepositSettled(byAddress.id);
    return;
  }

  if (path === "/api/quotes") {
    // Fee settlement. The response body carries the quote id we just created.
    const body = (ctx.transportContext as { responseBody?: Buffer } | undefined)?.responseBody;
    const quoteId = parseQuoteIdFromResponse(body);
    if (quoteId) {
      markFeeSettled(quoteId, txHash, payer);
      console.info("fee settled", { quoteId, txHash });
    }
    return;
  }

  console.warn("settlement did not match a known quote", { txHash, payTo: ctx.requirements.payTo });
});

function parseQuoteIdFromResponse(body: Buffer | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { data?: { quoteId?: string } };
    return parsed.data?.quoteId ?? null;
  } catch {
    return null;
  }
}

resourceServer.onSettleFailure(async (ctx) => {
  // Nothing moved on-chain. For a fee settlement the quote is orphaned and will
  // expire on its own; for a deposit the client can retry the same quote.
  console.error("x402 settlement failed", {
    payTo: ctx.requirements.payTo,
    amount: ctx.requirements.amount,
    error: ctx.error.message,
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

app.get("/api/quotes/:id", (c) => {
  const quote = getQuote(c.req.param("id") ?? "");
  if (!quote) return c.json({ success: false, error: "Quote not found" }, 404);

  return c.json({
    success: true,
    data: {
      quoteId: quote.id,
      status: quote.status,
      amount: quote.amount,
      fee: quote.fee,
      expectedAmount: quote.expected_amount,
      depositAddress: quote.deposit_address,
      expiresAt: quote.expires_at,
      feeTxHash: quote.fee_tx_hash,
      depositTxHash: quote.deposit_tx_hash,
      honeycoinTransactionId: quote.honeycoin_tx_id,
      kesPerUsdc: quote.kes_per_usdc,
      rateSource: quote.rate_source,
      payoutStatus: quote.payout_status,
      refundTxHash: quote.refund_tx_hash,
      lastError: quote.last_error,
    },
  });
});

// ---------------------------------------------------------------------------
// Honeycoin webhook
// ---------------------------------------------------------------------------

/**
 * Honeycoin does not HMAC the payload; X-Webhook-Signature is the shared secret
 * itself. Compare in constant time, require HTTPS, and never log the header.
 */
function validSignature(header: string | undefined): boolean {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(env.honeycoin.webhookSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.post("/api/webhooks/honeycoin", async (c) => {
  if (!validSignature(c.req.header("x-webhook-signature"))) {
    return c.json({ success: false, error: "Invalid signature" }, 401);
  }

  const payload = (await c.req.json().catch(() => null)) as {
    event?: string;
    data?: { transactionId?: string; externalReference?: string; status?: string; txId?: string };
  } | null;

  const data = payload?.data;
  if (payload?.event !== "transaction_updated" || !data) {
    return c.json({ success: true, ignored: true });
  }

  const quote =
    (data.externalReference ? getQuote(data.externalReference) : null) ??
    (data.transactionId ? getQuoteByHoneycoinTxId(data.transactionId) : null);

  if (!quote) {
    console.warn("webhook for unknown transaction", { transactionId: data.transactionId });
    return c.json({ success: true, ignored: true });
  }

  if (data.status === "successful") {
    updateQuote(quote.id, { status: "payout_success", payout_status: data.status });
  } else if (data.status === "failed") {
    // A failed webhook confirms the payout failed. It says nothing about the
    // refund, which is asynchronous and only proven by refundTransactionHash.
    // The sweep below chases that.
    updateQuote(quote.id, { status: "payout_failed", payout_status: data.status });
  } else {
    updateQuote(quote.id, { payout_status: data.status ?? null });
  }

  return c.json({ success: true });
});

app.get("/health", (c) =>
  c.json({
    ok: true,
    network: NETWORK,
    chain: HONEYCOIN_CHAIN,
    offrampProvider: OFFRAMP_PROVIDER,
    fxProvider: FX_PROVIDER,
  }),
);

// ---------------------------------------------------------------------------
// Reconciliation. Webhooks get lost and processes restart; the transaction
// endpoint is the source of truth for anything that matters.
// ---------------------------------------------------------------------------

export async function reconcile(): Promise<void> {
  for (const quote of findUnreconciled(MAX_POLL_ATTEMPTS)) {
    if (!quote.honeycoin_tx_id) continue;
    incrementPollAttempts(quote.id);

    try {
      const tx = await getTransaction(quote.honeycoin_tx_id);
      const status = (tx.status ?? tx.chargeStatus ?? "").toLowerCase();

      if (tx.refundTransactionHash) {
        updateQuote(quote.id, {
          status: "refunded",
          payout_status: status,
          refund_tx_hash: tx.refundTransactionHash,
        });
      } else if (status === "successful") {
        updateQuote(quote.id, { status: "payout_success", payout_status: status });
      } else if (status === "failed") {
        updateQuote(quote.id, { status: "payout_failed", payout_status: status });
      }
    } catch (err) {
      updateQuote(quote.id, {
        last_error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

setInterval(() => {
  expireStaleQuotes();
  pruneRateLocks(Date.now());
  void reconcile().catch((err) => console.error("reconcile sweep failed", err));
}, SWEEP_INTERVAL_MS);

export { app };
export default { port: env.port, fetch: app.fetch };
