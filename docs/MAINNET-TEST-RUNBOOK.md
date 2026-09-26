# Private mainnet test — runbook (V3)

This runbook covers a **capped `mainnet_test`**: real mainnet, allowlisted mints and wallets, hard spending caps
and a separate namespace. It never enables public production. Every command below was rehearsed on
2026-09-26 against a mainnet-equivalent local validator (SIMD-0500 inactive, the same program bytes).

Legend: **[owner]** means the owner acts (wallet signature, SOL transfer, secret handling). **[host]** is a command on
the machine that holds the operator keys: the owner's Mac for governance, the worker host for workers.
Secrets are only ever files with mode 600. They are never pasted into chat, committed, or stored in Supabase or
Netlify (except the Netlify secrets listed in `.env.example`).

## 0. Budget (SOL)

| Item | Who pays | Amount | Returned? |
|---|---|---|---|
| Program deploy (`--max-len 300000`) | admin | **2.09** net, but **~3.6 needed at deploy time** (a ~1.48 buffer is refunded right after) | only by closing the program |
| Initialize + primary coin account rent + fees | admin | ~0.01 | no |
| Operations: cycle job/round rent, paid-receipt rent 0.0018 per recipient, collection cranks, fees | fee payer | 0.2 (budget) | mostly no (rent stays on receipts) |
| Buyback route setup (ATAs, volume accumulators) + swap fees | fee payer / publisher | 0.05 | no |
| Test primary token on pump.fun (create + small initial buy) | dev wallet | ~0.05 | tokens |
| Holder rewards funding (opening credit; 85 % goes to holders) | dev wallet | e.g. **0.2** → 0.17 to holders | paid to test holders |
| 2 test holder wallets: buys to create an underwater position | owner's test wallets | 2 × 0.1 | partly (it's trading) |
| Third-party launch test: launch ~0.011 + activation ~0.0094 + initial buy + trades for creator fees | owner's test wallet | ~0.3 | partly |
| **Total to have available** | | **≈ 4.7 SOL**, about **2.8 SOL** of it spent or locked | |

Spend caps enforce the test ceiling on everything REBOUND's signers move. Suggested caps: per action 0.05 SOL,
per cycle 0.1 SOL, total 0.5 SOL.

## 1. Decisions and inputs (before starting)

- [owner] **Pyth API key** for the worker (`PYTH_API_KEY`).
  - Hermes and Benchmarks have required one since 2026-08-26.
  - Without it, the policy's 30 s SOL/USD freshness is met only part of the time, because the on-chain feed
    updates about every 53 s. Purchases between updates then stay on hold.
- [owner] **Admin wallet(s)**: public addresses that may sign in to `#admin`.
- [owner] **Test primary mint**: a new pump.fun token created from the dev wallet. **Dev wallet** public address.
- [owner] **Worker host**: any always-on Linux machine with Docker (a small VPS is enough). The Mac also works for
  a short test while it stays awake.
- [owner] **Privy App ID** (public), with allowed origins `https://rebound.wtf` and the Netlify preview origin.
  Without it the site falls back to the injected-wallet connector.

## 2. Operator keys [host: owner's Mac]

```sh
cd ~/Desktop/Projects/Rebound/v3          # repository clone on branch rebound-v3-implementation
pnpm install --frozen-lockfile --ignore-scripts
node scripts/rewards/keygen-v3.cjs --out ./runtime-secrets --roles program,admin,publisher,verifier,guardian,fee_payer
```

This prints public addresses and an env snippet only; the key files never leave `runtime-secrets/` (mode 700/600).

- `admin` is the upgrade authority and deployment admin for this private test. For production, move both to a
  Ledger or Squads multisig with `solana program set-upgrade-authority`, plus a governance SetAuthorities while
  paused.
- `publisher`, `verifier` and `fee_payer` go to the worker host (step 6).
- `guardian` can only pause; keep it offline.

[owner] Send **~3.7 SOL to `admin`**, **~0.3 SOL to `fee_payer`** and **~0.05 SOL to `publisher`**.

