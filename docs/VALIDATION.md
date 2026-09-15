# Validation

> Historical V1 validation. These results do not certify V2. Use [current implementation and validation](REWARDS-V2.md) and the latest Conditional rewards V2 workflow.

## Current update: 2026-09-15

The website and banner wordmark no longer have a trailing dot. The footer separator after REBOUND is also removed. The standalone HTML and downloadable branding are rebuilt from the current sources. The latest repository title, favicon, and entry screen changes are preserved.

All 37 automated checks passed for commit `ede53bbf6c1107a84b55c37741973be0e2c32f37`: 14 prototype checks, 4 proof-builder checks, 3 Rust unit tests, and 16 tests executing the compiled Solana SBF program in LiteSVM. [Successful build and test run](https://github.com/darklightforce666-cmd/rebound/actions/runs/34950980043).

The VM checks cover real System Program transfers, the 85/15 split, direct-deposit reconciliation, hourly openings, correction timing, prefunded accounts, permission checks, cancellation, pause behavior, publisher rotation, invalid proofs, duplicate-payment prevention, and the JavaScript builder to Python payout-plan to on-chain receipt path. They do not test a live RPC, installed wallet extensions, or the future trade indexer and creator-fee collector.

The browser automation runtime failed to initialize during this update. No new desktop/mobile visual or end-to-end browser pass is claimed for the hourly change. The earlier browser results below describe the previous ten-minute demo behavior. The revised browser checklist uses automatic hourly payouts.

The contract is a deployment candidate. No program deployment, scheduler activation, or real payment was performed. Live indexing, fee collection, devnet validation, and security review remain launch work.

The saved SBF binary is 127,792 bytes with SHA-256 `c9e1bb301a307459deb25742fe7ae74dea95e049c44fb7446ea0fb83f653dcbb`. Its lockfile is included in `contracts/Cargo.lock`. The build ZIP contains only the program, lockfile, checksum, and commit identifier.

## Earlier validation: 2026-09-14

Validated locally for version 0.5.0 before the hourly payout change.

## Automated checks

`npm test` passes 13 tests. Coverage includes the 85/15 fee split, integer conservation across 10,001 amounts, duplicate receipts, position maturity, proportional funding, claim timing, post-sale funded claims, cancellation, reference pricing, and policy-safe persistence.

Wallet mocks execute the application connection handlers. They verify public-address connection, rejected requests, invalid addresses, account changes, listener cleanup, and disconnection without invoking transaction signing or changing simulated funds.

The copy check scans source, tests, fixtures, documentation, editable assets, and generated preview text for retired terminology, allocation values, and long-dash characters or entities.

## Browser checks

All six routes were checked at 320, 390, 768, and 1440 CSS pixels wide. These 24 combinations had no document-level horizontal overflow or retired visible terminology. Desktop and mobile screenshots were visually reviewed, including the two-column wallet dialog and its stacked mobile layout.

Executed discovery search, a 0.5 SOL simulated purchase of 4,700 WIND, reward funding, rejection of a premature claim, a successful 1.1475 SOL claim after advancing ten minutes, and a 100 WIND sale. The sale ended future rewards and survived reload.

The mobile creation wizard rejected an empty token name, accepted valid details, showed the SOL and 85/15 policy at review, created a local token, and retained it after reload. Test simulation data was then reset through the interface.

Checked missing-provider feedback and dialog dismissal. No browser application errors were recorded. Real wallet extension approval was not exercised; connection behavior is covered by mocks and missing-provider browser checks. Real minting, trading, and payouts remain outside this prototype.

The standalone HTML, 1024 x 1024 logo, and 1500 x 500 banner are exported with the current copy and fee split.

## SOL artwork and layout update

Rechecked six routes at 320, 390, 768, and 1440 pixels after adding falling SOL artwork, a floating medallion, a revised allocation card, and a unified metrics panel. All 24 views retained the expected page headings and Solana/wallet header without horizontal overflow. Visually reviewed desktop and mobile layouts.

Confirmed that SOL particle transforms change over time, pause stops the particles and medallion, and the pause preference survives reload. Mobile displays eight decorative pieces across the background and hero, compared with eighteen on desktop. Route changes do not duplicate background particles. A separate execution of the motion controller verified device reduced-motion preference changes and hidden-tab handling. Decorative elements ignore pointer input and are hidden from assistive technology.

Discovery search, opening Second Wind, wallet popup opening/closing, and a 0.5 SOL quote for 4,700 WIND still work. No application console errors were recorded. All 13 existing tests pass. Market values and chart points are not animated by the decorative layer.
