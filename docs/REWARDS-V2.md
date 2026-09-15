# Conditional Pump.fun rewards V2

This is an implementation candidate, not an activated mainnet service. Production transfers and launches default to disabled. The website keeps its existing layout, logo, wallet connection, charts, and simple entry screen. The previous `contracts/` V1 program and `src/engine.cjs` are historical code; do not deploy or use them for this policy. Use `contracts/v2/` and `server/rewards/`.

## Implemented architecture

One executable Solana program owns separate mint-bound coin treasuries, rounds, positions, awards, and receipt records. A separate System-owned intake PDA receives Pump creator fees. No private key exists for either PDA. The fixed economics are 85% eligible holder reserves and 15% platform operations, applied only to verified collected creator fees. The supplied operations public key is `5toTaaYKbF12cXRf9J5soN41tyhCUmNjfdGYQ8JwUroM`.

The program enforces conservation, mint/round/deployment proof domains, fixed recipients, Merkle-sum budgets, permanent onchain exit records, short-lived verifier signatures, position nonces, same-coin releases, and actual SOL settlement. It has no holder-reserve sweep or arbitrary withdrawal instruction. Rent and delivery transaction costs come from separate fee payers. The intake's setup deposit, donations, and rent refunds are not fee income.

The backend includes PostgreSQL migrations, a finalized block indexer, deterministic execution replay, purchase and price policies, directional funding analysis, immutable manifests, an independent verifier service, durable signed-transaction attempts, a 30-minute scheduler, reconciliation, and a separately available fallback relay. Netlify functions expose public data and wallet-authorized launch/claim actions. Metadata and images use content-addressed Netlify Blobs. Do not delete that store while coins depend on it; export and back it up.

## Pump interfaces and first-trade routing

