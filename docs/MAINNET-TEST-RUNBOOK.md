# Private mainnet test — runbook (V3.1)

A **capped `mainnet_test`** on real mainnet: 2-minute rounds on a token of your choice (it can be someone else's
pump.fun token), paid from a fee wallet with a fixed **budget = a share of its current balance** (default 50 %).
It never enables public production.

Legend: **[owner]** = the owner acts (wallet signature, SOL transfer, secret handling). **[Mac]** = a command on the
owner's Mac, which holds the operator keys and, for this test, also runs the worker. Secrets are files with mode 600;
they are never pasted into chat, committed, or stored readable in Supabase or Netlify. The one exception is the
fee-wallet key, which the dashboard **encrypts in the browser to the worker's own key** (see step 6); the site and
database only ever hold ciphertext they cannot open.

## How a round works

- Losses are measured **in SOL** (policy `rebound-v3.1-test`): remaining loss = SOL paid for the tokens a wallet still
  holds − what those tokens are worth in SOL at the snapshot (higher of spot and a 60 s average) − compensation
  already paid or reserved. Every holder with a recorded purchase is counted; no USD rate is involved.
- Test rounds last **120 s**; the snapshot is taken **30 s** before the end (production: 30 min / 60 s).
- At the snapshot the worker lists every underwater holder and splits what is left of the budget **in proportion
  to each loss**, never more than the loss itself. The fee wallet deposits exactly that amount (automatic once
  its key is imported), the round is funded on chain with the independent verifier's co-signature, and each award
  is paid at the end of the round.
- **Budget:** when you press *Save and launch*, the worker measures the fee wallet's finalized balance once and
  fixes `budget = 50 % × balance`. Every round deposits at most what is left of it, counted from the program's own
  deposit counter, and 0.01 SOL always stays in the wallet. Pressing *Save and launch* again fixes a new budget
  from the balance at that moment.
- Paid awards are one bit in the round account; when every award is paid the round account is closed and its
  rent returns to the fee payer.

## 0. SOL needed

| Item | Wallet | Amount | Returned? |
|---|---|---|---|
| Program deploy (`--max-len 220000`) | admin | **≈1.53** net; **≈3.1 needed during the deploy** (the buffer is refunded right after) | only by closing the program |
| Initialize + coin account rent + fees | admin | ≈0.01 | no |
| Operations: round rent (returned at close), Fund/Pay/Close fees (0.000005 per payout) | fee payer | **0.1** | round rent yes, fees no |
| Publisher | publisher | 0.01 | — |
| Holder payouts | fee wallet | whatever you put in; **at most 50 % of it is paid out** (e.g. 0.2 → ≤ 0.1) | paid to holders |
| **Total to have** | | **≈3.3 SOL + fee wallet**, of which ≈1.65 is spent or locked | |

The fee wallet must be a **different wallet** from the admin wallet (the program refuses admin = fee wallet).
Use a fresh wallet that holds only what you are willing to commit.

## 1. Choose the test token

- Any pump.fun token (bonding curve or migrated to its canonical PumpSwap pool).
- Prefer a **young, small token** (a few thousand transactions): the indexer reads the token's full history to
  know every holder's purchase price, and a huge history takes a long time on a public RPC.
- You can switch the token at any time in the dashboard once no round is in progress; the site, token card and
  chart follow immediately.

## 2. Operator keys [Mac]

```sh
cd ~/Desktop/Projects/Rebound/repo && git pull && pnpm install --frozen-lockfile --ignore-scripts
node scripts/rewards/keygen-v3.cjs --out ./runtime-secrets --roles program,admin,publisher,verifier,guardian,fee_payer
```

This prints public addresses and an env snippet only. `runtime-secrets/` (mode 700) now holds the key files plus
`signer-master.key` and `inbox.jwk` for the worker.

[owner] Send **≈3.2 SOL to `admin`**, **0.1 SOL to `fee_payer`**, **0.01 SOL to `publisher`**.

## 3. Deploy the program [Mac, Solana CLI]

```sh
sha256sum -c contracts/v3/release/SHA256SUMS          # 2298cf58… (SBPF v0, see contracts/v3/release/BUILD.md)
solana -um feature status B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g   # must be inactive (v0 deployable)
solana -u "$SOLANA_RPC_URL" program deploy contracts/v3/release/rebound_rewards_v3.so \
  --program-id runtime-secrets/program.json \
  --upgrade-authority runtime-secrets/admin.json --keypair runtime-secrets/admin.json \
  --max-len 220000 --with-compute-unit-price 50000
solana -u "$SOLANA_RPC_URL" program dump <PROGRAM_ID> /tmp/onchain.so
head -c 210848 /tmp/onchain.so | sha256sum                            # must equal SHA256SUMS
```

