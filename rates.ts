import { createHash } from "node:crypto";
import { env } from "./config";
import { getFxRate, fxProvider } from "./offramp";
import { getFreshRateLock, putRateLock, type RateLock } from "./db";

/**
 * KES per 1 USDC, from Honeycoin's FX Hub.
 *
 * Whichever FX provider is configured. Honeycoin's own desk is the best source
 * when you have an account, since it already carries the spread that will
 * actually be applied. Pyth was the first choice and turned out to have no
 * USD/KES feed at all. The demo setup uses a free keyless source instead.
 */
export interface RateReading {
  kesPerUsdc: number;
  /** When we read it, unix seconds. FX Hub returns an indicative spot rate. */
  readAt: number;
  source: string;
}

/**
 * Accepts the rate in either orientation.
 *
 * `from=USDC&to=KES` should give KES per USDC (~130), and the reverse gives
 * USDC per KES (~0.0077). Rather than trust the direction, the sanity band
 * decides: a value inside it is used as-is, its reciprocal being inside it
 * means the response was inverted, and anything else is rejected. This is what
 * stops a silent orientation flip from charging fees 16,000x off.
 */
function orient(value: number): number {
  const { sanityMin, sanityMax } = env.fx;
  if (value >= sanityMin && value <= sanityMax) return value;

  const inverted = 1 / value;
  if (inverted >= sanityMin && inverted <= sanityMax) return inverted;

  throw new Error(
    `Implausible KES/USDC rate: got ${value} (inverse ${inverted}), ` +
      `expected one of them between ${sanityMin} and ${sanityMax}`,
  );
}

export async function readKesPerUsdc(): Promise<RateReading> {
  const quote = await getFxRate(env.fx.from, env.fx.to);
  return {
    kesPerUsdc: orient(quote.value),
    readAt: Math.floor(Date.now() / 1000),
    source: `${fxProvider.name}:${env.fx.from}/${env.fx.to}`,
  };
}

// ---------------------------------------------------------------------------
// Rate locks
// ---------------------------------------------------------------------------

/**
 * Why a lock exists at all.
 *
 * The x402 price callback runs twice for a single payment: once to build the
 * 402 challenge, and again on the retry to check what the client signed. If
 * the rate moves between those two evaluations the requirements no longer
 * match, verification fails, and the client is stuck in a 402 loop it cannot
 * escape. So the callback has to be a pure function of the request.
 *
 * The lock makes it one. The first evaluation reads the rate and persists it
 * under a hash of the request body; every later evaluation of the same body
 * inside the TTL reuses it. Live rate, deterministic pricing. This is why the
 * lock survived swapping the rate provider, and why it has to survive the
 * next one too.
 */
export function rateLockKey(body: unknown): string {
  return createHash("sha256").update(canonicalise(body)).digest("hex").slice(0, 32);
}

/** Stable stringify, so key order in the request body cannot change the hash. */
function canonicalise(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(",")}}`;
}

export class RateUnavailableError extends Error {}

/**
 * The rate this request is priced at. Reuses an existing lock when there is
 * one, otherwise reads FX Hub and stores the result.
 */
export async function lockRate(key: string): Promise<RateLock> {
  const existing = getFreshRateLock(key, Date.now());
  if (existing) return existing;

  let reading: RateReading;
  try {
    reading = await readKesPerUsdc();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Fail closed by default. A fallback is only used if you deliberately set
    // one, and it is logged loudly every time, because a stale constant
    // quietly standing in for a live rate is how fee drift goes unnoticed.
    if (env.fx.fallbackKesPerUsdc) {
      console.error("FX RATE UNAVAILABLE, pricing from fallback rate", {
        fallback: env.fx.fallbackKesPerUsdc,
        error: message,
      });
      reading = {
        kesPerUsdc: env.fx.fallbackKesPerUsdc,
        readAt: Math.floor(Date.now() / 1000),
        source: "fallback",
      };
    } else {
      throw new RateUnavailableError(message);
    }
  }

  return putRateLock({
    key,
    kesPerUsdc: reading.kesPerUsdc,
    publishTime: reading.readAt,
    source: reading.source,
    expiresAt: Date.now() + env.fx.lockTtlMs,
  });
}
