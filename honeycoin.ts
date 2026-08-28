// I don't have Honeycoin's actual API spec (endpoint, auth scheme, request/
// response shape), so this is a stub with the shape your integration needs.
// Fill in the real fetch call once you have their docs/API key — the rest
// of the app only depends on this function's signature.

export interface HoneycoinTransferResult {
  ref: string; // Honeycoin's own transaction/payout reference
  status: string;
}

export async function transferToHoneycoin(params: {
  amount: string; // atomic units settled on-chain, convert to Honeycoin's expected unit
  idempotencyKey: string; // use the on-chain tx hash — prevents double payout on retry
}): Promise<HoneycoinTransferResult> {
  const res = await fetch(`${process.env.HONEYCOIN_API_URL}/transfers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.HONEYCOIN_API_KEY}`,
      // Confirm the actual idempotency header name/mechanism in Honeycoin's
      // docs — this is a common convention, not verified against their API.
      "Idempotency-Key": params.idempotencyKey,
    },
    body: JSON.stringify({
      amount: params.amount,
      reference: params.idempotencyKey,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Honeycoin transfer failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { ref: string; status: string };
  return { ref: data.ref, status: data.status };
}
