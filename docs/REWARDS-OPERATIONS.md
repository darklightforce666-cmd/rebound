# Operations and recovery

Keep production disabled until the validation gates in REWARDS-V2.md are met. This runbook does not authorize deleting a holder reservation or sweeping a treasury.

## Normal cycle

Every 30 minutes the durable scheduler creates a deterministic mint/cycle job. A dedicated PostgreSQL session takes the per-mint advisory lock. It verifies routing, collects initial/shared creator fees, sweeps funded AMM WSOL fees when appropriate, reconciles chain accounting, attributes new receipts exactly once, asks the independent verifier to check a proposed loss-weighted manifest, funds/registers its conditional awards, and relays freshly authorized settlements. Operations payable is released separately even if holder price/eligibility data is unavailable. Delivery batches are currently single-recipient transactions within Solana's 1,232-byte packet limit. Tiny awards remain reserved if delivery is deferred; none are charged a payout fee.

## Observe

Watch the last complete finalized block/checkpoint, head lag, incident field, wallet funding-check time, price-window coverage, worker job attempts/lease age, unfinished round registrations, authorization expiry, signer fee balances, queued receipts, active reservations, unresolved signed attempts, accounting conservation, and onchain spendable backing. Index lag above 96 slots blocks authorization. Alert on missed 30-minute cycle initiation and all data-integrity incidents. `/.netlify/functions/rewards?action=health` is a public status view; the verifier's private `/health` reports service availability. A healthy HTTP process alone is not evidence of a healthy indexer.

## Crash or uncertain broadcast

1. Retain the signed transaction bytes, signature and last-valid block height in `reward_chain_attempts` or the launch attempt.
2. Query signature status with historical search and read the actual mint-bound program account. A submitted or timed-out request is not a payment.
3. A finalized settlement is reconciled using actual paid and released amounts and its transaction evidence. An external relayer can settle too.
4. Only after finalized height exceeds the transaction's validity window, no signature is found, and chain state proves non-settlement may the attempt be expired. Expiring a transaction does not expire a holder reservation.
5. A retry obtains a new eligibility check. Never reuse an old Merkle proof as payment authorization. Never manually zero active liabilities to unblock a job.

Pending launches are resumed from the connected wallet and saved attempt ID. If the browser loses an uncreated ephemeral mint key, start a new attempt after verifying the old mint was never created. Once creation finalized, continuation needs the connected launcher and the public attempt, not a treasury key. Diagnose partial or externally modified accounts before offering another create transaction.

## Sale, improvement, or missing evidence

A confirmed exit is retained permanently by wallet/mint and independently verified before its onchain nonce is advanced. This invalidates previously issued authorizations. Canceling unpaid awards releases only their own coin's holder reserve. Price recovery can reduce/cancel an award but cannot permanently mark a wallet as sold. A hold for indexing, price, RPC or verifier unavailability leaves funds reserved indefinitely. If a previously complete cutoff is found to have missed an earlier event, pause affected authorizations, preserve raw evidence, investigate the provider/parser and replay before resuming.

## Replay and reconciliation

Keep immutable raw blocks and parser/policy versions. Backfill all produced finalized blocks; skipped slots must be proved by the provider's block listing. New parser versions must run in a separate database or schema and compare manifests, purchases, exits, receipts and journal totals with the original before promoting a corrected projection. Never mutate raw evidence or delete confirmed exits. Resetting a cursor in place without an independently complete rebuild is unsafe. Export public audit data with `node scripts/rewards/manage.cjs export-audit MINT output.json` and preserve provider source evidence.

For an inferred wallet-link error, retain the original edge and add a signed/reviewed correction with reason and evidence, setting the edge to revoked. Recompute affected future eligibility. Do not clear confirmed sales. Do not change completed payments or rewrite a historical manifest. Operator remediation of database projections is privileged and must be audited.

## Fees, gifts, and rent

Reconcile native SOL, WSOL token balances, rent and unrelated deposits separately. The intake's 0.05 SOL launch setup funding is not a creator receipt. WSOL accrual is not spendable SOL until a verified unwrap reaches the proper Pump creator vault. Collection triggered by a third party is still indexed. Receipt attribution is bounded by actual mint-specific fee accrual; excess donations and any foreign-mint fees remain non-fee assets without eligibility rights. Do not percentage-split the treasury's total balance. Do not apply operations percentages to returned reservations.

## Security operations

Use separate infrastructure and credentials for publisher, verifier, guardian and delivery payer. API credentials must not possess program signer files. Delivery cannot publish/fund arbitrary roots; the publisher alone cannot pass independent verification. Protect the verifier with a private network, authenticated service requests, TLS outside the private container network, a replay-protected nonce, and per-role database permissions. The example Compose deployment is a development convenience, not proof of independence. Fund gas from operations; alert before depletion. Rotate compromised server keys through reviewed program/governance changes, with workers paused and retained evidence. There is no general admin holder withdrawal path.

Retain PostgreSQL backups, Blobs metadata exports, reviewed binary hashes, deployment receipts, multisig/timelock approvals, immutable manifests and transaction evidence. Test restoration and the double-payment protections before activation.
