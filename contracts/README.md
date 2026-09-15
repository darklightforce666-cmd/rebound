# REBOUND hourly SOL rewards

Deployment candidate source. No token, wallet, or program address is embedded in the binary. Nothing in this repository deploys or funds mainnet automatically. The website remains a simulation.

## What this program does

- Holds native SOL in a program-owned vault for one token and administrator.
- Splits each deposit: 85% holder funds, 15% immediately paid to the configured operations address. Both portions round down; the remaining lamport stays as dust in the vault.
- Reserves a complete reward round before any transfer can occur.
- Opens rounds on UTC hour boundaries, at least 10 minutes after publication. Only one future round may be pending. For example, publish a verified snapshot at 12:49 UTC for payment at 13:00 UTC. Publishing after 12:50 UTC delays payment until 14:00 UTC.
- Allows any sponsor to pay the transaction and receipt-account costs while SOL goes directly to the proof-bound holder address. Holders do not need to connect a wallet, sign, or manually claim.
- Uses permanent per-round/per-wallet receipts to prevent repeat payments, including after worker restarts or uncertain network responses.
- Allows the guardian to cancel an incorrect round before it opens. Funds return to the available holder balance. Round IDs are never reused.
- Supports pausing new rounds. Already-funded payouts remain available during a pause.
- Delays publisher changes by 24 hours. The administrator, guardian, and operations address are fixed for this vault.

There is no administrator withdrawal, vault close, claim expiry, or arbitrary beneficiary replacement. The program upgrade authority can still replace program code while upgrades remain enabled; the absence of a withdrawal instruction is not a guarantee against a malicious upgrade.

## Which holders receive SOL

The publisher's calculation follows `src/engine.cjs` and `docs/PARITY.md`:

1. Recognized purchases must be at least 15 minutes old at the snapshot.
2. Reference price is the higher of current spot and the complete 15-minute time-weighted average.
3. Remaining loss is recorded cost minus reference token value minus all previously funded awards, floored at zero.
4. Available holder funds are divided in proportion to those losses. Total funding never exceeds available SOL or total uncovered losses.
5. A sale or outgoing transfer permanently ends future rewards for that wallet/token position. Buying again does not restore them. Incoming transfers do not create purchase cost.
6. A snapshot locks a funded award. A later sale, transfer, or price recovery does not erase that award.

The chain cannot reconstruct historical purchases or prices from a Merkle proof. The publisher is trusted to index genuine trades, use complete finalized history, apply the policy, and publish the correct recipients and amounts. The program verifies signatures, timing, funds, proof membership, aggregate commitment, and replay protection. It does not prove the economic loss calculation. A dishonest publisher could assign holder funds incorrectly; an independent guardian and public snapshot evidence are needed before launch.

## Build and test

Use Linux or macOS with the Solana SBF toolchain. The checked-in GitHub workflow installs Agave v4.2.2 from the official release and verifies its SHA-256 checksum. The Python VM tests run the actual compiled SBF binary, including System Program transfers and PDA creation.

```sh
cd contracts
cargo test --locked
cargo build-sbf
python -m pip install -r tests/requirements.txt
python -m pytest tests/test_svm.py -v
node tests/merkle.test.cjs
```

The checked-in lockfile comes from the successful build artifact. Use it for release rebuilds. The artifact contains the binary, lockfile, binary checksum, and commit. Generated deployment keypairs are excluded from artifacts and source exports.

## Fill in addresses later

Copy `deploy/settings.example.json` to an untracked `deploy/settings.json` and supply:

| Field | Purpose |
| --- | --- |
| programId | Public address of the deployment program keypair, generated under your control |
| admin | Wallet that initializes the vault and controls pause/publisher rotation |
| mint | Actual initialized six-decimal token mint after launch |
| publisher | Signing wallet used by the verified snapshot publisher |
| guardian | Wallet able to pause new rounds and cancel incorrect pending rounds |
| operations | Public address receiving the 15% allocation |

The fee creator/deployer and these roles may be different wallets. An ordinary funded wallet is required by the version 1 preparation client for each role. Use a separate low-balance sponsor for automatic payouts: its authority is limited to its own transaction fees and account rent, not the reward vault. Keep all secret keys outside the repository and website. Never paste them into a chat.

```sh
python client/rebound.py deploy/settings.json deploy/prepared.json
```

This writes the derived vault address and an unsigned initialization instruction. Missing addresses produce an error. No RPC call, signing, deployment, or money movement occurs.

Deploy the verified binary to devnet first using Solana CLI and your locally controlled signing device. Confirm the program address, upgrade authority, token mint, roles, rent, and initialization before funding. Mainnet deployment requires a separate explicit action after the devnet exercise and security review. Do not use any generated test keypair as a production key.

## Creator-fee collection

The contract splits SOL actually received, not trade volume or the user's entire wallet balance. A signed `deposit` transfers gross collected creator fees into the vault and pays 15% to operations atomically. A direct SOL transfer can also be accounted for once through `sync`.

