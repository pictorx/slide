import { getDefaultAsset } from "@x402/evm";
import { mnemonicToAccount } from "viem/accounts";
import type { Network } from "@x402/core/types";

/**
 * Chain choice.
 *
 * Avalanche is gone: Honeycoin's off-ramp chain enum is
 * eth | arb | base | matic | bsc | optimism | solana | tron | tempo.
 * Base is the pick, so x402 settles on Base and Honeycoin watches the
 * deposit address on Base. These two must always name the same chain.
 */
export const NETWORK = (process.env.X402_NETWORK ?? "eip155:84532") as Network;

const CHAIN_BY_NETWORK: Record<string, string> = {
  "eip155:8453": "base", // Base mainnet
  "eip155:84532": "base", // Base Sepolia
};

export const HONEYCOIN_CHAIN = CHAIN_BY_NETWORK[NETWORK];
if (!HONEYCOIN_CHAIN) {
  throw new Error(
    `X402_NETWORK ${NETWORK} has no Honeycoin chain mapping. Honeycoin supports ` +
      `eth, arb, base, matic, bsc, optimism, solana, tron, tempo.`,
  );
}

/**
 * The token both legs are denominated in. Honeycoin off-ramps accept only
 * USDC and USDT, and the deposit must be the exact expectedAmount, so we
 * price in atomic units of this asset rather than in "$1.23" strings that
 * get re-parsed and rounded.
 */
const asset = getDefaultAsset(NETWORK, "USDC");
if (!asset) {
  throw new Error(`No default USDC asset registered for ${NETWORK}`);
}

export const USDC = {
  address: asset.asset,
  decimals: asset.decimals,
  // EIP-712 domain fields. The exact scheme requires extra.name/extra.version
  // to be present on the requirements or verification fails.
  eip712: { name: asset.name, version: asset.version },
};

export const SENDER_CURRENCY = "USDC";

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * `honeycoin` is the real thing. `mock` runs the identical flow with a
 * simulated off-ramp so the whole x402 path can be demoed without a Honeycoin
 * account, which requires an incorporated business.
 */
export const OFFRAMP_PROVIDER = (process.env.OFFRAMP_PROVIDER ?? "honeycoin") as
  | "honeycoin"
  | "mock";

export const FX_PROVIDER = (process.env.FX_PROVIDER ??
  (OFFRAMP_PROVIDER === "mock" ? "open-er-api" : "honeycoin")) as
  | "honeycoin"
  | "open-er-api"
  | "static";

// The mock hands out deposit addresses derived from a publicly known test
// mnemonic and pretends payouts happened. On mainnet that would mean real USDC
// sent to a well-known key in exchange for nothing.
if (OFFRAMP_PROVIDER === "mock" && NETWORK === "eip155:8453") {
  throw new Error("OFFRAMP_PROVIDER=mock is refused on Base mainnet. Use a testnet.");
}

/**
 * Demo only. Skips the x402 gate entirely so the flow can be walked through
 * without a funded testnet wallet or a reachable facilitator. Everything else
 * runs unchanged; the demo script simulates the settlement hooks the gate
 * would have fired.
 */
export const DEMO_SKIP_PAYMENT = process.env.DEMO_SKIP_PAYMENT === "true";

if (DEMO_SKIP_PAYMENT && NETWORK === "eip155:8453") {
  throw new Error("DEMO_SKIP_PAYMENT is refused on Base mainnet.");
}

