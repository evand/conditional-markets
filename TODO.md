# Conditional Markets Viewer - TODO

## MVP
- [x] Project scaffolding
- [x] Market data fetching from Manifold API
- [x] Parse 2×2 structure from multi-choice answers (explicit truthTable mapping)
- [x] Confusion matrix UI with joint probabilities
- [x] Marginal and conditional probability display
- [x] Market selector dropdown
- [x] API key handling (localStorage)
- [x] Direct cell betting (click joint cell → bet panel)
- [x] Dark theme styling

## Next Up
- [ ] Conditional betting on P(A|B) cells - click to buy with hedging
      Strategy: To bet on P(A|B), buy 1 share each of ~B outcomes (hedge),
      spend rest on A&B. Neutral on B outcome, exposed to A|B.
- [ ] Marginal betting on P(A)/P(B) rows/cols - multi-bet on all cells in row/col
- [ ] AMM modeling for accurate cost estimates (sequential bets move market)

## Future
- [ ] User enters slug directly and maps outcomes to grid
- [ ] Arbitrary multi-choice outcome grouping
- [ ] Ternary market support (A/B/Other)
- [ ] Bet history display
- [ ] Multiple markets comparison view
- [ ] Security audit: we're handling real API keys and using them. What should we be concerned about?
- [ ] mutual information and phi coefficient
  - [ ] betting up or down on same, in a directionally neutral manner
