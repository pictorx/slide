/**
 * Finds the Pyth feed ids this service needs, and tells you straight away if
 * USD/KES does not exist on Pyth.
 *
 *   PYTH_API_KEY=... bun run scripts/find-feeds.ts
 *
 * Never copy feed ids out of a doc, a blog post, or an AI answer. A wrong id
 * either 404s or, worse, silently prices your fees off some other asset.
 */
const HERMES = process.env.PYTH_HERMES_URL ?? "https://pyth.dourolabs.app/hermes";
const API_KEY = process.env.PYTH_API_KEY ?? "";

async function search(query: string, assetType: string) {
  const url = new URL(`${HERMES}/v2/price_feeds`);
  url.searchParams.set("query", query);
  url.searchParams.set("asset_type", assetType);

  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    },
  });

  if (!res.ok) {
    throw new Error(`Hermes ${res.status}: ${await res.text().catch(() => "")}`);
  }

  return (await res.json()) as Array<{
    id: string;
    attributes?: Record<string, string>;
  }>;
}

function show(label: string, feeds: Awaited<ReturnType<typeof search>>) {
  console.log(`\n${label}`);
  if (feeds.length === 0) {
    console.log("  (nothing found)");
    return;
  }
  for (const feed of feeds) {
    const symbol = feed.attributes?.symbol ?? feed.attributes?.display_symbol ?? "?";
    console.log(`  ${symbol.padEnd(24)} 0x${feed.id.replace(/^0x/, "")}`);
  }
}

const kes = await search("KES", "fx");
const usdc = await search("USDC", "crypto");

show("FX feeds matching KES  -> PYTH_USD_KES_FEED_ID", kes);
show("Crypto feeds matching USDC -> PYTH_USDC_USD_FEED_ID", usdc);

if (kes.length === 0) {
  console.log(`
No USD/KES feed on Pyth.

Pyth's FX coverage is mostly majors plus a handful of emerging pairs, and KES
may not be among them. Without it there is no way to cross to shillings, since
every other route would still need a KES leg.

Options if that is the case:
  1. Honeycoin's own FX Hub endpoint (GET /fx-rates). It is the rate Honeycoin
     will actually convert at, which is strictly more accurate for this
     purpose than a mid-market oracle price, and you are already
     authenticated against it.
  2. Any FX data provider with KES, wired into readKesPerUsdc() in
     src/rates.ts. Nothing else in the service needs to change; the rate lock
     and all the sanity checks are provider-agnostic.
`);
}

export {};
