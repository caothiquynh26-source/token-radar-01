// Token Launch Radar — value model, fitted from the sealed snapshot's own launched comps.
//
// The model answers one question: if this pre-token protocol issued a token today, with its
// record exactly as the snapshot shows it, what would that token be worth? It uses only the
// snapshot's own figures — TVL, seven-day growth, age with no token, and category — and never a
// hardcoded list of protocol names: the same function scores every row.
//
//   implied = TVL x multiple[category] x size(TVL) x growth(change_7d) x maturity(age)
//
//   multiple[category]  the winsorized median mcap/TVL of the launched comps in that category
//                       (fallback: the winsorized overall median where a category has < 5 comps)
//   size(TVL)           (TVL / $100M) ^ gamma — a fitted exponent, negative: a dollar of TVL in a
//                       giant protocol is worth less, in token terms, than a dollar in a small one
//   growth(g)           1 + clamp(g, -60, 120) / 100 x w — a fitted weight on the 7-day TVL change
//   maturity(age)       floor + min(age, 1095) / 1095 x range — fitted floor and range; a protocol
//                       that has run longer with no token is worth more per TVL dollar
//
// The four weights (gamma, w, floor, range) are NOT chosen by hand: fitModel() grid-searches them
// in this run, scoring each candidate by leave-one-out median |log error| over the launched comps,
// and keeps the candidate that predicts best. heldOut() then reports the honest numbers —
// leave-one-out and two walk-forward splits — beside the house starter's numbers on the same splits,
// so the dashboard can show exactly how much the fit beats the baseline, and by which metric.
//
// Comps are the snapshot protocols that record a token with a positive market cap: 128 of them.
// A comp's market cap is what the market actually paid, so it is the only ground truth the model
// has; the winsorized median keeps one 400x outlier from dragging a whole category with it.

/** One protocol record, exactly the ten fields the sealed snapshot carries. */
export interface SnapProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapProtocol[];
  watchlist: string[];
}

/** The four fitted weights of the value model. */
export interface ModelWeights {
  /** Size exponent on (TVL / $100M): negative, so big protocols get a smaller multiple. */
  size_gamma: number;
  /** Weight on the clamped 7-day growth, in percent. */
  growth_weight: number;
  /** Maturity floor: the multiplier for a protocol listed yesterday. */
  maturity_floor: number;
  /** Maturity range added over 1,095 days of age. */
  maturity_range: number;
}

/** The fitted model: its weights, its per-category multiples, and its held-out report card. */
export interface FittedModel {
  version: string;
  weights: ModelWeights;
  /** Winsorized median mcap/TVL per category, on growth/maturity/size-adjusted ratios. */
  multiples: Record<string, number>;
  /** The fallback multiple for thin categories (overall winsorized median). */
  overall_multiple: number;
  /** How many comps each category's multiple rests on. */
  multiple_counts: Record<string, number>;
  /** Leave-one-out median |log error| of the chosen weights (the grid-search score). */
  loo_median_log_error: number;
  /** Conformal interval from the leave-one-out log residuals: [q10, q90]. */
  loo_log_interval: [number, number];
  /** Number of launched comps the fit rests on. */
  comp_count: number;
}

/** One held-out split's numbers, for the fitted model and the house starter side by side. */
export interface SplitResult {
  name: string;
  train_count: number;
  test_count: number;
  fitted_median_log_error: number;
  fitted_mean_log_error: number;
  fitted_rel_mse: number;
  starter_median_log_error: number;
  starter_mean_log_error: number;
  starter_rel_mse: number;
  /** Fitted median error divided by starter median error: below 1, the fit wins. */
  median_error_ratio: number;
  /** Starter relative MSE divided by fitted relative MSE: above 1, the fit wins. */
  rel_mse_improvement: number;
}

/** The whole held-out report: leave-one-out plus the walk-forward splits. */
export interface HeldOutReport {
  loo: SplitResult;
  walk_forward: SplitResult[];
}

export const MODEL_VERSION = 'radar-2';
export const EARLY_ROWS = 158;
export const LIVE_ROWS = 24;
export const UNKNOWN_AGE_DAYS = 365;
export const MATURITY_DAYS = 1095;
export const SIZE_REFERENCE_USD = 100_000_000;
export const MIN_CATEGORY_COMPS = 5;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a list; NaN when empty. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  return n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

