# Conditional Markets Viewer - TODO

Items to do. Add freely, delete when done (move to Completed.md if it was significant).

**Usage**: Keep it messy. One-liners are fine. Delete aggressively. If you're spending more than 30 seconds writing a TODO, you're overdoing it.

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
- [x] AMM modeling for accurate cost/shares estimates
      Added: sharesForCost, costForShares using real CPMM math
      Pool data (YES/NO) fetched from API for each answer
- [x] API dry-run validation
      "Validate" button compares local AMM to API dry-run
      Shows per-leg comparison with error percentage
      Caveat: Multi-leg validates independently (no sequential price impact)
- [x] Sequential execution simulation in trade planning
      Each hedge trade updates simulated pool state before next trade
      Note: Doesn't account for multi-choice auto-arb
- [ ] User-defined slugs
      Enter any market slug, manually map 4 outcomes to grid cells
- [x] Add more conditional markets to markets.json
      All 6 from verified_arbitrage.yaml added, all active

## Future
- [ ] Position display (show current shares in each cell)
- [ ] Multi-bet API for atomic execution (reduces slippage, but sizes differ)
- [ ] Ternary market support (A/~A/Other)
- [ ] Arbitrage detection (flag mispriced conditionals vs joints)
- [ ] Expected value calculator
- [ ] Security audit for API key handling
- [ ] Mutual information / phi coefficient display
