import { Database } from "bun:sqlite";
import { env } from "./config";

/**
 * bun:sqlite is built into Bun, so no native module and no extra process.
 * One writer, low volume, and everything here is a point lookup by an
 * indexed unique column. Move to Postgres when you need more than one
 * instance writing, not before.
 */
export const db = new Database(env.dbPath);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS quotes (
    id                   TEXT PRIMARY KEY,
    status               TEXT NOT NULL,

    amount               TEXT NOT NULL,   -- USDC the payer sends onward to Honeycoin
    fee                  TEXT NOT NULL,   -- USDC we charged for the quote
    receiver_currency    TEXT NOT NULL,
    country              TEXT NOT NULL,
    destination          TEXT NOT NULL,
    payout_method        TEXT NOT NULL,   -- JSON blob, shape depends on destination
    refund_address       TEXT,

    fee_tx_hash          TEXT UNIQUE,
    fee_payer            TEXT,

    honeycoin_tx_id      TEXT UNIQUE,
    deposit_address      TEXT UNIQUE,
    expected_amount      TEXT,
    expires_at           INTEGER,         -- unix ms, from Honeycoin

    deposit_tx_hash      TEXT UNIQUE,
    deposit_payer        TEXT,

    kes_per_usdc         TEXT,             -- rate the fee was priced at
    rate_publish_time    INTEGER,          -- when that rate was read, unix s
    rate_source          TEXT,

    payout_status        TEXT,
    refund_tx_hash       TEXT,
    last_error           TEXT,
    poll_attempts        INTEGER NOT NULL DEFAULT 0,

    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);

  CREATE TABLE IF NOT EXISTS rate_locks (
    key            TEXT PRIMARY KEY,
    kes_per_usdc   TEXT NOT NULL,
    publish_time   INTEGER NOT NULL,
    source         TEXT NOT NULL,
    expires_at     INTEGER NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_rate_locks_expiry ON rate_locks(expires_at);
`);

/**
 * quoted          fee payment verified, off-ramp created, nothing deposited
 * fee_settled     tier fee confirmed on-chain
 * funded          payer's deposit settled to the Honeycoin address
 * payout_success  Honeycoin paid the mobile money account
 * payout_failed   Honeycoin could not pay out
 * refunded        failed payout, refund hash confirmed on-chain
 * expired         deposit window closed with no deposit
 */
export type QuoteStatus =
  | "quoted"
  | "fee_settled"
  | "funded"
  | "payout_success"
  | "payout_failed"
  | "refunded"
  | "expired";

export interface Quote {
  id: string;
  status: QuoteStatus;
  amount: string;
  fee: string;
  receiver_currency: string;
  country: string;
  destination: string;
  payout_method: string;
  refund_address: string | null;
  kes_per_usdc: string | null;
  rate_publish_time: number | null;
  rate_source: string | null;
  fee_tx_hash: string | null;
  fee_payer: string | null;
  honeycoin_tx_id: string | null;
  deposit_address: string | null;
  expected_amount: string | null;
  expires_at: number | null;
  deposit_tx_hash: string | null;
  deposit_payer: string | null;
  payout_status: string | null;
  refund_tx_hash: string | null;
  last_error: string | null;
  poll_attempts: number;
  created_at: string;
  updated_at: string;
}

export function insertQuote(quote: {
  id: string;
  amount: string;
  fee: string;
  receiverCurrency: string;
  country: string;
  destination: string;
  payoutMethod: unknown;
  refundAddress: string | null;
  honeycoinTxId: string;
  depositAddress: string;
  expectedAmount: string;
  expiresAt: number;
  kesPerUsdc: string;
  ratePublishTime: number;
  rateSource: string;
}): Quote {
  db.query(
    `INSERT INTO quotes (
       id, status, amount, fee, receiver_currency, country, destination,
       payout_method, refund_address, honeycoin_tx_id, deposit_address,
       expected_amount, expires_at, kes_per_usdc, rate_publish_time, rate_source
     ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    quote.id,
    quote.amount,
    quote.fee,
    quote.receiverCurrency,
    quote.country,
    quote.destination,
    JSON.stringify(quote.payoutMethod),
    quote.refundAddress,
    quote.honeycoinTxId,
    quote.depositAddress,
    quote.expectedAmount,
    quote.expiresAt,
    quote.kesPerUsdc,
    quote.ratePublishTime,
    quote.rateSource,
  );
  return getQuote(quote.id)!;
}

