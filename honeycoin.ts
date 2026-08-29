import { env } from "./config";
import type {
  FxProvider,
  FxRateResult,
  OfframpProvider,
  OfframpRequest,
  OfframpResponse,
  OfframpTransaction,
} from "./types";

/**
 * Honeycoin auth is two steps: POST the public key with the api-key header to
 * get a bearer token, then use that token until its expiresAt (unix seconds).
 * The docs are explicit that the lifetime is not fixed, so we refresh off the
 * returned timestamp rather than assuming an hour.
 */
let token: { value: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  const res = await fetch(`${env.honeycoin.authBase}/auth/generate-bearer-token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": env.honeycoin.apiKey,
    },
    body: JSON.stringify({ publicKey: env.honeycoin.publicKey }),
  });

  if (!res.ok) {
    throw new Error(`Honeycoin auth failed: ${res.status} ${await res.text().catch(() => "")}`);
  }

  const data = (await res.json()) as { success: boolean; token: string; expiresAt: number };
  if (!data?.token) throw new Error("Honeycoin auth returned no token");

  token = { value: data.token, expiresAt: data.expiresAt };
  return data.token;
}

async function bearerToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // 60s of slack so a token never expires mid-flight.
  if (token && token.expiresAt - 60 > now) return token.value;
  if (inflight) return inflight;

  inflight = fetchToken().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function call<T>(url: string, init: RequestInit, retryOn401 = true): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${await bearerToken()}`,
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(env.honeycoin.timeoutMs),
  });

  if (res.status === 401 && retryOn401) {
    token = null;
    return call<T>(url, init, false);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Honeycoin ${init.method ?? "GET"} ${url} failed: ${res.status} ${text}`);
  }

  return JSON.parse(text) as T;
}



/**
 * Creates the off-ramp and returns the one-time deposit address. Nothing is
 * reserved or charged by this call; it just opens a window for a deposit.
 */
async function createOfframp(req: OfframpRequest): Promise<OfframpResponse> {
  const body = await call<{ success: boolean; data: OfframpResponse }>(
    `${env.honeycoin.cryptoBase}/minting/offramp`,
    { method: "POST", body: JSON.stringify(req) },
  );

  if (!body?.success || !body.data?.address) {
    throw new Error(`Honeycoin off-ramp returned no deposit address: ${JSON.stringify(body)}`);
  }
  return body.data;
}


/**
 * Source of truth for a transaction. A failed webhook tells you the payout
 * failed, not that the refund completed, so anything that matters gets
 * confirmed here.
 */
async function getTransaction(id: string): Promise<OfframpTransaction> {
  const body = await call<{ success: boolean; data: OfframpTransaction }>(
    `${env.honeycoin.authBase}/transactions/${encodeURIComponent(id)}`,
    { method: "GET" },
  );
  return body.data;
}

// ---------------------------------------------------------------------------
// FX Hub
// ---------------------------------------------------------------------------


/**
 * Pulls a numeric rate out of the response without assuming a field name.
 *
 * The FX Hub reference page is behind a login, so the exact key is unverified.
 * Rather than guess one and fail silently on a rename, this walks the likely
 * candidates and gives up loudly if none of them hold a usable number. If you
 * confirm the real shape, replace this with a direct read.
 */
function extractRate(body: unknown): number | null {
  const candidateKeys = ["rate", "exchangeRate", "conversionRate", "value", "price", "amount"];
  const scopes: unknown[] = [
    (body as { data?: unknown })?.data,
    body,
    (body as { data?: { rate?: unknown } })?.data,
  ];

  for (const scope of scopes) {
    if (!scope || typeof scope !== "object") continue;
    for (const key of candidateKeys) {
      const raw = (scope as Record<string, unknown>)[key];
      const value = typeof raw === "string" ? Number(raw) : raw;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

/**
 * Honeycoin's own indicative rate. Better than a market oracle for this job:
 * it is the desk that will actually convert the deposit, so it already carries
 * their spread rather than a mid-market price that does not.
 */
async function getFxRate(from: string, to: string): Promise<FxRateResult> {
  const url = `${env.honeycoin.authBase}/fx/rate?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const body = await call<unknown>(url, { method: "GET" });

  const value = extractRate(body);
  if (value === null) {
    throw new Error(`Could not read a rate from FX Hub response: ${JSON.stringify(body)}`);
  }
  return { value, from, to, raw: body };
}

export const honeycoinOfframpProvider: OfframpProvider = {
  name: "honeycoin",
  createOfframp,
  getTransaction,
  // No onDepositSettled: Honeycoin watches the deposit address itself.
};

export const honeycoinFxProvider: FxProvider = {
  name: "honeycoin-fx",
  getFxRate,
};
