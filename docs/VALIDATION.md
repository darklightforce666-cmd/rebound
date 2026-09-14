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

## SOL artwork and layout update

Rechecked six routes at 320, 390, 768, and 1440 pixels after adding falling SOL artwork, a floating medallion, a revised allocation card, and a unified metrics panel. All 24 views retained the expected page headings and Solana/wallet header without horizontal overflow. Visually reviewed desktop and mobile layouts.

Confirmed that SOL particle transforms change over time, pause stops the particles and medallion, and the pause preference survives reload. Mobile displays eight decorative pieces across the background and hero, compared with eighteen on desktop. Route changes do not duplicate background particles. A separate execution of the motion controller verified device reduced-motion preference changes and hidden-tab handling. Decorative elements ignore pointer input and are hidden from assistive technology.

Discovery search, opening Second Wind, wallet popup opening/closing, and a 0.5 SOL quote for 4,700 WIND still work. No application console errors were recorded. All 13 existing tests pass. Market values and chart points are not animated by the decorative layer.