export function getQuote(id: string): Quote | null {
  return db.query<Quote, [string]>(`SELECT * FROM quotes WHERE id = ?`).get(id) ?? null;
}

export function getQuoteByDepositAddress(address: string): Quote | null {
  return (
    db
      .query<Quote, [string]>(`SELECT * FROM quotes WHERE lower(deposit_address) = lower(?)`)
      .get(address) ?? null
  );
}

export function getQuoteByHoneycoinTxId(txId: string): Quote | null {
  return db.query<Quote, [string]>(`SELECT * FROM quotes WHERE honeycoin_tx_id = ?`).get(txId) ?? null;
}

/**
 * Record the tier fee settlement. The UNIQUE constraint on fee_tx_hash means a
 * hook that fires twice for the same settlement updates the same row instead
 * of creating a second charge record.
 */
export function markFeeSettled(id: string, txHash: string, payer: string | null): void {
  db.query(
    `UPDATE quotes
        SET status = 'fee_settled', fee_tx_hash = ?, fee_payer = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'quoted'`,
  ).run(txHash, payer, id);
}

/**
 * Record the on-chain deposit to Honeycoin's address. Guarded on the current
 * status so a replayed hook cannot walk a completed payout backwards.
 */
export function markFunded(id: string, txHash: string, payer: string | null): void {
  db.query(
    `UPDATE quotes
        SET status = 'funded', deposit_tx_hash = ?, deposit_payer = ?, updated_at = datetime('now')
      WHERE id = ? AND status IN ('quoted', 'fee_settled')`,
  ).run(txHash, payer, id);
}

export function updateQuote(
  id: string,
  fields: Partial<
    Pick<Quote, "status" | "payout_status" | "refund_tx_hash" | "last_error">
  >,
): void {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const setters = entries.map(([k]) => `${k} = ?`).join(", ");
  db.query(`UPDATE quotes SET ${setters}, updated_at = datetime('now') WHERE id = ?`).run(
    ...entries.map(([, v]) => v as string),
    id,
  );
}

export function incrementPollAttempts(id: string): void {
  db.query(
    `UPDATE quotes SET poll_attempts = poll_attempts + 1, updated_at = datetime('now') WHERE id = ?`,
  ).run(id);
}

/**
 * Deposited but no terminal webhook yet, or failed with no confirmed refund.
 * These are what the reconciliation sweep polls Honeycoin about.
 */
export function findUnreconciled(maxAttempts: number, limit = 25): Quote[] {
  return db
    .query<Quote, [number, number]>(
      `SELECT * FROM quotes
        WHERE (status = 'funded' OR (status = 'payout_failed' AND refund_tx_hash IS NULL))
          AND poll_attempts < ?
        ORDER BY updated_at ASC
        LIMIT ?`,
    )
    .all(maxAttempts, limit);
}

/** Quotes whose deposit window closed without a deposit. */
export function expireStaleQuotes(): number {
  const now = Date.now();
  return db
    .query(
      `UPDATE quotes
          SET status = 'expired', updated_at = datetime('now')
        WHERE status IN ('quoted', 'fee_settled') AND expires_at IS NOT NULL AND expires_at < ?`,
    )
    .run(now).changes;
}

// ---------------------------------------------------------------------------
// Rate locks
// ---------------------------------------------------------------------------

export interface RateLock {
  key: string;
  kes_per_usdc: string;
  publish_time: number;
  source: string;
  expires_at: number;
  created_at: string;
}

/** The lock for this request body, if one is still inside its TTL. */
export function getFreshRateLock(key: string, nowMs: number): RateLock | null {
  return (
    db
      .query<RateLock, [string, number]>(
        `SELECT * FROM rate_locks WHERE key = ? AND expires_at > ?`,
      )
      .get(key, nowMs) ?? null
  );
}