const needsHoneycoin = OFFRAMP_PROVIDER === "honeycoin" || FX_PROVIDER === "honeycoin";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} env var is required`);
  return value;
}

function requiredIf(condition: boolean, name: string): string {
  return condition ? required(name) : (process.env[name] ?? "");
}

/**
 * Anvil's standard test mnemonic. Public, worthless, and the point: demo
 * deposits go to addresses anyone can derive, so nobody mistakes them for
 * custody. Override it if you want to sweep the testnet USDC back out.
 */
const DEMO_MNEMONIC =
  "test test test test test test test test test test test junk";

const mockMnemonic = process.env.MOCK_MNEMONIC ?? DEMO_MNEMONIC;

export const env = {
  port: Number(process.env.PORT ?? 4000),
  dbPath: process.env.DB_PATH ?? "offramp.sqlite",
  facilitatorUrl: process.env.FACILITATOR_URL ?? "https://facilitator.payai.network",
  // Where tier fees are collected. Only fees land here; the payout amount
  // goes straight to the off-ramp, so this wallet never custodies user funds.
  // In mock mode it defaults to index 0 of the demo mnemonic so a demo needs
  // no wallet setup at all.
  feeWallet:
    OFFRAMP_PROVIDER === "mock"
      ? (process.env.FEE_WALLET_ADDRESS ??
        mnemonicToAccount(mockMnemonic, { addressIndex: 0 }).address)
      : required("FEE_WALLET_ADDRESS"),
  honeycoin: {
    authBase: process.env.HONEYCOIN_AUTH_URL ?? "https://api-v2.honeycoin.app/api/b2b",
    cryptoBase: process.env.HONEYCOIN_CRYPTO_URL ?? "https://crypto.honeycoin.app/api",
    apiKey: requiredIf(needsHoneycoin, "HONEYCOIN_API_KEY"),
    publicKey: requiredIf(needsHoneycoin, "HONEYCOIN_PUBLIC_KEY"),
    // The mock signs its own webhooks with this, so it is needed either way.
    // A demo default keeps the flow runnable; production must set it.
    webhookSecret:
      OFFRAMP_PROVIDER === "mock"
        ? (process.env.HONEYCOIN_WEBHOOK_SECRET ?? "demo-webhook-secret")
        : required("HONEYCOIN_WEBHOOK_SECRET"),
    timeoutMs: Number(process.env.HONEYCOIN_TIMEOUT_MS ?? 8_000),
  },
  mock: {
    mnemonic: mockMnemonic,
    /** How long after the deposit settles the simulated payout resolves. */
    payoutDelayMs: Number(process.env.MOCK_PAYOUT_DELAY_MS ?? 4_000),
    /** Extra delay before a failed payout produces a refund hash. */
    refundDelayMs: Number(process.env.MOCK_REFUND_DELAY_MS ?? 4_000),
    /** "success" | "fail" | "random" — drive the unhappy path on demand. */
    outcome: (process.env.MOCK_OUTCOME ?? "success") as "success" | "fail" | "random",
    depositWindowMs: Number(process.env.MOCK_DEPOSIT_WINDOW_MS ?? 60 * 60_000),
    webhookUrl:
      process.env.MOCK_WEBHOOK_URL ??
      `http://127.0.0.1:${Number(process.env.PORT ?? 4000)}/api/webhooks/honeycoin`,
  },
  fx: {
    // Honeycoin's own indicative rate: GET /api/b2b/fx/rate?from=&to=
    from: process.env.FX_FROM ?? "USDC",
    to: process.env.FX_TO ?? "KES",
    // Free, keyless, USD-based. Used when FX_PROVIDER=open-er-api, which
    // treats USDC as USD — fine for choosing a fee band, not for pricing a
    // payout.
    openErApiUrl: process.env.FX_OPEN_ER_API_URL ?? "https://open.er-api.com/v6/latest/USD",
    /** Used only when FX_PROVIDER=static. */
    staticKesPerUsdc: Number(process.env.FX_STATIC_KES_PER_USDC ?? 129),
    // Either orientation is accepted; anything outside this band on both the
    // value and its reciprocal is rejected outright.
    sanityMin: Number(process.env.FX_RATE_SANITY_MIN ?? 60),
    sanityMax: Number(process.env.FX_RATE_SANITY_MAX ?? 400),
    timeoutMs: Number(process.env.FX_TIMEOUT_MS ?? 5_000),
    // How long one request body keeps the rate it was first quoted at. Must
    // comfortably exceed the gap between the 402 challenge and the client's
    // paid retry.
    lockTtlMs: Number(process.env.RATE_LOCK_TTL_MS ?? 15 * 60_000),
    // Optional. Unset means fail closed when the rate source is unreachable.
    fallbackKesPerUsdc: process.env.FALLBACK_KES_PER_USDC
      ? Number(process.env.FALLBACK_KES_PER_USDC)
      : null,
  },
};

