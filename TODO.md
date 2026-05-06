# Conditional Markets Viewer - TODO

Items to do. Add freely, delete when done (move to Completed.md if it was significant).

**Usage**: Keep it messy. One-liners are fine. Delete aggressively. If you're spending more than 30 seconds writing a TODO, you're overdoing it.

## Next Up
- [ ] Numeric view: history chart for P(selected subset) over time (use existing bet-timeline machinery, sum probAfter across selected answers)
- [ ] Numeric view: NO direction (sell / short the selected subset). multi-bet API is YES-only — would fall back to per-leg /bet calls
- [ ] Numeric view: auto-detect bucket assignment in config dialog (parse "44", "0-4", "≤11", "≥16", "Other" from answer texts; user confirms)
- [ ] Numeric view: positions display (current shares per bucket, P&L if you've held)
- [ ] Limit order detection/warning (affects validation accuracy)
- [ ] Validate before live trade and abort / "trade anyway?"
- [ ] **Correlation betting: multi-bet support** - Use multi-bet API for smaller trades
  - Multi-bet enforces equal shares across selected answers, so we'd still need 3 separate calls
  - But sizing is more convenient for hitting M$1 minimum on each component

## Future
- [ ] Security audit for API key handling (basic review done, localStorage approach is reasonable)
- [ ] Generate list of all 2x2 markets on Manifold?
- [ ] Ternary market support (A/~A/Other)
  - terence-tao-leaves-academia-for-an, will-jd-vance-win-the-2028-us-presi-qIQSEs6AcQ
- [ ] higher outcome count market support e.g. will-the-us-attack-a-nato-member-an
- [ ] Mutual information / phi coefficient display
- [ ] Threshold-market view (independent MC, sumsToOne=False), e.g. how-many-house-seats-will-the-democ
  - View-only with explainer comparing to bucket form (the threshold↔bucket equivalence demo)
