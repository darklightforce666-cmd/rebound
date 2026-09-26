# REBOUND program V3 — release artifact

| Field | Value |
|---|---|
| File | `rebound_rewards_v3.so` (212 320 bytes) |
| sha256 | `3e16983745870fdf5efed8c307e401362c0b7d85e21604ab52b6b3efc3a5203f` (see `SHA256SUMS`) |
| Sources | `contracts/v3/src` at commit `1601c87282dbd2913367b6cc0a3b583e19df200b` |
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
head -c 212320 /tmp/onchain.so | sha256sum        # must equal SHA256SUMS
tail -c +212321 /tmp/onchain.so | tr -d '\0' | wc -c   # must print 0 (only zero padding after the program)
```

Rehearsed on a mainnet-equivalent local validator on 2026-09-26: the deployed bytes matched this hash, and
the programdata rent at `--max-len 300000` was 2.0892 SOL.
