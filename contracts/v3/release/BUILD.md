# REBOUND program V3 — release artifact

| Field | Value |
|---|---|
| File | `rebound_rewards_v3.so` (210 848 bytes) |
| sha256 | `2298cf581c8b4b3ab0016d8532bd7ae70edd6d72724192e1516e997adead8f46` (see `SHA256SUMS`) |
| Sources | `contracts/v3/src` at the commit that adds bitmap payouts and `CloseRound` (2026-09-27; `git log -- contracts/v3/src`) |
| Toolchain | Agave 4.2.2 release, `cargo-build-sbf` 4.1.0, platform-tools v1.54, rustc 1.89.0 |
| Command | `cd contracts/v3 && cargo build-sbf` (default `--arch v0`) |
| ELF | `e_machine` 263 (SBF), `e_flags` 0 → **SBPF v0** |

## Why SBPF v0

As of 2026-09-26, mainnet-beta accepts deployments of SBPF v0–v2 only:

- SIMD-0500 ("disable deployment of SBPF v0/v1/v2", feature `B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g`)
  is **not queued** on mainnet, devnet or testnet.
- The SBPF v3 enable gate is inactive on all public clusters.

A `--arch v3` build would therefore be rejected, so the v0 build is the one to deploy.

`solana-test-validator` 4.2.2 activates SIMD-0500 by default, so a local rehearsal must start it with
`--deactivate-feature B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g` to match mainnet.

Before a later redeploy, recheck the cluster's feature status:
`solana -um feature status B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g`.
Once SIMD-0500 activates, upgrades must use a v3 build.

## Verify a deployment

```sh
solana -um program dump <PROGRAM_ID> /tmp/onchain.so
head -c 210848 /tmp/onchain.so | sha256sum        # must equal SHA256SUMS
tail -c +210849 /tmp/onchain.so | tr -d '\0' | wc -c   # must print 0 (only zero padding after the program)
```

The previous build (212 320 bytes) was rehearsed on a mainnet-equivalent local validator on 2026-09-26 (deployed bytes
matched its hash). Programdata rent for this build at its exact length (`--max-len 210848`) is about 1.469 SOL;
`--max-len 300000` would cost about 2.09 SOL. The deploy buffer needs about the same again temporarily and is refunded.

## What changed from the previous build

- Payout receipts are a bitmap inside the round account (1 bit per award) instead of one 0.0018-SOL `Paid`
  account per recipient; `Pay` takes (deployment, coin, round, wallet) and needs no signer.
- New `CloseRound{cycle}` (tag 21): once every award is paid, the round account is closed and its rent returns
  to the account that funded it (`Round.rent_payer`).
- `Fund` accepts up to 64 000 awards per round.