Pump collection is a separate integration. Single-recipient coins have distinct bonding-curve and AMM collection instructions; fee-sharing coins use a different distribution flow. Verify the launched token's mode and current official accounts before constructing those instructions. This program does not change the token's creator or its fee-sharing configuration.

Never configure Pump to send an already-split 85% share into this vault and then call `sync`: that would apply the 85/15 split a second time. Send the gross amount intended for REBOUND's split. The contract cannot enforce that a creator forwards every fee earned. A token must launch in a mode that actually provides the creator-fee funding being promised. Network fees and sponsor rent are paid from the sponsor/operations budget separately.

## Hourly publication and automatic payouts

The production indexer and publisher service remain to be connected to the launched mint. They must continuously ingest finalized purchases, sales, transfers, and price history from the supported Pump venues. Preserve transaction IDs, slot evidence, current wallet positions, funded awards, and cancellations. Do not reset prior funded awards between rounds.

At minute 49 of each hour:

1. Reconcile previously published rounds and receipts from finalized on-chain state. Return cancelled awards to the off-chain loss ledger; preserve all other funded awards.
2. Prepare a complete finalized snapshot, fetch current available SOL and next round ID, and fail closed on missing history. The snapshot must still be at most 120 seconds old when published.
3. Run `node client/build-round.cjs verified-snapshot.json round.json`. It computes policy and proofs but does not verify that the supplied history is authentic. Archive the input and round publicly so the guardian can independently verify them.
4. Independently compare loss calculations and the proposed root before signing the `publish` instruction. Use `client/rebound.py`'s `publish` builder. A rejected/stale/paused round must be rebuilt from current state, never force-submitted with edited amounts.

At the next UTC hour boundary, the payout worker sends the funded awards. Run it every minute to pick up retries; the hourly schedule belongs to the program's opening times. This is an application-server scheduler, not a browser timer or a Codex reminder. Use one worker lock per vault to avoid unnecessary duplicate transaction fees. No daemon or scheduler has been enabled by this preparation.

```sh
# Default: verify published rounds and print unsigned payout plans.
python client/hourly_payouts.py deploy/settings.json /srv/rebound/rounds \
  --payer-public-key YOUR_SPONSOR_PUBLIC_ADDRESS

# After setup and review, explicitly enable signing using a local sponsor key file.
python client/hourly_payouts.py deploy/settings.json /srv/rebound/rounds \
  --payer-public-key YOUR_SPONSOR_PUBLIC_ADDRESS \
  --send --keypair-file /secure/rebound-sponsor.json
```

The worker checks the RPC cluster, vault, published root, manifest hash, all proofs, timing, and on-chain receipts. It reports uncertain submissions as pending and rechecks receipts on its next run. Mainnet sending additionally requires `--allow-mainnet`. The RPC URL can be supplied privately through `SOLANA_RPC_URL`. Payouts need available funding, a running worker, and a functioning network; missed transfers remain owed. Tiny awards to empty recipient accounts can fail Solana rent requirements and must stay pending until a reviewed sponsorship/aggregation approach is implemented. No amount is marked paid by the worker alone.

## Instruction and state reference

All integer fields are little-endian. Addresses/hashes are 32 bytes. See `client/rebound.py` for ordered signer/writable account lists. Instructions reject trailing bytes and unexpected account counts.

| Tag | Action | Payload after tag |
| --- | --- | --- |
| 0 | Initialize | publisher, guardian, operations |
| 1 | Deposit | u64 lamports |
| 2 | Sync direct deposits | empty |
| 3 | Publish | u64 round ID, root hash, u64 total, i64 snapshot seconds, manifest hash |
| 4 | Cancel pending round | empty |
| 5 | Pay holder | u64 amount, u8 proof count, repeated (hash, u64 sum) |
| 6 | Pause new rounds | u8 boolean |
| 7 | Propose publisher | next publisher address |
| 8 | Activate publisher after delay | empty |

PDAs: vault `["rebound", admin, mint]`, round `["round", vault, id_u64_le]`, receipt `["claim", round, recipient]`. Canonical bumps are enforced. Vault data is 281 bytes, round data 153 bytes, receipt data 80 bytes. The respective eight-byte discriminators are `RBDCFG01`, `RBDRND01`, and `RBDCLM01`.

Leaves hash `REBOUND:leaf:v1 || program || vault || round_u64_le || recipient || amount_u64_le`. Parent nodes sort children by hash bytes, then sum, and hash `REBOUND:node:v1 || left_hash || left_sum_u64_le || right_hash || right_sum_u64_le`. The root's sum must match the funded round total. Maximum proof length is 16, supporting up to 65,536 awards per round. Carry an unmatched odd node to the next level. Retain all round/proof files for unpaid claims; receipts and rounds are never closed.

## Primary references

- [Solana native Rust programs](https://solana.com/docs/programs/rust)
- [Solana deployment](https://solana.com/docs/programs/deploying)
- [Pump creator-fee collection](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COLLECT_CREATOR_FEE.md)
- [Pump creator-fee sharing](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md)
- [Solders LiteSVM](https://kevinheavey.github.io/solders/tutorials/litesvm.html)
