# Token Radar — pre-token protocols ranked by implied launch value

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/caothiquynh26-source/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/caothiquynh26-source/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

An entry for make.fun's ["Build the best token launch radar"](https://make.fun/bounty/token-radar-01) bounty ($1,325 USDC, deadline 14 December 2026). It reads the sealed DefiLlama snapshot of 758 protocols (14 November 2026), fits a value model from the 128 launched protocols that record a market cap, and ranks the 198 pre-token protocols most worth watching — all 40 on the watchlist, plus 158 early finds below the $50M floor — by what their token would be worth if it launched today. Every row carries a costed farm plan with a $/hour verdict. Protocols whose token already trades live in a separate Live view, at the market's own values, never mixed into the ranked board.

## The model (radar-2)

```
implied = TVL × multiple[category] × (TVL / $100M)^γ × (1 + growth% × w) × (floor + min(age, 1095)/1095 × range)
```

- **multiple[category]** — the winsorized median mcap/TVL of the launched comps in that category, after dividing out the size, growth and maturity terms. Categories with fewer than 5 comps fall back to the overall multiple of **0.1925**.
- **size (TVL / $100M)^γ** — a fitted exponent: a dollar of TVL in a giant protocol is worth less, in token terms, than a dollar in a small one. The snapshot's own figures show it plainly: median mcap/TVL is 0.65 below $10M TVL and 0.03 above $1B.
- **growth** — 1 + the 7-day TVL change (clamped to −60…+120%) × a fitted weight.
- **maturity** — a floor plus a range over 1,095 days of age with no token; unknown age reads 365 days.

The four weights are **fitted, not hand-picked**: `fitModel()` grid-searches them in this run, scoring each candidate by leave-one-out median |log error| over the 128 comps. The winning weights in this build:

| Weight | Value |
|---|---|
| Size exponent γ | −0.4 |
| Growth weight | 1.5 |
| Maturity floor | 0.7 |
| Maturity range | 0.5 |

Category multiples (categories with ≥ 5 comps): Canonical Bridge 0.7262, CEX 0.3978, Basis Trading 0.3698, Bridge 0.3294, RWA 0.2418, Yield 0.2286, Dexs 0.2039, Lending 0.0898, Liquid Staking 0.0636. The dashboard's Model tab lists every category.

## Held-out tests (run by main.ts on every build, shown in the dashboard)

| Split | Test n | Fitted med \|log err\| | Starter med \|log err\| | Median ratio | Rel MSE gain |
|---|---|---|---|---|---|
| Leave-one-out | 128 | 1.209 | 1.632 | 0.74× | 0.19× |
| Walk-forward, listed before 2024-11-14 | 32 | 1.182 | 1.661 | 0.71× | 15.7× |
| Walk-forward, listed before 2025-01-01 | 31 | 1.183 | 1.656 | 0.71× | 17.3× |
| Walk-forward, listed before 2025-06-01 | 20 | 1.399 | 1.599 | 0.88× | 15.6× |

Leave-one-out refits the multiples with one comp held out, 128 times. Walk-forward fits on protocols listed before the cutoff and tests on later-listed ones. Median |log error| is the typical miss in log terms (a miss of 1.0 means the prediction is off by a factor of e ≈ 2.7). The fitted model beats the house starter's median error on every split (1.14–1.41×). Relative MSE is the mean squared relative error: on walk-forward the fit wins it 15–17×, but on leave-one-out it loses it — one launched bridge token is nearly worthless (market cap $56k on $223M TVL), and no TVL-only model can predict a dead token, so that single fold dominates the mean. Both numbers are shown; the median is the typical miss.

Each row also carries an 80% conformal interval from the leave-one-out log residuals (10th–90th percentile), so the dashboard shows how wide the honest uncertainty is — for the top row, $12.0M–$1.83B around a $129.0M point estimate.

## Top of the board (this build)

| Rank | Protocol | TVL | Implied value |
|---|---|---|---|
| 1 | Steakhouse Financial | $2.75B | $129.0M |
| 2 | Gauntlet | $1.58B | $103.6M |
| 3 | Veda | $1.56B | $86.7M |
| 4 | USDD | $1.06B | $74.2M |
| 5 | Upshift | $499M | $58.2M |

The house starter's fixed 0.25 multiple would put Steakhouse near $544M; the fitted size exponent and the Risk Curators fallback multiple pull it to $129M, because the launched comps say giant protocols launch far below a quarter of TVL.

## Farm plans

Six steps per row, derived from the protocol's own category, chains, TVL and age — never a hardcoded name list. Each step states its cost (gas + capital) and time. The $/hour verdict assumes 5% of the implied value reaches an airdrop pool shared by about 25,000 qualifying wallets, minus gas across 8 transactions at the chain's per-transaction price, over the plan's hours. Top rows clear $100/hour; most small rows go negative on gas alone, and the dashboard says so.

## How to run it

Node 22 or later, standard library only, no network at run time:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path to snapshot.json or its directory>
```

In the grader's container the snapshot is mounted at `/input/snapshot.json` and the output goes to `/output`. The program writes `board.json`, `data.js`, `dashboard/` (index.html + app.css + app.js), `screenshots/` and `dossier.json` (built with the vendored `vendor/makefun-board.ts`). Two runs from clean directories produce byte-identical output.

To view the dashboard locally, serve the output directory (any static server) and open `dashboard/index.html`. The page is static: no framework, no network, sortable table (rank / implied / TVL / growth / age / farm $/h), category + chain + search filters, a detail drawer per protocol with the equation breakdown, farm plan and $/hour verdict, a Live tab, and a Model tab with the fitted constants and the held-out numbers. `#/detail/<slug>` opens a protocol, `#/filter/<category>` applies a filter.

## Layout

```
main.ts                  the program: fit, score, write /output
lib/model.ts             the fitted model, held-out tests, farm plans, board builder
vendor/makefun-board.ts  make.fun's dossier library (verbatim, as the kit instructs)
dashboard/               index.html, app.css, app.js (static, no network)
data/enrichment.json     plain-text descriptions + social handles, fetched from DefiLlama at build time
screenshots/             1-board.png, 2-detail.png, 3-filtered.png (1440×900)
```

Snapshot: DefiLlama protocols, fetched 2026-11-14. Implied values are this radar's own claim, fitted from the snapshot's launched protocols — never make.fun's, and never a promise that a token will launch.
