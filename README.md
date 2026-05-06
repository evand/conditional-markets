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
For linked multi-choice markets where each answer is a numeric bucket (single value, range, or open tail).

- Sorted PDF + CDF (`P(≥X)`) table; the CDF column makes the threshold↔bucket equivalence visible
- Per-row `≥` / `≤` / `=` shortcuts for tail and exact-value bets
- Atomic `POST /multi-bet` for the union of selected buckets (equal shares; auto-arb handled by Manifold)
- "Other" buckets shown separately and excluded from quick-selects, since they may resolve to either tail when the creator splits them later

Both views support per-leg dry-run validation, deep linking by slug, and adding more markets locally.

## Status

Alpha - see the warning banner on the live site.

## License

MIT
