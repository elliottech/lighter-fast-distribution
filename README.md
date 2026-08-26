# lighter.fast improvement distribution

`lighter-fast-promoted-submissions.csv` is a read-only export of all promoted submissions for the Yukon benchmark `eigenlabs/lighter-prover-challenge`.

Run the analysis after replacing or updating that CSV:

```bash
bun run calculate-improvements.ts
```

The script writes:

- `results/solver-improvements.csv`: cumulative frontier improvement per solver, ranked.
- `results/winners.json`: the top six and three improvement-weighted random winners, including each winner's fixed LIT prize.

Each promoted submission receives only the positive distance by which it advances the global frontier. Those advances are summed across the full input period for each solver. The top six are sorted by cumulative improvement, then solver account ID.

## LIT rewards

The fixed 25,000 LIT prize pool is allocated as follows:

| Winner group | Place | Share of group pool | LIT prize |
| --- | ---: | ---: | ---: |
| Merit | 1st | 38.05% | 8,600 |
| Merit | 2nd | 24.34% | 5,500 |
| Merit | 3rd | 15.93% | 3,600 |
| Merit | 4th | 10.62% | 2,400 |
| Merit | 5th | 6.86% | 1,550 |
| Merit | 6th | 4.20% | 950 |
| Random | Draw 1 | 33.33% | 800 |
| Random | Draw 2 | 33.33% | 800 |
| Random | Draw 3 | 33.33% | 800 |

The six merit prizes total 22,600 LIT and follow ranks 1–6 in `results/solver-improvements.csv`. The three random prizes total 2,400 LIT and follow draw order in `results/winners.json`. Prize amounts are fixed in `calculate-improvements.ts`; cumulative improvement determines rank and draw weight, not the prize amount.

`excluded-github-logins.txt` snapshots the case-insensitive `YUKON_REWARD_EXCLUDED_GITHUB_LOGINS` production policy from Yukon's `fly.prod.toml`. Those submissions still advance the frontier, but the excluded solvers receive no attributed improvement and cannot appear in either winner group. Replace the file or pass `--excluded-logins-file <path>` when that production policy changes.

The weighted draw samples three additional solvers without replacement. At each draw, it picks a seeded random value between zero and the remaining cumulative improvement, then selects the solver whose cumulative range contains it. Top-six solvers are excluded by default so the two winner groups are distinct. Pass `--include-top-in-random` if they should remain eligible. A fresh seed is generated and saved in `winners.json`; rerun with `--seed <saved-seed>` to reproduce the draw exactly.

Useful options:

```bash
bun run calculate-improvements.ts --input updated.csv --output-dir updated-results
bun run calculate-improvements.ts --seed <saved-seed>
bun run calculate-improvements.ts --help
```
