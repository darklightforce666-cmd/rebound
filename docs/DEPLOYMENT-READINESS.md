# Deployment readiness — 2026-09-17

This is a disabled deployment candidate. Passing software tests does not authorize mainnet payments.

## Hosting identified

- Repository: `darklightforce666-cmd/rebound`, candidate branch `rewards-v2-implementation`, pull request 1.
- Netlify: `tourmaline-melomakarona-72b603`, project ID `c2115758-040a-468b-b73b-68577ece7954`.
- Candidate URL: `https://deploy-preview-1--tourmaline-melomakarona-72b603.netlify.app`.
- Public role assignments: [WALLET-ADDRESSES.md](WALLET-ADDRESSES.md). Addresses alone do not prove control or deploy the roles.
- Keep `REWARDS_TRANSFERS_ENABLED=false`. Retain existing project access protections.

## Netlify runtime correction

The deployed preview crashed before invoking its rewards handler: CommonJS `rpc-websockets@9.3.9` required ESM-only `uuid@14`. Ordinary Node 24 execution hid the problem because it enabled synchronous `require(ESM)`, whereas the deployed Lambda runtime disabled it.

`pnpm-workspace.yaml` pins that dependency edge to CommonJS-compatible `uuid@11.1.1`, including the published buffer-bounds security fix. Jayson's UUID dependency is pinned to the same release and Anchor's TOML parser to 4.2.0 for published parser fixes. The official SDK versions remain unchanged. The lockfile and Docker dependency-copy step include these settings. Install scripts are disabled explicitly, matching the verified CI installation instead of failing Netlify's default strict install. `scripts/check-functions.cjs` loads the function modules with `--no-experimental-require-module` and exercises disabled health/launch/RPC behavior without network access or secrets. The standard test suite runs this regression in a separate process.

Set `NODE_VERSION=24`, `PNPM_VERSION=11.19.0`, and `AWS_LAMBDA_JS_RUNTIME=nodejs24.x` in Netlify, then deploy the candidate again. The runtime override must be in Netlify environment settings, not `netlify.toml`. These three public settings and all supplied public role addresses were saved in the project during this readiness pass. Existing RPC secret values were not read or replaced. Function-scoped settings become effective on a new deploy.

References: [Netlify function configuration](https://docs.netlify.com/build/functions/configuration/), [uuid CommonJS support](https://github.com/uuidjs/uuid), [pnpm settings](https://pnpm.io/settings).

The legacy Netlify function packager also failed to resolve a transitive `@babel/runtime` dependency under pnpm's layout. `netlify.toml` selects the documented esbuild function bundler; the hosted function must still be checked after a successful deploy, not just after the static build.

## External blockers found in this pass

Public DNS checks at 2026-09-17 17:20 UTC returned NXDOMAIN for both `reboundpad.fun` and `www.reboundpad.fun`, with authority at the `.fun` zone. HTTPS could not resolve either hostname. GoDaddy required user sign-in, so the registrar status could not be inspected or repaired. Do not assume this is only an incorrect A record; verify registration, domain status and nameserver delegation first. No registrar or DNS records were changed.

The production dependency audit initially reported five advisories. UUID and TOML fixes reduce that to two: [bigint-buffer native overflow](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) and [stream-json filter resource exhaustion](https://github.com/advisories/GHSA-528h-pc64-c93x). The audit's suggested `bigint-buffer@1.1.6` and `stream-json@3.4.1` versions returned 404 from the npm registry during verification; they must not be treated as installed fixes. Install scripts remain disabled and the tested bigint path reports its pure-JavaScript fallback. This is not a completed native-path or whole-dependency security assessment. Production activation requires a reviewed mitigation, a compatible published patch/replacement, or a documented reachability assessment for these remaining advisories. No audit exclusions were added to hide them.

## Reproduce checks

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
node --no-experimental-require-module scripts/check-functions.cjs
node scripts/rewards/manage.cjs preflight
```

With no production configuration, preflight returns JSON blockers and exit code 2 before attempting RPC/database access. It never prints endpoint credentials. All four signer loaders require an explicit matching public address. Preflight also checks that the configured governance address matches both the program administrator and upgrade authority; that address match alone is not a multisig/timelock review.

Full program execution remains in `.github/workflows/rewards-v2.yml`. The three protocol-capture checks initially skip until the workflow generates the captured execution trace; its final replay step requires all of them. For a previously downloaded trace:

```sh
PUMP_EXECUTION_FIXTURE=contracts/v2/artifact/pump-execution.json pnpm test
```

This is replay of locally executed real Pump binaries with synthetic trades, not production historical acceptance evidence. Windows users can set `PUMP_EXECUTION_FIXTURE` in PowerShell before running the command.

## Remaining production gates

1. Provision PostgreSQL, apply all four migrations with the schema-owner credential, then create separate login credentials using `scripts/rewards/database-roles.sql`. Netlify must not receive schema-owner or verifier signer privileges. Test backup and recovery.
2. Provision continuous indexer/scheduler and a separately operated verifier host. Use the Docker profiles deliberately; no payment profile should start yet. The existing Compose file is a development convenience and does not establish production service independence.
3. Supply archival history access, verify launch-to-current completeness, and measure throughput and payment verification latency under the 96-slot index-lag / 20-slot authorization limits. The existing production RPC secret alone does not establish archive coverage.
4. Provision the four server signer files securely and prove they match the recorded addresses. Fund only the relevant transaction fee payers after cost estimation; per-coin PDAs have no private keys and need no recurring gas dispenser.
5. Deploy the reviewed rewards program, record its actual program ID and binary hash, configure the governed upgrade/admin authority, and independently verify its multisig/timelock arrangement. The nominated public address is not proof of governance.
6. Execute the real deployed API/wallet lifecycle, ordinary and early graduation, receipt reconciliation, automated delivery, retry/direct-claim, recovery and pause procedures. Validate the static launch setup deposit and any refund design before admitting public launches.
7. Complete independent security review, funding/price manipulation calibration, per-lot correction checks, and supported-router coverage. Do not turn unknown routes or incomplete evidence into qualifying purchases.
8. Only with reviewable evidence fill in `rewards-activation.example.json`, register and verify the deployment, and deliberately enable the production gates. Do not mark checks passed merely to make preflight green.

The verifier/indexer, historical data, governed upgrade authority and wallet-link policy remain trusted. The sale-between-finalized-check-and-execution race and hidden common wallet ownership cannot be eliminated by a Merkle proof or PDA.