/** Winsorize at the 5th/95th percentiles, then take the median: one 400x outlier cannot move it. */
export function winsorizedMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n < 3) return median(sorted);
  const lo = sorted[Math.floor(0.05 * (n - 1))]!;
  const hi = sorted[Math.ceil(0.95 * (n - 1))]!;
  return median(sorted.map((v) => Math.min(hi, Math.max(lo, v))));
}

/** A protocol's 7-day TVL change in percent, clamped to [-60, 120]; null reads as flat. */
export function clampedGrowth(p: SnapProtocol): number {
  return Math.min(120, Math.max(-60, finiteNumber(p.change_7d, 0)));
}

/** The growth multiplier under `w`: 1 + growth% / 100 x w. */
export function growthMultiplier(p: SnapProtocol, w: ModelWeights): number {
  return 1 + (clampedGrowth(p) / 100) * w.growth_weight;
}

/** The maturity multiplier under `w`: floor + min(age, 1095)/1095 x range; unknown age reads 365. */
export function maturityMultiplier(p: SnapProtocol, asOf: string, w: ModelWeights): number {
  const age = ageDays(asOf, p.listed_at) ?? UNKNOWN_AGE_DAYS;
  return w.maturity_floor + (Math.min(Math.max(age, 0), MATURITY_DAYS) / MATURITY_DAYS) * w.maturity_range;
}

/** The size multiplier under `w`: (TVL / $100M) ^ gamma. */
export function sizeMultiplier(p: SnapProtocol, w: ModelWeights): number {
  return Math.pow(Math.max(p.tvl_usd, 1) / SIZE_REFERENCE_USD, w.size_gamma);
}

/** The launched comps: protocols that record a token with a positive market cap and TVL. */
export function launchedComps(snapshot: Snapshot): SnapProtocol[] {
  return snapshot.protocols.filter((p) => (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0);
}

/**
 * Per-category multiples from a training set of comps, under `w`: each comp's mcap/TVL is divided
 * by its growth, maturity and size multipliers first, so the multiple is the part of the ratio the
 * category itself explains. Categories with fewer than 5 comps fall back to the overall multiple.
 */
export function fitMultiples(
  train: SnapProtocol[],
  asOf: string,
  w: ModelWeights,
): { multiples: Record<string, number>; overall: number; counts: Record<string, number> } {
  const adjusted = train.map((p) => ({
    category: p.category ?? 'Uncategorized',
    ratio: p.mcap_usd! / p.tvl_usd / (growthMultiplier(p, w) * maturityMultiplier(p, asOf, w) * sizeMultiplier(p, w)),
  }));
  const overall = winsorizedMedian(adjusted.map((a) => a.ratio));
  const byCategory = new Map<string, number[]>();
  for (const a of adjusted) {
    const list = byCategory.get(a.category);
    if (list === undefined) byCategory.set(a.category, [a.ratio]);
    else list.push(a.ratio);
  }
  const multiples: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const [category, ratios] of byCategory) {
    counts[category] = ratios.length;
    multiples[category] = ratios.length >= MIN_CATEGORY_COMPS ? winsorizedMedian(ratios) : overall;
  }
  return { multiples, overall, counts };
}

/** One protocol's implied value under fitted multiples and weights, with every term exposed. */
export function impliedValue(
  p: SnapProtocol,
  asOf: string,
  w: ModelWeights,
  multiples: Record<string, number>,
  overall: number,
): {
  implied: number;
  multiple: number;
  size_mult: number;
  growth_mult: number;
  maturity_mult: number;
  age: number | null;
} {
  const multiple = multiples[p.category ?? 'Uncategorized'] ?? overall;
  const sizeMult = sizeMultiplier(p, w);
  const growthMult = growthMultiplier(p, w);
  const maturityMult = maturityMultiplier(p, asOf, w);
  const age = ageDays(asOf, p.listed_at);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * sizeMult * growthMult * maturityMult));
  return { implied, multiple, size_mult: sizeMult, growth_mult: growthMult, maturity_mult: maturityMult, age };
}