// ---------------------------------------------------------------------------
// Fee schedule
// ---------------------------------------------------------------------------

/**
 * Your table, in shillings, unchanged.
 *
 * The schedule stays in KES because that is the currency the business thinks
 * in. Every amount on the wire is USDC, so the band boundaries and the fee are
 * both converted at request time using Honeycoin's own FX rate, locked per
 * request (see rates.ts for why the lock is mandatory, not an optimisation).
 *
 * [inclusive KES ceiling, flat fee in KES]
 */
const FEE_BANDS_KES: ReadonlyArray<readonly [number, number]> = [
  [500, 7],
  [1_000, 13],
  [1_500, 23],
  [2_500, 33],
  [3_500, 53],
  [5_000, 57],
  [7_500, 78],
  [10_000, 90],
  [15_000, 100],
  [20_000, 105],
  [250_000, 108],
];

const TOP_BAND_FEE_KES = 200;

/** Accepted payout range, in KES. Enforced against the locked rate. */
export const MIN_PAYOUT_KES = 100;
export const MAX_PAYOUT_KES = 1_000_000;

/**
 * Loose absolute bounds for the request schema. These only reject nonsense
 * before a rate is available; the real limits are the KES ones above.
 */
export const ABSOLUTE_MIN_USDC = 0.01;
export const ABSOLUTE_MAX_USDC = 100_000;

function ceilTo(value: number, decimals: number): string {
  const factor = 10 ** decimals;
  // Nudge past binary representation error before rounding up, so a fee does
  // not gain an extra atomic unit purely from float noise.
  return (Math.ceil(value * factor - 1e-6) / factor).toFixed(decimals);
}

/**
 * Tier fee for a payout, in USDC, at a given KES/USDC rate.
 *
 * The band is chosen in KES, then the flat KES fee is converted back, always
 * rounding up so the conversion never costs you a fraction of a cent. Returns
 * a decimal string because the caller turns it into exact atomic units and
 * floats have no business near that.
 */
export function getTierFee(amountUsdc: number, kesPerUsdc: number): string {
  const amountKes = amountUsdc * kesPerUsdc;
  const band = FEE_BANDS_KES.find(([ceiling]) => amountKes <= ceiling);
  return ceilTo((band ? band[1] : TOP_BAND_FEE_KES) / kesPerUsdc, USDC.decimals);
}

/** null when the amount is inside the KES limits, otherwise why it is not. */
export function payoutLimitError(amountUsdc: number, kesPerUsdc: number): string | null {
  const amountKes = amountUsdc * kesPerUsdc;
  if (amountKes < MIN_PAYOUT_KES) {
    return `amount is about ${amountKes.toFixed(2)} KES, minimum is ${MIN_PAYOUT_KES} KES`;
  }
  if (amountKes > MAX_PAYOUT_KES) {
    return `amount is about ${amountKes.toFixed(2)} KES, maximum is ${MAX_PAYOUT_KES} KES`;
  }
  return null;
}

/**
 * Decimal string/number to atomic units, without floating point. "50.25" at 6
 * decimals becomes "50250000". Rejects more precision than the token has,
 * because a silently rounded deposit is a deposit Honeycoin will reject and
 * refund.
 */
export function toAtomic(value: string | number, decimals: number): string {
  const raw = typeof value === "number" ? value.toFixed(decimals) : value.trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid decimal amount: ${raw}`);
  }
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Amount ${raw} has more than ${decimals} decimal places`);
  }
  return BigInt(whole + fraction.padEnd(decimals, "0")).toString();
}

/** An x402 price pinned to an exact USDC amount on this network. */
export function usdcPrice(amount: string | number) {
  return {
    asset: USDC.address,
    amount: toAtomic(amount, USDC.decimals),
    extra: USDC.eip712,
  };
}
