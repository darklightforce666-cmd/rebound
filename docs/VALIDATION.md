# Validation

Validated locally on 2026-09-14 for version 0.5.0.

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