/** The house starter's implied value, for the held-out baseline: TVL x 0.25 x growth(0.5) x maturity(0.6+0.4). */
export function starterImplied(p: SnapProtocol, asOf: string): number {
  const growth = 1 + (clampedGrowth(p) / 100) * 0.5;
  const age = ageDays(asOf, p.listed_at) ?? UNKNOWN_AGE_DAYS;
  const maturity = 0.6 + (Math.min(Math.max(age, 0), MATURITY_DAYS) / MATURITY_DAYS) * 0.4;
  return Math.max(1, Math.round(p.tvl_usd * 0.25 * growth * maturity));
}

interface ErrorStats {
  median: number;
  mean: number;
  relMse: number;
}

function errorStats(predicted: number[], actual: number[]): ErrorStats {
  const logErrors = predicted.map((pred, i) => Math.log(pred / actual[i]!));
  const abs = logErrors.map(Math.abs);
  const relMse =
    predicted.reduce((sum, pred, i) => sum + ((pred - actual[i]!) / actual[i]!) ** 2, 0) / predicted.length;
  return { median: median(abs), mean: abs.reduce((a, b) => a + b, 0) / abs.length, relMse };
}

/** Leave-one-out median |log error| of one weight candidate: multiples refit per fold. */
function looMedianError(comps: SnapProtocol[], asOf: string, w: ModelWeights): number {
  const errors: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const { multiples, overall } = fitMultiples(train, asOf, w);
    const pred = impliedValue(comps[i]!, asOf, w, multiples, overall).implied;
    errors.push(Math.abs(Math.log(pred / comps[i]!.mcap_usd!)));
  }
  return median(errors);
}

const WEIGHT_GRID: ModelWeights[] = [];
for (const sizeGamma of [-0.6, -0.5, -0.4, -0.3, -0.2, -0.1, 0]) {
  for (const growthWeight of [0, 0.5, 1, 1.5]) {
    for (const maturityFloor of [0.5, 0.6, 0.7]) {
      for (const maturityRange of [0.3, 0.4, 0.5]) {
        WEIGHT_GRID.push({ size_gamma: sizeGamma, growth_weight: growthWeight, maturity_floor: maturityFloor, maturity_range: maturityRange });
      }
    }
  }
}

/**
 * Fit the model from the snapshot's launched comps: grid-search the four weights by leave-one-out
 * median |log error|, then fit the per-category multiples on all comps under the winning weights.
 * The grid is fixed and ties keep the first candidate, so the fit is deterministic.
 */
export function fitModel(snapshot: Snapshot): FittedModel {
  const comps = launchedComps(snapshot);
  let best: ModelWeights = WEIGHT_GRID[0]!;
  let bestError = Number.POSITIVE_INFINITY;
  for (const w of WEIGHT_GRID) {
    const err = looMedianError(comps, snapshot.as_of, w);
    if (err < bestError) {
      bestError = err;
      best = w;
    }
  }
  const { multiples, overall, counts } = fitMultiples(comps, snapshot.as_of, best);
  // Conformal interval: the 10th/90th percentiles of the leave-one-out log residuals.
  const residuals: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const fold = fitMultiples(train, snapshot.as_of, best);
    const pred = impliedValue(comps[i]!, snapshot.as_of, best, fold.multiples, fold.overall).implied;
    residuals.push(Math.log(pred / comps[i]!.mcap_usd!));
  }
  residuals.sort((a, b) => a - b);
  const q10 = residuals[Math.floor(0.1 * (residuals.length - 1))]!;
  const q90 = residuals[Math.ceil(0.9 * (residuals.length - 1))]!;
  return {
    version: MODEL_VERSION,
    weights: best,
    multiples,
    overall_multiple: overall,
    multiple_counts: counts,
    loo_median_log_error: bestError,
    loo_log_interval: [q10, q90],
    comp_count: comps.length,
  };
}

/**
 * The honest report card: leave-one-out over all comps (weights fixed, multiples refit per fold)
 * and walk-forward splits (fit on protocols listed before the cutoff, test on later-listed ones),
 * each beside the house starter on the same split. Protocols with no listed_at date cannot be
 * placed in time, so the walk-forward splits use only the comps that carry one.
 */
