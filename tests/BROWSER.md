# Browser regression steps

Run `npm start`, open localhost, and reset the demo before testing. Use a separate browser profile if existing demo state needs to be preserved.

1. Check all seven routes at 320, 390, 768, and 1440 pixel widths. Confirm readable headings, usable navigation, and no document-level horizontal scroll. Token tables may scroll within their container.
2. On discovery, filter Community and expect seven rows. Filter $RBD and expect one. Search Second Wind and open the matching token. Verify SOL appears in the trade ticket and rewards.
3. Buy 0.5 SOL of WIND. Expect a 4,700-token quote at the default fee and price, and a 19.5 SOL paper balance afterward.
4. Fund a round. Attempt to claim before advancing the clock and expect rejection. Advance 10 minutes and claim. Expect the awarded SOL to be credited exactly once.
5. Sell 100 WIND and confirm the simulated sale. Check that future recovery is off after reload. Already-funded awards remain claimable.
6. Create a token. Empty name/ticker and an 11% tax must fail. Complete the wizard with a valid name, ticker, and 3% tax. Only SOL is selectable; no mint or pool is created.
7. Schedule buyback activation and advance 48 hours. The page must still require execution checks and show zero completed purchases.
8. Open the wallet dialog without an extension. Select Phantom and check the missing-provider message. Close the dialog without signing anything.
9. At mobile width, use More and bottom navigation, create a token, and buy with paper SOL. Confirm dialogs and buttons remain usable.
10. Reset the demo, expect eight tokens, open a token row with Enter, and inspect a round manifest. Check `asset: SOL`, `decimals: 9`, and null transaction signatures.
11. Open `preview/REBOUND.html` directly and confirm routes, styling, and interactions work without network assets.