## 3. Deploy the program [host: Mac with the Agave 4.2.2 CLI]

```sh
sha256sum -c contracts/v3/release/SHA256SUMS         # 3e169837… (SBPF v0, see contracts/v3/release/BUILD.md)
solana -um feature status B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g   # must be inactive (v0 deployable)
solana -u "$SOLANA_RPC_URL" program deploy contracts/v3/release/rebound_rewards_v3.so \
  --program-id runtime-secrets/program.json \
  --upgrade-authority runtime-secrets/admin.json --keypair runtime-secrets/admin.json \
  --max-len 300000 --with-compute-unit-price 50000
solana -u "$SOLANA_RPC_URL" program dump <PROGRAM_ID> /tmp/onchain.so
head -c 212320 /tmp/onchain.so | sha256sum                            # must equal SHA256SUMS
```

If a deploy is interrupted, the CLI prints a buffer address and seed phrase. Resume with `--buffer`, or reclaim
the buffer with `solana program close <BUFFER>`.

## 4. Initialize (test mode) and the primary [host: Mac]

```sh
export SOLANA_RPC_URL=…   # from the local file, never typed into chat
G="node scripts/rewards/governance-v3.cjs --program <PROGRAM_ID> --admin runtime-secrets/admin.json"
$G initialize --publisher <PUBLISHER> --verifier <VERIFIER> --guardian <GUARDIAN> --test-mode --dry   # simulate
$G initialize --publisher <PUBLISHER> --verifier <VERIFIER> --guardian <GUARDIAN> --test-mode
$G set-target --mint <PRIMARY_MINT>                  # third-party buybacks buy and burn this mint
$G status
```

`--test-mode` binds the deployment to policy `rebound-v3.0-test` (120 s cycles, 30 s cutoff lead). The database's
`mainnet_test` namespace uses the same policy.

Do **not** pause during setup: a resume has a 24 h on-chain delay (enforced, rehearsed).

The same actions are available in `#admin → Program (on chain)` for an admin wallet that is the upgrade authority.

## 5. Website and database [owner + Claude]

1. Admin wallets. Supabase SQL editor, or ask Claude to run it through the Supabase connection:
   `INSERT INTO rebound.reward_admin_wallets(wallet,label,added_by) VALUES('<ADMIN_WALLET>','owner','bootstrap');`
2. Netlify environment:
   - `REWARDS_PROGRAM_ID=<PROGRAM_ID>`
   - `PRIVY_APP_ID=<APP_ID>`
   - `REWARDS_MAX_EXECUTION_MODE` stays `dry_run` for now
   - Redeploy.
3. Sign in at `https://rebound.wtf/#admin` with the admin wallet, then also with the **dev wallet**, which proves it
   in the session. Then:
   - **Register primary**: namespace `mainnet_test`, mint, dev wallet (manual funding).
   - **Test configuration**:
     - allowlist the primary mint, the test third-party mint (added later) and the test holder wallets
     - caps 0.05 / 0.1 / 0.5 SOL
     - slippage 100 bps, impact 300 bps
   - **Opening credit**: the part of the dev wallet balance that counts as holder funding, e.g. 0.2 SOL, reserve 0.02.
4. On chain [host: Mac]:
   `$G register-primary --mint <PRIMARY_MINT> --funding-wallet <DEV_WALLET>`, then `$G start-primary --mint <PRIMARY_MINT>`.
   - The scheduler marks the primary `active` only after it reads the finalized coin account and confirms that
     kind, policy hash and dev wallet match the database.
   - A mismatch is logged as `primary_mismatch` and blocks the coin.

## 6. Workers [host: worker host]

```sh
git clone … && cd rebound && git checkout rebound-v3-implementation
mkdir -m 700 runtime-secrets && cp <publisher.json verifier.json fee_payer.json> runtime-secrets/ && chmod 600 runtime-secrets/*
for r in indexer scheduler verifier; do node scripts/rewards/db-login.cjs --role $r --out ./runtime-secrets; done
#   → paste each printed SQL (SCRAM verifier, not a password) into the Supabase SQL editor
cp .env.worker.example .env.worker     # fill in the RPC URL, PYTH_API_KEY, program id and public addresses
docker compose -f compose.rewards.yml --env-file .env.worker up -d --build indexer
docker compose -f compose.rewards.yml --env-file .env.worker --profile settle up -d --build scheduler
```

