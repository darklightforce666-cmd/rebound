# Trust boundaries and open validation

## Enforced by the Solana program

Treasury isolation by exact mint and deployment; owner/seed/account validation; fixed 85/15 accounting with carried rounding; liability backing; conditional round reserve caps; recipient/amount/mint/round bound Merkle-sum leaves; separate publisher and verifier funding signers; fresh Ed25519 payment authorization; slot bounds; position version and funding epoch; fixed SOL recipients; one atomic paid-plus-released settlement; replay-resistant receipt and allocation PDAs; fixed operations destination; no holder sweep; permanent recorded exits; pause and delayed resume.

## Trusted offchain inputs

The verifier attests purchase provenance, loss prices, maturity, complete history, meaningful funding dependence, and actual source-fee receipt attribution. A compromised verifier can lie about those facts. Funding still needs the publisher too, but this is not a trustless oracle. The upgrade authority can replace the program. Multisig, timelock, separate infrastructure, independent review, immutable evidence and monitoring reduce those powers; a PDA does not remove them.

The indexer and archival RPC must deliver complete finalized history and accurate instruction order. Missing data holds payments, but a dishonest provider claiming completeness can evade ordinary gap checks. Independent source verification and replay are required. A late event before a signed complete cutoff is an incident. The time between finalized verification and execution remains a sell-history race; onchain balances alone cannot detect every sell/rebuy.

Apply the database role script. Publisher-maintained projections and audit caches are not eligibility authorities: funding decisions are reconstructed from archive RPC and receipt allocations from complete immutable indexer evidence. Only the separately governed database owner can correct inferred links or classify services. That owner and the indexer therefore remain trusted infrastructure roles. Runtime preflight rejects broad database write privileges; using one owner login for every service defeats the intended separation.

## Economic and identity threats

Price pumping/dumping, illiquid trades, self-funding, transfers through unlabeled services, independent wallets and colluding people can evade a naive loss system. The implementation uses canonical markets, minimum real liquidity, complete time weighting, entry-impact and price-ratio circuit breakers, directional purchase funding, and conservative holds. These thresholds require calibration and adversarial review. They do not prove common ownership or eliminate manipulation. Public rewards distributions and fee sponsors are not identity links. Incoming gifts do not ban recipients.

## Application threats

Privileged API requests are server-only HMAC-authenticated with expiring nonces. User writes require wallet signatures bound to origin, action, payload and an expiring single-use challenge. Prepared launch messages are matched exactly before broadcast. Metadata accepts bounded PNG/JPEG uploads, uses immutable content hashes and does not fetch arbitrary user URLs. HTML-rendered data is escaped. No treasury or user seed is requested. The legacy password `1111` is a requested presentation screen, not authentication for financial or privileged routes.

## Remaining assurance limits

Passing unit tests, PostgreSQL WASM-engine tests, and locally executing cloned programs is not an audit or production acceptance. Full deployed-service/browser flows, busy-network index throughput, independent identity-data calibration, existing enrollment, router provenance, broader economic attacks, and lot-level correction accounting remain activation gates. Do not enable transfers merely by writing `passed: true` into an evidence file. The production deployment must be reviewed against the code and tests actually shipped.