If a deploy is interrupted, resume with `--buffer <BUFFER>` or reclaim it with `solana program close <BUFFER>`.

## 4. Initialize in test mode [Mac]

```sh
G="node scripts/rewards/governance-v3.cjs --program <PROGRAM_ID> --admin runtime-secrets/admin.json"
$G initialize --publisher <PUBLISHER> --verifier <VERIFIER> --guardian <GUARDIAN> --test-mode --dry   # simulate
$G initialize --publisher <PUBLISHER> --verifier <VERIFIER> --guardian <GUARDIAN> --test-mode
$G status
```

`--test-mode` binds the deployment to `rebound-v3.1-test` (120 s rounds). Do **not** pause during setup: a
resume has a 24 h on-chain delay.

## 5. Website [owner + Claude]

- Netlify: `REWARDS_PROGRAM_ID=<PROGRAM_ID>` (Claude sets it and redeploys).
- `https://rebound.wtf/#admin` → sign in with the dashboard password.
- **Administrator wallet**: the `admin` address (the program's upgrade authority). To sign on-chain steps from the
  browser, import `runtime-secrets/admin.json` into a wallet app, or run the `$G` commands on the Mac instead.

## 6. Launch [owner, in #admin]

1. **Launch** card:
   - token contract (mint), fee wallet address
   - namespace **Private test**, funding **Budget**, **50 %**
   - tick **Start real payouts now** only when you are ready (step 8)
   - *Save and launch*. This allowlists the mint, lets every holder of it be paid, and sets the spend caps from
     the budget (+10 %, plus a small fee margin).
2. On chain: press **Sign with the admin wallet: register the token on chain**, then **start the rounds**
   (or on the Mac: `$G register-primary --mint <MINT> --funding-wallet <FEE_WALLET>` and `$G start-primary --mint <MINT>`).
   For a new fee wallet on an already registered token the button reads *set this fee wallet on chain*.
3. **Fee wallet key** card: paste the fee wallet's private key (Phantom → Export private key, base58) and press
   *Encrypt and send to the worker*. The browser checks that it belongs to the fee wallet, encrypts it to the
   worker's `inbox.jwk` key and clears the field. The worker imports it within seconds and the Launch checklist
   shows *Fee wallet key on the worker ✓*. Without it, each round waits for a manual signature (Advanced).

## 7. Worker [Mac]

```sh
for r in indexer scheduler verifier; do node scripts/rewards/db-login.cjs --role $r --out ./runtime-secrets; done
#   → Claude applies each printed SQL (SCRAM verifier, not a password) in Supabase
cp .env.worker.example .env.worker     # RPC URL, program id, public addresses; key/URL files from runtime-secrets
caffeinate -i node --env-file=.env.worker server/rewards/worker-v3.cjs      # REWARDS_WORKER_ROLE=all
```

`caffeinate` keeps the Mac awake while the worker runs. `#admin → Status` must show `indexer`, `worker` and
`worker:scheduler` as `ok`; a scheduler `down` with `preflight: …` means the RPC network, keys or policy do not
match the deployment and nothing is signed.

## 8. Dry run, then real payouts

1. With `REWARDS_MAX_EXECUTION_MODE=dry_run` the worker calculates every round (Rounds table, live log) and
   signs nothing. Check the underwater list and amounts.
2. [owner] Ready: set `REWARDS_MAX_EXECUTION_MODE=mainnet_test` in `.env.worker` and restart the worker; tick
   *Start real payouts now* and *Save and launch* again (this also fixes a fresh budget).
3. Each round: `funding_budget_set` (once) → snapshot → `holder_deposit` → `Fund` → `Pay` per holder →
   round closed. Solscan links are in the log; `spent_total_lamports` stays within the caps.
4. Stop: `#admin → Advanced → Pause test namespace` stops all signing at once. The on-chain pause (`$G pause`)
   also blocks `Pay` and takes 24 h to resume, so use it only if the program itself must stop.

## 9. Switching the token (the interface test)

Enter another mint in the Launch card and *Save and launch* (after the current round completes). The site's token
card, copyable address and chart switch immediately through Realtime; register/start the new token on chain with
the button, and the imported fee-wallet key keeps working if the fee wallet is the same.

## 10. Production later

Production uses a separate, non-test deployment (30-minute rounds, 60 s snapshot lead), a Ledger/multisig upgrade
authority, an always-on worker host (≈ $5/month VPS) and `REWARDS_ALLOW_PRODUCTION=true` set deliberately. It is
never enabled as part of this test.

## 11. Cleanup

- Reserved, unpaid awards stay payable; nothing is swept back.
- `solana program close <PROGRAM_ID> --bypass-warning` returns the ≈1.53 SOL programdata rent but retires the
  program id for good. Use it only after every funded round is paid.
