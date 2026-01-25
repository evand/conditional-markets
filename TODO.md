# Conditional Markets Viewer - TODO

## Completed
- [x] Project scaffolding
- [x] Market data fetching from Manifold API
- [x] Parse 2×2 structure (explicit truthTable mapping in markets.json)
- [x] Confusion matrix UI with joint probabilities
- [x] Marginal and conditional probability display
- [x] Market selector dropdown
- [x] API key handling (localStorage)
- [x] Direct cell betting (click joint cell → bet panel)
- [x] Conditional betting with hedging (buy N shares each hedge cell, rest on target)
- [x] Marginal betting (multi-bet on row/column cells)
- [x] Trade plan display with estimated shares
- [x] 2×2 payout matrix (WIN/LOSE/NEUTRAL for each outcome)
- [x] Direction toggle (YES/NO) for conditional bets
- [x] Dark theme styling

## Next Up
- [ ] AMM modeling for accurate cost/shares estimates
      Current: shares ≈ amount/prob (ignores slippage)
      Need: Proper CPMM math from manifold library
- [ ] API dry-run validation
      Verify our forecasts match Manifold's calculations
      Use /v0/bet with dryRun=true parameter
- [ ] User-defined slugs
      Enter any market slug, manually map 4 outcomes to grid cells
- [ ] Add more conditional markets to markets.json
      Check verified_arbitrage.yaml for 2x2_joint patterns

## Future
- [ ] Position display (show current shares in each cell)
- [ ] Multi-bet API for atomic execution (reduces slippage, but sizes differ)
- [ ] Ternary market support (A/~A/Other)
- [ ] Arbitrage detection (flag mispriced conditionals vs joints)
- [ ] Expected value calculator
- [ ] Security audit for API key handling
- [ ] Mutual information / phi coefficient display
