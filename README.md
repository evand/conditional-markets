# Conditional Markets Viewer

A betting tool for complex Manifold Markets positions that the native UI doesn't directly support.

**Live site**: https://evand.github.io/conditional-markets/

## Views

### 2×2 Matrix
For linked multi-choice markets that encode a joint distribution over two binary events (A, B).

- Confusion-matrix display with joint, marginal, and conditional probabilities
- Direct, marginal, conditional (auto-hedged), and correlation betting
- History charts for any cell or derived statistic

### Numeric Range
For numeric multi-choice markets, in either of two on-chain shapes:

- **Bucket markets** (linked, sums-to-one) — each answer is a value/range/open tail. Full betting.
- **Threshold markets** (independent, sums-to-one = false, e.g. `215+`, `213+`) — each answer is an `X ≥ value`
  event. Parsed into the intervals *between* the sorted thresholds. View + holdings only (a derived bucket
  has no single answer to bet on).

Features:
- Sorted PDF + CDF (`P(≥X)`) table; the CDF column makes the threshold↔bucket equivalence visible
- Per-row `≥` / `≤` / `=` shortcuts for tail and exact-value bets (bucket markets)
- Atomic `POST /multi-bet` for the union of selected buckets (equal shares; auto-arb handled by Manifold)
- **Holdings in both forms** — with an API key, two columns show your current position regardless of the
  underlying structure: **Held =** is the payout (M$) if the outcome lands in that row; **Held ≥** is the
  equivalent net shares of the `X ≥ row` threshold (`+long` / `−short`). The two are the same position in
  PDF vs CDF form — identical payout at resolution, differing only in how the AMM priced each leg. NO shares
  are netted rigorously (in a sums-to-one market a NO share pays on every *other* outcome).
- "Other" buckets shown separately and excluded from quick-selects, since they may resolve to either tail when the creator splits them later

Both views support per-leg dry-run validation, deep linking by slug, and adding more markets locally.

## Status

Alpha - see the warning banner on the live site.

## License

MIT