Primary references were inspected on 2026-09-15: [official Pump documentation](https://github.com/pump-fun/pump-public-docs), [creator-fee sharing](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md), [direct collection](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COLLECT_CREATOR_FEE.md), [PumpSwap](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md), [native holder rewards](https://github.com/pump-fun/pump-public-docs/blob/main/docs/HOLDER_REWARDS_README.md), [fee schedule](https://pump.fun/docs/fees), [Solana PDAs](https://solana.com/docs/core/pda), and [token transfers](https://solana.com/docs/tokens/basics/transfer-tokens). Documentation snapshot: `81091419e4457566469d4e2a27f64ed84d42419c`.

The pinned official packages are `@pump-fun/pump-sdk@2.0.0` and `@pump-fun/pump-swap-sdk@1.20.0`, with lockfile integrity. An unrelated similarly named SDK is not used. Onchain transactions do not require a private Pump website API key. Program IDs and accounts are verified against deployed owners and layouts. The current AMM global account uses `global_config`; the SDK also exports a different `amm_global` address, which must not be substituted blindly.

The launch transaction combines REBOUND coin preparation, Pump mint creation, and a disclosed 0.05 SOL intake setup deposit. The initial Pump creator is already that mint's intake PDA. The browser holds the temporary mint key only in memory and the connected wallet approves transactions. Subsequent resumable steps create the mint-scoped sharing configuration and finalize its sole 100% recipient as that same intake. The program signs those CPIs with its PDA. No shared launcher/creator wallet is used during this interval. A signature and last-valid block height are persisted before broadcast, and uncertain submissions are reconciled before another transaction is offered.

Ordinary creator vaults are creator-scoped; the sharing configuration is mint-scoped. The one-time share update is finalized intentionally. Direct initial-vault collection preserves pre-sharing fees. After graduation, the worker checks for a funded creator WSOL ATA, performs the corresponding AMM sweep/unwrap, and then permissionless native-SOL distribution. Actual traced amounts exclude rent. Pump's protocol buyback portion is already part of the protocol fee; acquisition costs do not add it twice.

Existing-coin enrollment is deliberately not offered by the browser. The program has an independently coauthorized registration path, but an operator must first prove current authority, mutable versus finalized sharing state, original attribution, an activation slot, and unambiguous fee provenance. A finalized incompatible fee split cannot be promised to change. Existing enrollment, and graduation occurring before the sharing steps finish, require additional end-to-end tests before production support is claimed.

## Accounting and conditional payment rules

All monetary amounts use integer lamports and raw token quantities. Price ratios use 18-decimal fixed-point integers. Split carry uses `holders = floor((85 × receipt + prior_carry) / 100)` and `carry = (...) mod 100`; operations receives the remainder of that receipt. After 100 one-lamport receipts, holders have 85 and operations 15. No operations percentage is charged when an award is released and reallocated.

`receipts = unallocated holders + active reserved holders + holder paid + operations payable + operations paid` is checked both by the program and the database. Onchain spendable balance also must cover liabilities. The independent verifier attests actual creator receipts, source signatures, and instruction paths; the program cannot independently interpret historical Pump executions. The receipt ledger limits credits to proved fee accruals in execution order, explicitly traces WSOL-to-SOL conversion, and caps fee-first attribution when donations or foreign-mint fees share a creator vault. A transaction may contain several separately identified events. A caller-supplied receipt name or total account balance is never new revenue.

Only successful, attributable, nonzero-creator-fee buys on the verified curve or canonical PumpSwap pool qualify. Unverified routers and mixed paths are held or excluded until their exact provenance is supported. Side-pool purchases, gifts, incoming transfers, and LP withdrawals create no eligible quantity or cost. Unavoidable protocol/LP/creator fees are included once; rent, tips, and priority fees are excluded. Each buy matures independently after 1,800 seconds. Incoming gifts do not disqualify their recipient. Target-token outflows, including delegated and same-transaction sell/rebuy movements, are inspected in instruction order; same-owner token-account movements preserve history. Unknown token movements hold the affected position rather than assert a sale.

At a complete finalized cutoff, `remaining loss = max(0, matured cost − reference value − prior paid − active reservations)`. The holder round budget is the smaller of available reserve and total current remaining loss. Each award is the floor of budget times individual loss divided by total loss. Leftover lamports stay in that coin's holder reserve. New losses are recomputed each round. The program's position-level paid/active totals conservatively cap later matured purchases too; finer per-lot compensation attribution and correction behavior require additional validation before production activation.

A funded manifest is immutable and conditional. Before funding, the verifier independently reconstructs inputs, the full leaf list, sum, and root. Before every payment, retry, or fallback delivery it checks fresh history, current holdings, current links and price, paid/other-active compensation, and settlement status. The candidate does not subtract itself from its own cap. Pass, reduce, cancel, and hold are distinct outcomes. A reduced settlement atomically pays the authorized amount, releases the remainder, and settles the award once. Price recovery is not a permanent sale flag. Missing data never silently frees a reservation.

Every settlement requires a verifier-signed authorization bound to the program, deployment, native SOL asset, mint, round, index, wallet, committed maximum, payable cap, checked-through/issued/expiry slots, position nonce, funding epoch, and evidence hash. Maximum finalized index lag is 96 slots. Authorizations live at most 20 slots. Slot durations vary; these are not fixed-second guarantees. Known newer confirmed activity holds delivery until indexed. Direct token-account checks catch reduced holdings at execution. A sale between the complete finalized check and execution can still escape offchain detection, particularly with a sell/rebuy; the SBF tests explicitly demonstrate this residual limitation. A late-discovered pre-cutoff event is a data-integrity incident, not ordinary eligibility drift.

## Initial price and wallet-link policy

Reference price is the higher of valid cutoff spot and a complete 30-minute elapsed-time weighted average. Observation gaps may not exceed 60 seconds, the final observation may not be older than 30 seconds, and actual quote liquidity must be at least 5 SOL. Curve virtual reserves and AMM signed virtual quote reserves are treated separately from real reserves. A 3× spot/TWAP discrepancy or entry impact above 25% holds the relevant calculation. Graduation or unmodeled pool configuration changes invalidate continuity until a complete new valid window exists. These thresholds are initial circuit breakers, not a manipulation-proof oracle.

Funding policy uses a 30-day history window, a 24-hour pre-purchase funding window, aggregate funding of at least 0.05 SOL and 50% of purchase cost, less than 50% independent funding, and corroboration of a new dependent wallet (proven first activity within seven days and at most five preceding expenses). Known expenses conservatively consume source funding first. Split transfers are aggregated. Supported directional edges propagate at most three hops. A source's later same-coin sale re-evaluates earlier supported edges. This is evidence of purchase dependence, not proof of human identity.

Verified services and REBOUND treasuries are excluded from customer linking. An unknown counterparty is not silently classified as a private wallet. Material unknown funding holds the affected new purchase. Independent earlier holdings are not contaminated by incoming dust. Reviewers may revoke an inferred link with retained evidence; they may not delete a confirmed sale. SOL is supported; unsupported conversion paths and same-transaction funding provenance can remain held. Exchange withdrawals, independent wallets, private agreements, and unsupported intermediaries remain identity limits.

## Run and verify

Install Node 24, pnpm 11.19, and the exact locked dependencies:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm build
pnpm start
```

`pnpm test` runs policy, PostgreSQL-engine, execution-order, wallet, and existing read-API tests and checks the browser build. Protocol replay tests explicitly skip when the generated real-execution artifact is absent. They are mandatory after protocol execution in `.github/workflows/rewards-v2.yml`. For the full Linux program suite, install the pinned Agave toolchain from that workflow, then:

```sh
cd contracts/v2
cargo +stable test --locked
cargo build-sbf
cd ../..
python -m pip install solders==0.29.0 pytest==8.4.2
python -m pytest contracts/v2/tests/test_svm.py -v
node scripts/rewards/clone-protocol.cjs
python -m pytest contracts/v2/tests/test_pump_lifecycle.py -v
PUMP_EXECUTION_FIXTURE=contracts/v2/artifact/pump-execution.json node tests/rewards/replay.test.cjs
```

The clone script performs read-only mainnet RPC. LiteSVM executes the cloned deployed Pump, PumpSwap, fee, and auxiliary binaries with synthetic local funded wallets. It creates the coin, trades before sharing, finalizes sharing, collects, pays through compiled REBOUND, graduates, trades on PumpSwap, sweeps, and distributes. Source deployment slots/hashes, transaction traces, packet sizes, and the compiled program are saved as build artifacts. Test pricing/eligibility authorizations for that payout are fixtures; that test is not real market-history or production identity validation.

Observed successful protocol run: [34974980300](https://github.com/darklightforce666-cmd/rebound/actions/runs/34974980300). The subsequent backend replay independently matches captured costs and fees, distinguishes rent and protocol-fee carving, and verifies first-vault and AMM-conversion attribution. Check the latest branch workflow for all later changes; an earlier run does not certify newer code. Windows in this workspace blocks native build subprocesses, so SBF and browser bundling run in Linux CI. Local policy and PostgreSQL WASM-engine tests are real executions of those layers.

## Deploy without enabling payments

Use `.env.example`; it contains no secrets. Netlify builds `dist` using `netlify.toml` and serves the two functions. `NODE_VERSION=24`. Keep RPC URLs, database credentials and `REWARDS_INTERNAL_SECRET` in Functions-scoped secrets, never public frontend variables. The site presently using GitHub Pages must move to the verified Netlify project before server routes can work. Domain DNS changes are a separate deployment action; do not point the live domain at an unverified project.

Use managed PostgreSQL with TLS, backups, point-in-time recovery, and separate service credentials. Then:

```sh
node scripts/rewards/manage.cjs migrate
node scripts/rewards/manage.cjs policy
node scripts/rewards/manage.cjs register-deployment
node scripts/rewards/manage.cjs preflight
node scripts/rewards/manage.cjs dry-run MINT_PUBLIC_ADDRESS
```

The dry run reads real inputs and produces an immutable candidate manifest without signing or transferring funds. It reports missing coverage instead of returning fabricated awards. For captured local protocol evidence only, use `dry-run --fixtures` after creating the execution artifact.

`Dockerfile.rewards` and `compose.rewards.yml` provide separate indexer, scheduler, and verifier processes. Mount keys from a secret manager; never put them in a repository, browser bundle, logs, or chat. Docker profiles prevent accidental startup. An indexer can run with transfers disabled. The scheduler and verifier require matching deployed program/roles, approved activation evidence, an enabled database deployment, and the explicit transfer flag. Netlify is for the website/API; do not rely on a browser or a short-lived Netlify request to operate the continuous worker.

Program initialization must be approved by its upgrade authority. Use an independently reviewed multisig (for example Squads) with a timelock for retained upgrade/configuration powers. The initialize instruction requires the actual upgradeable-loader authority, not a convenience server key. `wire.initialize()` builds the public instruction. Deployment and governance transactions are not auto-signed by this repository. The guardian can pause immediately; resuming requires the configured administrator and a one-day program delay. Do not remove upgrade authority before testing and review.

## Exact production inputs still required

The operations public key above is supplied. Still required: deployed V2 program public key; publisher, independent verifier, guardian, and governed upgrade/admin public keys; funded delivery and fallback fee-payer signer files on secure hosts; the governed program initialization; production mainnet RPC and complete archive history access; PostgreSQL URL and separate roles; Netlify project/site access and persistent Blobs configuration; private verifier HTTPS endpoint/service secret; worker hosts; and an activation evidence file matching deployed bytes, network, policy hash, and governance.

Activation evidence must include independently reviewable passing evidence for curve and graduated lifecycle, receipt attribution, full historical replay, adversarial program tests, independent security review, funding-policy calibration, and governance/timelock configuration. A file claiming these passed is operator attestation; it does not replace the underlying work. Preflight rejects absent or mismatched fields. It checks the hash of deployed ProgramData bytes including padding, which must be recorded after deployment and compared with the reviewed build.

Production remains blocked pending those inputs and review. Additional material validation remains: real complete launch-to-current history at production throughput; worker/verifier latency within the slot limits; full worker/API/browser end-to-end execution against deployed services; governance operation; existing-coin enrollment and pre-sharing graduation; supported router/intermediary conversion coverage; per-lot correction accounting; and broad economic manipulation/funding calibration. The initial full-block replay approach is deliberately conservative and has not been demonstrated to scale to a busy production launchpad. Do not relax completeness or freshness limits to make a slow worker appear ready.

See [operations and recovery](REWARDS-OPERATIONS.md) and [trust boundaries](REWARDS-THREAT-MODEL.md).