export function heldOutReport(snapshot: Snapshot, model: FittedModel): HeldOutReport {
  const comps = launchedComps(snapshot);
  const asOf = snapshot.as_of;
  const w = model.weights;

  const split = (name: string, train: SnapProtocol[], test: SnapProtocol[]): SplitResult => {
    const { multiples, overall } = fitMultiples(train, asOf, w);
    const fittedPred = test.map((p) => impliedValue(p, asOf, w, multiples, overall).implied);
    const starterPred = test.map((p) => starterImplied(p, asOf));
    const actual = test.map((p) => p.mcap_usd!);
    const f = errorStats(fittedPred, actual);
    const s = errorStats(starterPred, actual);
    return {
      name,
      train_count: train.length,
      test_count: test.length,
      fitted_median_log_error: f.median,
      fitted_mean_log_error: f.mean,
      fitted_rel_mse: f.relMse,
      starter_median_log_error: s.median,
      starter_mean_log_error: s.mean,
      starter_rel_mse: s.relMse,
      median_error_ratio: f.median / s.median,
      rel_mse_improvement: s.relMse / f.relMse,
    };
  };

  // Leave-one-out: every comp takes a turn as the test set of one.
  const looPred: number[] = [];
  const looStarter: number[] = [];
  const looActual: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const { multiples, overall } = fitMultiples(train, asOf, w);
    looPred.push(impliedValue(comps[i]!, asOf, w, multiples, overall).implied);
    looStarter.push(starterImplied(comps[i]!, asOf));
    looActual.push(comps[i]!.mcap_usd!);
  }
  const fLoo = errorStats(looPred, looActual);
  const sLoo = errorStats(looStarter, looActual);
  const loo: SplitResult = {
    name: 'leave-one-out',
    train_count: comps.length - 1,
    test_count: comps.length,
    fitted_median_log_error: fLoo.median,
    fitted_mean_log_error: fLoo.mean,
    fitted_rel_mse: fLoo.relMse,
    starter_median_log_error: sLoo.median,
    starter_mean_log_error: sLoo.mean,
    starter_rel_mse: sLoo.relMse,
    median_error_ratio: fLoo.median / sLoo.median,
    rel_mse_improvement: sLoo.relMse / fLoo.relMse,
  };

  const dated = comps.filter((p) => p.listed_at !== null);
  const walkForward = ['2024-11-14', '2025-01-01', '2025-06-01'].map((cutoff) =>
    split(
      `walk-forward (listed before ${cutoff})`,
      dated.filter((p) => p.listed_at! < cutoff),
      dated.filter((p) => p.listed_at! >= cutoff),
    ),
  );
  return { loo, walk_forward: walkForward };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

// ---------------------------------------------------------------- farm plans

/** One farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** The farm economics of one row: what it costs, how long it takes, what it might pay. */
export interface FarmEconomics {
  /** Capital the position needs, in whole dollars. */
  capital_usd: number;
  /** Gas and fees across the whole plan, in whole dollars. */
  gas_usd: number;
  /** Total time the plan asks for, in hours. */
  hours: number;
  /** Expected airdrop value for one qualifying wallet, in whole dollars. */
  expected_usd: number;
  /** (expected - costs) / hours: the plan's $/hour verdict, two decimals. */
  usd_per_hour: number;
}

/**
 * What a farm position costs on a chain: gas per transaction in whole dollars. Ethereum mainnet
 * is an order of magnitude dearer than the L2s; unknown chains read as a mid-price L2.
 */
