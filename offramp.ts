import { env, FX_PROVIDER, OFFRAMP_PROVIDER } from "./config";
import { honeycoinOfframpProvider, honeycoinFxProvider } from "./honeycoin";
import { mockOfframpProvider } from "./mock-offramp";
import type { FxProvider, OfframpProvider } from "./types";

/**
 * Everything above this file is provider-agnostic. Swapping Honeycoin for the
 * mock changes nothing about the x402 legs, the settlement hooks, the
 * idempotency guards, or the reconciliation sweep.
 */

/**
 * Free, keyless, and USD-based. Treating USDC as USD is wrong by whatever the
 * peg is off by, which is irrelevant for choosing a fee band and would not be
 * acceptable for pricing a payout. It is not used for pricing a payout.
 */
const openErApiFxProvider: FxProvider = {
  name: "open-er-api",
  async getFxRate(from: string, to: string) {
    const res = await fetch(env.fx.openErApiUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(env.fx.timeoutMs),
    });
    if (!res.ok) throw new Error(`open.er-api.com ${res.status}`);

    const body = (await res.json()) as { rates?: Record<string, number> };
    const value = body.rates?.[to.toUpperCase()];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`No ${to} rate in open.er-api.com response`);
    }
    return { value, from, to, raw: body };
  },
};

/** Last resort, and the only option that works with no network at all. */
const staticFxProvider: FxProvider = {
  name: "static",
  async getFxRate(from: string, to: string) {
    return {
      value: env.fx.staticKesPerUsdc,
      from,
      to,
      raw: { note: "static rate from FX_STATIC_KES_PER_USDC" },
    };
  },
};

export const offrampProvider: OfframpProvider =
  OFFRAMP_PROVIDER === "mock" ? mockOfframpProvider : honeycoinOfframpProvider;

export const fxProvider: FxProvider =
  FX_PROVIDER === "honeycoin"
    ? honeycoinFxProvider
    : FX_PROVIDER === "static"
      ? staticFxProvider
      : openErApiFxProvider;

export const createOfframp = offrampProvider.createOfframp.bind(offrampProvider);
export const getTransaction = offrampProvider.getTransaction.bind(offrampProvider);
export const getFxRate = fxProvider.getFxRate.bind(fxProvider);

/** Called by the settlement hook so a provider without a chain watcher works. */
export function notifyDepositSettled(externalReference: string): void {
  offrampProvider.onDepositSettled?.(externalReference);
}
