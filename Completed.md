# Conditional Markets Viewer - Completed

Historical record of completed work.

## MVP (2026-01-25)
- Project scaffolding
- Market data fetching from Manifold API
- Parse 2×2 structure (explicit truthTable mapping in markets.json)
- Confusion matrix UI with joint probabilities
- Marginal and conditional probability display
- Market selector dropdown
- API key handling (localStorage)
- Direct cell betting (click joint cell → bet panel)
- Dark theme styling

## Conditional Betting (2026-01-25)
- Conditional betting with hedging
  - Buy N shares of each hedge cell (not equal dollars!)
  - Spend remainder on target cell
  - Neutral payout when hedged condition occurs
- Marginal betting (multi-bet on row/column cells)
- Trade plan display with estimated shares
- 2×2 payout matrix (WIN/LOSE/NEUTRAL for each outcome)
- Direction toggle (YES/NO) for conditional bets

## AMM & Validation (2026-01-25)
- Real CPMM math: sharesForCost, costForShares, poolAfterTrade
- Pool data (YES/NO) fetched from API for each answer
- API dry-run validation ("Validate" button)
- Sequential execution simulation in trade planning
- All 6 conditional markets from verified_arbitrage.yaml added

## Technical Notes

### Hedge Math
To bet M$X on P(A|B):
1. Buy X shares of each ~B outcome (costs X × P(~B) total)
2. Spend rest on A&B target
3. Payouts: neutral if ~B, win if A&B, lose if A&~B

### AMM Formulas (p=0.5)
```javascript
// Shares for cost
sharesForCost(y, n, cost, 'YES') = cost + (y - y*n/(n+cost))

// Cost for shares
costForShares(y, n, shares, 'YES') = (shares - y - n + sqrt((y+n-shares)² + 4*shares*n)) / 2

// Probability
prob = n / (y + n)
```

### Limitations
- Validation tests legs independently (no sequential impact)
- Sequential simulation doesn't account for multi-choice auto-arb
- Full accuracy would require replicating Manifold's auto-arb logic