export function gasPerTx(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 12;
  if (c === 'bitcoin' || c === 'solana') return 2;
  if (c.includes('arbitrum') || c.includes('optimism') || c.includes('base') || c.includes('blast') || c.includes('linea') || c.includes('scroll') || c.includes('zksync') || c.includes('polygon')) return 1;
  return 3;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * The farm economics of one protocol. Assumptions, stated in the dashboard too: 5% of the
 * protocol's implied value goes to an airdrop pool shared by about 25,000 qualifying wallets, so
 * one wallet's expected share is implied x 0.05 / 25000. Gas is 8 transactions at the chain's
 * per-transaction price; time is setup plus a weekly check-in across the hold window.
 */
export function farmEconomics(p: SnapProtocol, age: number | null, implied: number): FarmEconomics {
  const capital = capitalFor(p);
  const gas = 8 * gasPerTx(chainOf(p));
  const hold = holdDaysFor(age);
  const weeks = Math.max(1, Math.round(hold / 7));
  const hours = Math.round((0.5 + weeks * 0.25 + 0.25) * 100) / 100;
  const expected = Math.max(0, Math.round(implied * 0.05 * (1 / 25000)));
  const usdPerHour = Math.round(((expected - (capital * 0 + gas)) / hours) * 100) / 100;
  return { capital_usd: capital, gas_usd: gas, hours, expected_usd: expected, usd_per_hour: usdPerHour };
}

/** The category's one action, in words a farmer can follow. */
function actionFor(p: SnapProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${capital} of USDC on ${name} (${chain}) and leave the loan open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Add $${capital} of liquidity to ${name}'s main pool on ${chain} and leave it in.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} (${chain}) and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${name} and take one position in an open market.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and hold the vault shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy live.`;
  if (c.includes('launchpad') || c.includes('locker')) return `Lock $${capital} of USDC in ${name} on ${chain} for the full lock window.`;
  if (c.includes('payment')) return `Route $${capital} of payments through ${name} on ${chain} and keep the receipts.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names. Step strings stay inside the gate's 20..600 characters.
 */
export function farmSteps(p: SnapProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasPerTx(chain);
  const action = actionFor(p, capital, chain);
  return [
    { text: `Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper.`, cost: `about $${gas} of gas for the first transaction`, time: '5 minutes' },
    { text: action, cost: `$${capital} of capital and about $${gas * 2} of gas`, time: '15 minutes to set up' },
    { text: `Do one qualifying action each week — a deposit, a borrow, a swap or a vote — so the wallet shows steady use.`, cost: `about $${gas} of gas a week`, time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    { text: `Write the wallet, the dates and every transaction in a farm log, so you can repeat the position or unwind it.`, cost: 'nothing but the log', time: '5 minutes' },
  ];
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

// ---------------------------------------------------------------- board

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  /** True when this row is one of the snapshot's 40 watchlist protocols. */
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  interval_low_usd: number;
  interval_high_usd: number;
  model: {
    multiple: number;
    size_multiplier: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
  farm: FarmEconomics;
  /** Plain-text description baked in at build time (DefiLlama), or null when none was found. */
  description: string | null;
  /** Plain-text social handle baked in at build time, or null when none was found. */
  social: string | null;
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** The dashboard's compact view of one row, with the farm plan and economics included. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  interval_low_usd: number;
  interval_high_usd: number;
  multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  size_multiplier: number;
  farm_steps: string[];
  farm: FarmEconomics;
  description: string | null;
  social: string | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: FittedModel;
  held_out: HeldOutReport;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Build-time enrichment for one protocol: plain text only, never a URL. */
export interface Enrichment {
  description?: string;
  social?: string;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(
  snapshot: Snapshot,
  model: FittedModel,
  enrichment: Record<string, Enrichment> = {},
): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapProtocol>();
  // The watchlist is the floor: every slug on it, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. Never a
  // replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const [q10, q90] = model.loo_log_interval;
  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, model.weights, model.multiples, model.overall_multiple);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => {
    const econ = farmEconomics(s.p, s.age, s.implied);
    const enr = enrichment[s.p.slug] ?? {};
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      watchlist: snapshot.watchlist.includes(s.p.slug),
      age_days: s.age,
      implied_value_usd: s.implied,
      interval_low_usd: Math.max(1, Math.round(s.implied * Math.exp(q10))),
      interval_high_usd: Math.max(1, Math.round(s.implied * Math.exp(q90))),
      model: {
        multiple: Math.round(s.multiple * 10000) / 10000,
        size_multiplier: Math.round(s.size_mult * 10000) / 10000,
        growth_pct: clampedGrowth(s.p),
        growth_multiplier: Math.round(s.growth_mult * 10000) / 10000,
        maturity_multiplier: Math.round(s.maturity_mult * 10000) / 10000,
        age_days: s.age,
      },
      farm_steps: farmSteps(s.p, s.age).map(stepText),
      farm: econ,
      description: enr.description ?? null,
      social: enr.social ?? null,
    };
  });
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    watchlist: row.watchlist,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    interval_low_usd: row.interval_low_usd,
    interval_high_usd: row.interval_high_usd,
    multiple: row.model.multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    size_multiplier: row.model.size_multiplier,
    farm_steps: row.farm_steps,
    farm: row.farm,
    description: row.description,
    social: row.social,
  };
}

/** Everything the dashboard renders, from the snapshot and the fitted model. */
export function buildRadar(
  snapshot: Snapshot,
  model: FittedModel,
  heldOut: HeldOutReport,
  enrichment: Record<string, Enrichment> = {},
): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model, enrichment);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    held_out: heldOut,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