Check `#admin → Status`:

- `indexer`, `worker` and `worker:scheduler` are `ok`.
- A scheduler `down` with a `preflight: …` reason means the RPC network, program keys or policy don't match; the
  scheduler signs nothing until they do.

## 7. Dry run (no signatures)

The ceiling is still `dry_run`.

1. **Test holders buy.** With the primary token on pump.fun:
   - [owner] wallet A buys ~0.1 SOL of the primary.
   - [owner] wallet B buys ~0.1 SOL, then sells, so the price falls below A's entry and A is underwater.
   - Buy only after the indexer is running and SOL/USD samples appear; earlier purchases need `PYTH_API_KEY` for
     backfill.
2. **Watch `#admin` → Rounds and the live log:**
   - `history_ingested`, then each cycle `snapshotting` → proposal with awards for A (not B).
   - Funding and payout attempts end with `DRY_RUN` (nothing signed).
3. **Check each snapshot:** holdings, remaining loss after previous credits, and the SOL/USD used.

## 8. Capped `mainnet_test`

1. [owner] Confirm the budget. Set `REWARDS_MAX_EXECUTION_MODE=mainnet_test` in `.env.worker` (restart the
   scheduler) **and** in Netlify (redeploy). Then in `#admin`: execution mode `mainnet_test` for namespace `mainnet_test`.
2. Primary cycle:
   - The scheduler records the opening credit (85 % holders, 15 % stays with the dev wallet, split once).
   - At the next cutoff a funding plan appears in `#admin`. [owner] Sign the holder-only deposit with the dev
     wallet; the Merkle-sum round is funded with verifier co-signature.
   - After the due time, `Pay` delivers to A.
   - Evidence: the Solscan links in the logs, `wallet-rewards` for A, and `reward_platform.spent_total_lamports`
     rising within caps.
3. Third-party:
   - [owner] Launch a test token from `#launch` with an allowlisted wallet. That is 1–2 signatures plus
     activation (fee-sharing create + lock).
   - Add its mint to the test allowlist, then trade it a little to generate creator fees.
   - Expected chain: collection crank → verified receipt → `Credit` (85/15 split once) → at the cycle, the
     15 % budget (≥ `REWARDS_MIN_BUYBACK_LAMPORTS`, default 0.005 SOL) **buys the primary on its canonical
     market and burns it** (`burn_checked`, verified by supply delta).
   - Its holders' 85 % goes through the same round mechanics from the per-mint program treasury.
4. Stop: `#admin` → Pause (the database stops all signing immediately). Use the on-chain pause
   (`$G pause`, admin or guardian) only when the program must stop too; resuming takes 24 h.

## 9. Evidence to record (IMPLEMENTATION-STATUS verification log)

- **Program:** id, deploy signature, dumped hash.
- **Governance:** initialize, set-target, register/start-primary signatures.
- **Primary:** opening credit, deposit, Fund, and each Pay signature, with snapshot hash, root and awards.
- **Third party:**
  - launch, activation, collection, receipt, Credit signatures
  - buyback swap and burn signatures, and the supply before/after
- **Totals:** `spent_total_lamports` against the caps; no action above a cap; no payout to a non-allowlisted wallet.

## 10. Rollback and cleanup

- Database pause stops the workers at once; funded rounds can still be paid by anyone (`Pay` is permissionless).
- On-chain pause blocks every value-moving instruction, **including `Pay`**. Funded awards stay reserved in the
  coin account and become payable again after the 24 h resume, so prefer the database pause unless the program
  itself must stop.
- Reserved and unpaid awards stay as liabilities; nothing is swept back.
- `solana program close <PROGRAM_ID> --bypass-warning` returns the 2.09 SOL programdata rent, but permanently
  retires the program id. Use it only after all funded rounds are paid.
