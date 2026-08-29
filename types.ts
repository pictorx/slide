/**
 * The contract every off-ramp provider implements. Modelled on Honeycoin's
 * shape because that is the real target; the mock conforms to it so that
 * nothing above this line knows which one is running.
 */

export interface OfframpRequest {
  senderAmount: number;
  senderCurrency: "USDC" | "USDT";
  receiverCurrency: string;
  country: string;
  chain: string;
  destination: "MoMo" | "Bank Account" | "Paybill" | "Till";
  payoutMethod: Record<string, string>;
  /** Our quote id. Required, and the reconciliation key on both sides. */
  externalReference: string;
  /** Same-chain address for an automatic refund if the payout fails. */
  refundAddress?: string;
}

export interface OfframpResponse {
  expectedAmount: number;
  transactionId: string;
  addressId: string;
  address: string;
  /** unix ms */
  expiresAt: number;
}

export interface OfframpTransaction {
  transactionId: string;
  externalReference?: string;
  type?: string;
  status?: string;
  chargeStatus?: string;
  senderAmount?: number;
  senderCurrency?: string;
  chain?: string;
  txId?: string;
  /** Only present once an automatic refund has landed on-chain. */
  refundTransactionHash?: string;
}

export interface FxRateResult {
  /** The numeric rate as returned, before any orientation fix. */
  value: number;
  from: string;
  to: string;
  raw: unknown;
}

export interface OfframpProvider {
  name: string;
  createOfframp(req: OfframpRequest): Promise<OfframpResponse>;
  getTransaction(id: string): Promise<OfframpTransaction>;
  /**
   * Optional. A real provider watches the chain itself; the mock has no
   * watcher, so it needs telling when a deposit settled.
   */
  onDepositSettled?(externalReference: string): void;
}

export interface FxProvider {
  name: string;
  getFxRate(from: string, to: string): Promise<FxRateResult>;
}