/**
 * Store a rate against a request body. Replaces an expired lock for the same
 * key; concurrent inserts for the same key converge on one row, which is what
 * we want since either value would have been acceptable.
 */
export function putRateLock(lock: {
  key: string;
  kesPerUsdc: number;
  publishTime: number;
  source: string;
  expiresAt: number;
}): RateLock {
  db.query(
    `INSERT INTO rate_locks (key, kes_per_usdc, publish_time, source, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       kes_per_usdc = excluded.kes_per_usdc,
       publish_time = excluded.publish_time,
       source       = excluded.source,
       expires_at   = excluded.expires_at`,
  ).run(lock.key, String(lock.kesPerUsdc), lock.publishTime, lock.source, lock.expiresAt);

  return db.query<RateLock, [string]>(`SELECT * FROM rate_locks WHERE key = ?`).get(lock.key)!;
}

export function pruneRateLocks(nowMs: number): number {
  return db.query(`DELETE FROM rate_locks WHERE expires_at < ?`).run(nowMs).changes;
}

// ---------------------------------------------------------------------------
// Mock provider storage (OFFRAMP_PROVIDER=mock only)
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS mock_transactions (
    transaction_id      TEXT PRIMARY KEY,
    external_reference  TEXT NOT NULL UNIQUE,
    deposit_address     TEXT NOT NULL UNIQUE,
    address_index       INTEGER NOT NULL,
    sender_amount       TEXT NOT NULL,
    sender_currency     TEXT NOT NULL,
    receiver_currency   TEXT NOT NULL,
    chain               TEXT NOT NULL,
    refund_address      TEXT,
    status              TEXT NOT NULL DEFAULT 'PENDING',
    charge_status       TEXT NOT NULL DEFAULT 'pending',
    tx_id               TEXT,
    refund_tx_hash      TEXT,
    expires_at          INTEGER NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export interface MockTransaction {
  transaction_id: string;
  external_reference: string;
  deposit_address: string;
  address_index: number;
  sender_amount: string;
  sender_currency: string;
  receiver_currency: string;
  chain: string;
  refund_address: string | null;
  status: string;
  charge_status: string;
  tx_id: string | null;
  refund_tx_hash: string | null;
  expires_at: number;
  created_at: string;
}

/** Persisted, so each demo deposit gets its own derivable, sweepable address. */
export function nextMockAddressIndex(): number {
  const row = db
    .query<{ next: number }, []>(
      `SELECT COALESCE(MAX(address_index), 0) + 1 AS next FROM mock_transactions`,
    )
    .get();
  return row?.next ?? 1;
}

export function insertMockTransaction(tx: {
  transactionId: string;
  externalReference: string;
  depositAddress: string;
  addressIndex: number;
  senderAmount: string;
  senderCurrency: string;
  receiverCurrency: string;
  chain: string;
  refundAddress: string | null;
  expiresAt: number;
}): void {
  db.query(
    `INSERT INTO mock_transactions (
       transaction_id, external_reference, deposit_address, address_index,
       sender_amount, sender_currency, receiver_currency, chain,
       refund_address, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tx.transactionId,
    tx.externalReference,
    tx.depositAddress,
    tx.addressIndex,
    tx.senderAmount,
    tx.senderCurrency,
    tx.receiverCurrency,
    tx.chain,
    tx.refundAddress,
    tx.expiresAt,
  );
}

/** Looks up by either id, matching the real Get Transaction endpoint. */
export function getMockTransaction(idOrReference: string): MockTransaction | null {
  return (
    db
      .query<MockTransaction, [string, string]>(
        `SELECT * FROM mock_transactions
          WHERE transaction_id = ? OR external_reference = ?`,
      )
      .get(idOrReference, idOrReference) ?? null
  );
}

export function updateMockTransaction(
  transactionId: string,
  fields: Partial<Pick<MockTransaction, "status" | "charge_status" | "tx_id" | "refund_tx_hash">>,
): void {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const setters = entries.map(([k]) => `${k} = ?`).join(", ");
  db.query(`UPDATE mock_transactions SET ${setters} WHERE transaction_id = ?`).run(
    ...entries.map(([, v]) => v as string),
    transactionId,
  );
}
