import { Database } from "bun:sqlite";

// Bun ships bun:sqlite built in — no native module install, no extra
// process to run, and it's more than fast enough for this workload
// (single writer, low request volume). Swap for Postgres later only if
// you outgrow a single instance or need concurrent writers across
// multiple processes.

export const db = new Database(process.env.DB_PATH ?? "forwarding.sqlite");

db.exec(`
  CREATE TABLE IF NOT EXISTS forward_requests (
    id              TEXT PRIMARY KEY,
    tx_hash         TEXT NOT NULL UNIQUE,
    amount          TEXT NOT NULL,
    payer           TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    honeycoin_ref   TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_forward_requests_status
    ON forward_requests(status);
`);

export type ForwardStatus = "pending" | "forwarding" | "completed" | "failed";

export interface ForwardRequest {
  id: string;
  tx_hash: string;
  amount: string;
  payer: string | null;
  status: ForwardStatus;
  honeycoin_ref: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Insert a new forward record for a confirmed settlement. Returns the
 * existing record instead of throwing if this tx_hash was already
 * recorded (e.g. an onAfterSettle hook firing twice) — this is the
 * idempotency guarantee: one settlement, at most one forward attempt
 * chain.
 */
export function createForwardRecord(params: {
  id: string;
  txHash: string;
  amount: string;
  payer?: string;
}): ForwardRequest {
  const existing = db
    .query<ForwardRequest, [string]>(
      `SELECT * FROM forward_requests WHERE tx_hash = ?`,
    )
    .get(params.txHash);
  if (existing) return existing;

  db.query(
    `INSERT INTO forward_requests (id, tx_hash, amount, payer, status)
     VALUES (?, ?, ?, ?, 'pending')`,
  ).run(params.id, params.txHash, params.amount, params.payer ?? null);

  return db
    .query<ForwardRequest, [string]>(
      `SELECT * FROM forward_requests WHERE id = ?`,
    )
    .get(params.id)!;
}

export function updateStatus(
  id: string,
  status: ForwardStatus,
  fields: { honeycoinRef?: string; lastError?: string } = {},
) {
  db.query(
    `UPDATE forward_requests
     SET status = ?, honeycoin_ref = COALESCE(?, honeycoin_ref),
         last_error = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(status, fields.honeycoinRef ?? null, fields.lastError ?? null, id);
}

export function incrementAttempts(id: string) {
  db.query(
    `UPDATE forward_requests SET attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?`,
  ).run(id);
}

/** Records stuck in a non-terminal state, oldest first, for the retry sweep. */
export function findStuck(maxAttempts: number, limit = 20): ForwardRequest[] {
  return db
    .query<ForwardRequest, [number, number]>(
      `SELECT * FROM forward_requests
       WHERE status IN ('pending', 'forwarding', 'failed')
         AND attempts < ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(maxAttempts, limit);
}

export function getByTxHash(txHash: string): ForwardRequest | null {
  return (
    db
      .query<ForwardRequest, [string]>(
        `SELECT * FROM forward_requests WHERE tx_hash = ?`,
      )
      .get(txHash) ?? null
  );
}
