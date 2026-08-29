import { mnemonicToAccount } from "viem/accounts";
import { createHash } from "node:crypto";
import { env } from "./config";
import {
  insertMockTransaction,
  getMockTransaction,
  nextMockAddressIndex,
  updateMockTransaction,
  type MockTransaction,
} from "./db";
import type {
  OfframpProvider,
  OfframpRequest,
  OfframpResponse,
  OfframpTransaction,
} from "./types";

/**
 * A stand-in for Honeycoin.
 *
 * Honeycoin onboarding needs an incorporated business, which is a hard block
 * on building. This implements the same interface so everything above it —
 * the x402 legs, the settlement hooks, the idempotency guards, the webhook
 * handler, the reconciliation sweep — runs for real. The only simulated part
 * is the fiat leg, which is exactly the part you cannot test without an
 * account anyway.
 *
 * What is genuinely real in a mock run:
 *   - both x402 payments settle actual testnet USDC on Base Sepolia
 *   - deposit addresses are real, unique, and derived from a mnemonic you hold
 *   - the webhook is signed and posted over HTTP to your own endpoint
 *   - failed payouts produce a refund hash the reconciliation sweep must find
 *
 * What is fake: nobody receives M-Pesa, and the on-chain "hashes" the mock
 * invents for the fiat leg are synthetic.
 */

function derivedAddress(index: number): string {
  return mnemonicToAccount(env.mock.mnemonic, { addressIndex: index }).address;
}

/** Synthetic but well-formed, so nothing downstream has to special-case it. */
function fakeHash(seed: string): string {
  return `0x${createHash("sha256").update(seed).digest("hex")}`;
}

function decideOutcome(): "successful" | "failed" {
  // Read live rather than from frozen config, so a demo can flip between the
  // happy and unhappy path in one run.
  switch (process.env.MOCK_OUTCOME ?? env.mock.outcome) {
    case "fail":
      return "failed";
    case "random":
      return Math.random() < 0.5 ? "successful" : "failed";
    default:
      return "successful";
  }
}

function toTransaction(row: MockTransaction): OfframpTransaction {
  return {
    transactionId: row.transaction_id,
    externalReference: row.external_reference,
    type: "offramp",
    status: row.status,
    chargeStatus: row.charge_status,
    senderAmount: Number(row.sender_amount),
    senderCurrency: row.sender_currency,
    chain: row.chain,
    txId: row.tx_id ?? undefined,
    refundTransactionHash: row.refund_tx_hash ?? undefined,
  };
}

async function postWebhook(row: MockTransaction, status: "successful" | "failed") {
  const payload = {
    event: "transaction_updated",
    data: {
      transactionId: row.transaction_id,
      status,
      type: "offramp",
      externalReference: row.external_reference,
      method: "momo",
      depositAddress: row.deposit_address,
      txId: row.tx_id,
    },
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(env.mock.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Honeycoin's signature is the shared secret itself, so the mock
        // sends exactly that and the real handler's check runs unmodified.
        "x-webhook-signature": env.honeycoin.webhookSecret,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("[mock] webhook rejected", res.status, await res.text().catch(() => ""));
    }
  } catch (err) {
    console.error("[mock] webhook delivery failed", err);
  }
}

export const mockOfframpProvider: OfframpProvider = {
  name: "mock",

  async createOfframp(req: OfframpRequest): Promise<OfframpResponse> {
    const index = nextMockAddressIndex();
    const address = derivedAddress(index);
    const transactionId = `mock_${createHash("sha256")
      .update(req.externalReference)
      .digest("hex")
      .slice(0, 20)}`;
    const expiresAt = Date.now() + env.mock.depositWindowMs;

    insertMockTransaction({
      transactionId,
      externalReference: req.externalReference,
      depositAddress: address,
      addressIndex: index,
      senderAmount: String(req.senderAmount),
      senderCurrency: req.senderCurrency,
      receiverCurrency: req.receiverCurrency,
      chain: req.chain,
      refundAddress: req.refundAddress ?? null,
      expiresAt,
    });

    console.info("[mock] off-ramp created", { transactionId, address, index });

    return {
      // A real provider quotes this; the mock echoes the request, which is
      // also what Honeycoin's documented example does.
      expectedAmount: req.senderAmount,
      transactionId,
      addressId: `mock_wallet_${index}`,
      address,
      expiresAt,
    };
  },

  async getTransaction(id: string): Promise<OfframpTransaction> {
    const row = getMockTransaction(id);
    if (!row) throw new Error(`Mock transaction not found: ${id}`);
    return toTransaction(row);
  },

  /**
   * Stands in for Honeycoin's chain watcher. A real provider notices the
   * deposit itself; here the x402 settlement hook tells us, and we run the
   * fiat leg on a timer.
   */
  onDepositSettled(externalReference: string): void {
    const row = getMockTransaction(externalReference);
    if (!row) {
      console.warn("[mock] deposit settled for unknown transaction", externalReference);
      return;
    }
    if (row.status !== "PENDING") return;

    setTimeout(() => {
      void resolvePayout(externalReference);
    }, env.mock.payoutDelayMs);
  },
};

async function resolvePayout(externalReference: string): Promise<void> {
  const row = getMockTransaction(externalReference);
  if (!row || row.status !== "PENDING") return;

  const outcome = decideOutcome();
  const txId = fakeHash(`deposit:${row.transaction_id}`);

  updateMockTransaction(row.transaction_id, {
    status: outcome === "successful" ? "SUCCESSFUL" : "FAILED",
    charge_status: outcome,
    tx_id: txId,
  });

  console.info(`[mock] payout ${outcome}`, { transactionId: row.transaction_id });
  await postWebhook({ ...row, tx_id: txId }, outcome);

  if (outcome === "failed") {
    // A failed webhook is not refund confirmation. The refund lands later and
    // only the transaction endpoint proves it, which is precisely the
    // behaviour the reconciliation sweep exists to handle.
    setTimeout(() => {
      updateMockTransaction(row.transaction_id, {
        refund_tx_hash: fakeHash(`refund:${row.transaction_id}`),
      });
      console.info("[mock] refund settled", { transactionId: row.transaction_id });
    }, env.mock.refundDelayMs);
  }
}
