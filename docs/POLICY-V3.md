# REBOUND reward policy V3 — frozen decisions

Status: decision record for implementation branch `rebound-v3-implementation`.
Source of authority: `REBOUND_IMPLEMENTATION_SPEC_EN.md` v1.0 (26 Sep 2026), sections 3–4, 7–10.
This file replaces the economics in `docs/REWARDS-V2.md` (operations 15%, 30-minute maturity,
permanent exit, wallet-link exclusion, 30-minute TWAP, 5 SOL liquidity floor). Those V2 rules are
**not** part of the active policy. V2 code is kept only as reference until each module is migrated.

Any change to a value below must change, in one commit: `server/rewards/policy-v3.cjs`
(and therefore the policy hash), the V3 program constants/config, the database policy row,
public UI copy, examples in this file, and the tests.

## 1. Owner-confirmed requirements (not changeable by the implementer)

| # | Rule |
|---|---|
| C1 | Rewards go to CURRENT holders whose remaining recognized tokens are worth less than their recognized purchase cost. Realized losses on sold tokens are not a reward basis. |
| C2 | A wallet may receive rewards in many cycles. Compensation already paid or actively reserved reduces its remaining compensable loss. |
| C3 | Cycle = 30 minutes. Recipient selection during the last minute; payout processing starts at cycle end. |
| C4 | PRIMARY token: 85% of new distributable funding → holder rewards; 15% stays on the connected dev wallet (never split again, never sent anywhere by REBOUND). |
| C5 | THIRD-PARTY tokens launched via REBOUND: 85% of creator-fee funding → that token's eligible holders; 15% → buy the PRIMARY token and actually burn it. |
| C6 | Third-party fees flow into a per-mint program-controlled intake/treasury. The creator connects a wallet and signs the setup transactions. A signed message is never treated as spending authority. |
| C7 | Supabase stores application state; Netlify hosts the website. |
| C8 | Practical mainnet testing with real test tokens, trades, reward transfers and burns. |

Holders never need to log in or claim. Eligibility comes from finalized chain history; delivery is automatic.

## 2. Implementation defaults (spec §4) — effective in policy `rebound-v3.0`

| Topic | Effective value |
|---|---|
| Reward asset | Native SOL (lamports) |
| Launch quote asset | SOL-paired Pump tokens only; Pump `holderReward`, mayhem and cashback modes stay **false** |
| Loss unit | USD (fixed point, 1 USD = 10^12 `usd_pico`); payment asset SOL |
| SOL/USD source | Pyth SOL/USD feed `0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` (historical updates via Hermes/Benchmarks); max age 30 s, max confidence 100 bps (1%) of price |
| Purchase accounting | FIFO lots per (mint, owner); proportional (integer, floor) removal of cost and compensation credit on partial disposal |
| Purchase maturity | None (0 s). Owning the lot at the cutoff is sufficient |
| Snapshot cutoff | `scheduled_end − 60 s` |
| Later activity | A funded award survives later sales/transfers/price moves; it is attached to its snapshot lots. Next-cycle eligibility changes normally |
| Partial sale | Reduces remaining quantity/cost/credit FIFO; never bans the wallet |
| Full sale then new purchase | Sold quantity gone; a new proven purchase may qualify |
| Incoming transfers / gifts | Create zero-basis, unrecognized lots (no cost, no value in the formula). Same-owner token-account moves preserve lots. Transfer out → back cannot reset credit (the returned quantity is unrecognized) |
| Loss cap | Award ≤ remaining compensable loss at the snapshot |
| Unused holder funding | Carried forward for the same token; never re-split |
| Reference price | max(valid cutoff spot, complete 60-second time-weighted token/USD price) |
| Price freshness | Last observation ≤ 30 s old at cutoff; max gap between observations 30 s; cutoff never slides |
| Missing evidence | Hold (`waiting_for_data`); a missing price/history is never zero |
| Wallet-link heuristics | Not applied (V2 funding-link exclusion removed from active policy) |
| Buyback slippage | 100 bps maximum (server hard cap 300 bps; changes are versioned) |
| Buyback price impact | 200 bps maximum; above → defer, budget stays reserved |
| Liquidity circuit breaker | Production: real quote reserve ≥ 0 lamports (disabled) with spot/TWAP discrepancy breaker 3× (30000 bps). Disclosed on the public policy page. Owner may raise it before activation |
| Rent for tiny payouts | Undeliverable (below rent-exempt for a brand-new account) awards stay as liabilities in state `deferred_rent`; optional operator rent sponsorship paid from the operating budget, never from the award |

