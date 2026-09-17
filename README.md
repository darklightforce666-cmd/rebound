# rebound

Pump.fun launchpad with mint-isolated, conditional loss-based SOL rewards. Creator fees actually collected are split **85% eligible holders / 15% platform operations**. Purchases mature after 30 minutes; automatic cycles start every 30 minutes. Every payout, retry and fallback delivery requires fresh eligibility verification.

**Production launches and transfers are disabled.** The implementation candidate includes the Solana program, Pump adapters, finalized index/replay, PostgreSQL accounting, independent verifier, durable worker and existing-site UI integration. It is not an audited or activated mainnet system. See the [implementation and validation status](docs/REWARDS-V2.md), [runbook](docs/REWARDS-OPERATIONS.md), and [threat model](docs/REWARDS-THREAT-MODEL.md) for precise limits and missing production inputs.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm build
pnpm start
```

Use Node 24 and pnpm 11.19. The site retains its design, logo, Phantom/Solflare integration and market charts. Its requested entry-screen password is `1111`; privileged actions use independent server and wallet authentication. `dist/` contains browser assets only. Netlify hosts the API; continuous workers run on a separate server. `.env.example` includes public operations address `5toTaaYKbF12cXRf9J5soN41tyhCUmNjfdGYQ8JwUroM`, empty production configuration values and no secrets.

Current program: `contracts/v2/`. Current policy and services: `server/rewards/`. Current tests: `tests/rewards/` and `contracts/v2/tests/`. The former `contracts/` V1 program and `src/engine.cjs` are archived historical implementations; do not deploy them for this policy.

Run the complete compiled-program and cloned-Pump test sequence from [REWARDS-V2.md](docs/REWARDS-V2.md). CI produces the SBF build, hashes, source commit, local protocol execution trace and site preview. Local trade/price fixtures are explicitly distinguished from production historical data. No production wallet private key is stored or requested.
