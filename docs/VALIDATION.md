# Validation

Executed on 14 September 2026.

Palette revision: replaced all inherited accent hues with charcoal and emerald throughout the interface and SVG assets. Neutral text and different green values preserve readable contrast. Negative price changes retain their minus sign and use a dashed chart line. Desktop discovery and mobile discovery/token screens were reviewed again, mobile navigation worked, no horizontal overflow or application console errors were observed, and all 11 automated tests passed after the palette update.

## Automated tests

`node scripts/test.cjs`: 11 passing tests.

Coverage includes SOL fixture denominations, fee conservation over 1,001 receipt sizes, lot maturity, permanent outgoing disqualification, delayed claims, duplicate-claim rejection, funded-claim survival after a sale, guardian cancellation, receipt idempotency, allocation caps and rounding, complete price history, buyback gates, precise amount parsing, and BigInt persistence.

The repository-wide terminology check covers HTML, CSS, JavaScript, fixtures, tests, documentation, JSON, SVG assets, and the generated preview. It rejects the retired stablecoin symbol, the retired holder phrase, both long dash characters, and their named HTML entities.

## Browser checks performed

The in-app Chromium browser rendered all seven routes at 320, 390, 768, and 1440 pixels: discovery, token detail, launch, portfolio, analytics, buybacks, and documentation. All 28 route/width combinations rendered their expected heading without document-level horizontal overflow. Desktop and mobile screenshots were visually reviewed. No application console errors were observed.

Desktop interaction checks passed for community filtering, token search, navigation, a 0.5 SOL buy yielding 4,700 WIND, fee collection, round funding, early claim rejection, a matured 1.08 SOL claim, sale confirmation, permanent disqualification, persistence after reload, token name validation, tax bounds, and all three launch steps.

Buyback scheduling and the 48-hour advance exposed the checks-required state without reporting an executed purchase. The wallet dialog and missing-Phantom state worked without a transaction request.

Mobile checks passed for the bottom navigation menu, three-step token creation, a 0.1 SOL paper buy, reset confirmation, restoration of eight fixture tokens, keyboard token navigation, and round manifest display with SOL and nine decimals.

## Limits

Browser tests used the local prototype in Chromium. Real wallet extension connections, transaction signing, on-chain transfers, Pump.fun integration, Safari, and physical touch devices were not tested. The earlier conversation's test counts are not reused as evidence for this import.