The USD choice means a SOL/USD move changes a loss even if the token/SOL price is unchanged; UI copy
must say so.

## 3. Formulas (canonical; integers only)

Units: `lamports` (u64), raw token units (u64, mint decimals), `usd_pico` (unbounded integer,
stored `numeric(40,0)`), SOL/USD `P` = usd_pico per 1 SOL, token price `Q` = usd_pico per raw token
× 10^18 (`Q18`).

### 3.1 Funding split (spec §8.1), carry `c ∈ [0,99]` persisted per mint

```
holder_part = floor((85 × F + c) / 100)
new_carry   = (85 × F + c) mod 100
other_part  = F − holder_part
```

`other_part` = retained on primary dev wallet (primary) or buyback reserve (third-party).
Returned reservations, old treasury balances and carried amounts are never new `F`.

### 3.2 Position at cutoff (spec §7.3)

For wallet i with remaining recognized lots j:

```
Q_i = Σ remaining_quantity_raw_j                (recognized lots only)
C_i = Σ remaining_cost_usd_j
V_i = ceil(Q_i × Qref18 / 10^18)                (value rounds up = conservative)
K_i = Σ remaining active credits (paid + reserved) on those lots, at original round rates
L_i = max(0, C_i − V_i − K_i)
```

Eligible iff `Q_i > 0`, `L_i > 0`, complete verified basis, valid price.

### 3.3 Round allocation

```
H = available holder reserve (lamports)
S = Σ L_i (usd_pico), P = SOL/USD at cutoff (usd_pico per SOL)
loss_cap_i = floor(L_i × 10^9 / P)
budget     = min(H, floor(S × 10^9 / P))
award_i    = min(loss_cap_i, floor(budget × L_i / S))      (zero awards omitted)
credit_i   = min(L_i, ceil(award_i × P / 10^9))            (frozen USD credit)
```

Undistributed lamports stay in the token's holder reserve. `credit_i` is split over the wallet's
loss-bearing lots proportionally to each lot's own positive loss (floor, remainder to the earliest lot).

Worked example (policy test fixture): P = $100/SOL, F = 1 SOL new funding, holder part 0.85 SOL,
losses A $100, B $50, C $20 → awards 0.50 / 0.25 / 0.10 SOL, credits $50 / $25 / $10.
Next round with unchanged prices: losses $50 / $25 / $10.

### 3.4 Schedule

```
cycle_start(n)   = anchor + (n − 1) × 1800
scheduled_end(n) = anchor + n × 1800
cutoff(n)        = scheduled_end(n) − 60
```

Anchor: third-party = finalized launch block time; primary = admin activation time.
Program enforces: round funding only at/after cutoff(n) and before cutoff(n+1); payout only at/after
scheduled_end(n).

### 3.5 Test policy `rebound-v3.0-test`

Identical economics, `cycleSeconds = 120`, `cutoffLeadSeconds = 30`, allowed only for coins registered
in a deployment whose on-chain config has `test_mode = true` and whose mints are allowlisted.
Production `1800/60` is never changed globally.

## 4. Execution modes

`dry_run` (default) · `mainnet_test` (allowlisted mints/wallets, spend caps, TEST badge, separate
namespace) · `production` (separately enabled after completed activation checks).
