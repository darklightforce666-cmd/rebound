# REBOUND public wallet assignments

Recorded on 2026-09-17. The six newly supplied addresses are assigned in the order of the preceding requested list. The operations address was supplied earlier.

| Role | Public address | Configuration |
|---|---|---|
| Operations treasury | `5toTaaYKbF12cXRf9J5soN41tyhCUmNjfdGYQ8JwUroM` | `REWARDS_OPERATIONS_ADDRESS` |
| Delivery fee payer | `8JeVgRsPf6VtCDDkhWUcn8mWKErjdzDAamdnA23CspMA` | Signer loaded from `REWARDS_DELIVERY_PAYER_KEY_FILE` |
| Fallback-claim fee payer | `7BGWVAHxfd8Sw2pWhZvg54xfdQRMkDax8bazdGfLPRGd` | Signer loaded from `REWARDS_CLAIM_PAYER_KEY_FILE` |
| Allocation publisher | `3dszcTGYJfFxqw3NXHasuqCvwmhdEFuj3DjaVWxSdvPp` | `REWARDS_PUBLISHER_ADDRESS` |
| Independent verifier | `EU7W4cvVkeaZq6dZDC95BvG86rSB5uRUCyWuXAKeW188` | `REWARDS_VERIFIER_ADDRESS` |
| Emergency guardian | `EddksGhxNWgh7ECR92XEKPzumuEoWgThR4yf51Tv3G4d` | `REWARDS_GUARDIAN_ADDRESS` |
| Nominated governance / admin / upgrade authority | `GVbkjSXm8TodYnfRSd2rMw1pDZVgyN5YyNSdqKJwKamF` | `REWARDS_GOVERNANCE_ADDRESS` |

## Validation and status

All seven addresses decode to canonical 32-byte Solana public keys, are distinct, and pass the SDK's on-curve check. This validates address format only. No proof of control, account ownership, balance, governance arrangement or deployment was checked. These are user-provided assignments, not newly generated wallets or onchain role registrations.

The governance address is recorded as nominated. An on-curve public key by itself does not demonstrate multisig or timelock control. The final governed authority and its ability to initialize and operate the rewards program must be verified before deployment. Do not mark the governance activation gate as passed merely because an address has been provided.

All four server signing files must match their configured public addresses. Delivery and fallback use `REWARDS_DELIVERY_PAYER_ADDRESS` and `REWARDS_CLAIM_PAYER_ADDRESS` respectively; their loaders reject missing or mismatching public addresses before use. Public addresses alone cannot sign transactions or authorize payments.

No production private keys were supplied, generated or installed. No SOL was transferred. The public assignments were saved in the Netlify project `tourmaline-melomakarona-72b603` on 2026-09-17, with `REWARDS_TRANSFERS_ENABLED=false`. They are also in the configuration examples. This does not install signer files or establish onchain roles. Worker hosts, a production database, deployed program and governed authority remain to be provisioned and verified.

## Roles

- Operations receives the fixed 15% operations share and finances expenses.
- Delivery pays fees and account rent for scheduled collection and payout transactions.
- Fallback pays fees for freshly verified fallback delivery.
- Publisher proposes and signs funding of conditional reward rounds; it cannot fund a round alone.
- Verifier independently checks receipts, allocations, exits and payment-time eligibility, and signs the corresponding authorizations.
- Guardian can pause the program in an emergency.
- Governance administers the program, controls its retained upgrade authority and authorizes delayed resumption.

Per-coin intake and treasury PDAs are derived by the program and have no private keys. They are separate from these platform roles.
