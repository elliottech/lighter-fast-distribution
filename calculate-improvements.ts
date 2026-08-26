#!/usr/bin/env bun

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Direction = "+" | "-";

type Decimal = {
  coefficient: bigint;
  scale: number;
};

type CsvRecord = Record<string, string>;

type Solver = {
  id: string;
  username: string;
};

type Submission = {
  id: string;
  promotedAt: string;
  promotedAtMs: number;
  solver: Solver;
  score: Decimal;
};

type SolverAggregate = {
  solver: Solver;
  improvement: Decimal;
  frontierSteps: number;
  days: Set<string>;
};

export type AnalyzeOptions = {
  topCount: number;
  randomCount: number;
  seed: string;
  includeTopInRandom: boolean;
  excludedGithubLogins?: readonly string[];
};

export type SolverImprovementRow = {
  rank: number;
  solverAccountId: string;
  solverUsername: string;
  totalImprovement: string;
  improvementSharePercent: string;
  frontierSteps: number;
  daysContributed: number;
};

export type Winner = SolverImprovementRow & {
  prize: {
    token: "LIT";
    amount: number;
  };
};

export type RandomWinner = Winner & {
  draw: number;
  eligibleImprovementAtDraw: string;
  probabilityAtDrawPercent: string;
};

export type Analysis = {
  metadata: {
    benchmarkId: string;
    benchmarkName: string;
    direction: Direction;
    baselineScore: string;
    finalFrontierScore: string;
    submissionCount: number;
    solverCount: number;
    frontierStepCount: number;
    eligibleFrontierStepCount: number;
    contributingSolverCount: number;
    totalFrontierImprovement: string;
    eligibleImprovement: string;
    excludedGithubLogins: string[];
    excludedSubmissionSolverCount: number;
    excludedFrontierImprovement: string;
    firstPromotion: string;
    lastPromotion: string;
    seed: string;
    randomPool: "all-contributors" | "non-top-contributors";
  };
  solverImprovements: SolverImprovementRow[];
  topWinners: Winner[];
  randomWinners: RandomWinner[];
};

type CliOptions = AnalyzeOptions & {
  input: string;
  outputDir: string;
  excludedLoginsFile: string;
};

const DEFAULT_INPUT = "lighter-fast-promoted-submissions.csv";
const DEFAULT_OUTPUT_DIR = "results";
const DEFAULT_EXCLUDED_LOGINS_FILE = "excluded-github-logins.txt";
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const POWERS_OF_TEN: bigint[] = [1n];
const TOP_PRIZES_LIT = [8_600, 5_500, 3_600, 2_400, 1_550, 950] as const;
const RANDOM_PRIZES_LIT = [800, 800, 800] as const;

export function parseCsv(text: string): CsvRecord[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      if (field.length !== 0) throw new Error(`unexpected quote at character ${index + 1}`);
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else {
      field += character;
    }
  }

  if (inQuotes) throw new Error("unterminated quoted CSV field");
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  if (rows.length === 0) throw new Error("CSV is empty");

  const headers = rows[0]!.map((header, index) => index === 0 ? header.replace(/^\uFEFF/, "") : header);
  if (new Set(headers).size !== headers.length) throw new Error("CSV contains duplicate headers");

  return rows.slice(1).map((values, rowIndex) => {
    if (values.length !== headers.length) {
      throw new Error(`CSV row ${rowIndex + 2} has ${values.length} fields; expected ${headers.length}`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

export function analyzeCsv(csvText: string, options: AnalyzeOptions): Analysis {
  validateOptions(options);
  const excludedGithubLogins = normalizeExcludedGithubLogins(options.excludedGithubLogins ?? []);
  const excludedGithubLoginSet = new Set(excludedGithubLogins);
  const records = parseCsv(csvText);
  if (records.length === 0) throw new Error("CSV has a header but no submissions");

  const first = records[0]!;
  const benchmarkId = required(first, "benchmark_id", 2);
  const benchmarkName = required(first, "benchmark_name", 2);
  const direction = parseDirection(required(first, "direction", 2), 2);
  const baseline = parseDecimal(required(first, "baseline_score", 2), "baseline_score on row 2");

  const submissions = records.map((record, index) => {
    const csvRow = index + 2;
    requireConsistent(record, "benchmark_id", benchmarkId, csvRow);
    requireConsistent(record, "benchmark_name", benchmarkName, csvRow);
    requireConsistent(record, "direction", direction, csvRow);
    const rowBaseline = parseDecimal(required(record, "baseline_score", csvRow), `baseline_score on row ${csvRow}`);
    if (compareDecimal(rowBaseline, baseline) !== 0) throw new Error(`baseline_score changes on CSV row ${csvRow}`);

    const promotedAt = required(record, "promotion_finished_at", csvRow);
    const promotedAtMs = Date.parse(promotedAt);
    if (!Number.isFinite(promotedAtMs)) throw new Error(`invalid promotion_finished_at on CSV row ${csvRow}: ${promotedAt}`);
    return {
      id: required(record, "submission_id", csvRow),
      promotedAt,
      promotedAtMs,
      solver: {
        id: required(record, "solver_account_id", csvRow),
        username: required(record, "solver_username", csvRow),
      },
      score: parseDecimal(required(record, "official_score", csvRow), `official_score on row ${csvRow}`),
    } satisfies Submission;
  });

  submissions.sort((left, right) => left.promotedAtMs - right.promotedAtMs || left.id.localeCompare(right.id));
  assertUniqueSubmissionIds(submissions);

  let frontier = baseline;
  let frontierStepCount = 0;
  let eligibleFrontierStepCount = 0;
  let totalFrontierImprovement = zeroDecimal();
  let excludedFrontierImprovement = zeroDecimal();
  const solverDirectory = new Map<string, Solver>();
  const excludedSolverIds = new Set<string>();
  const aggregates = new Map<string, SolverAggregate>();

  for (const submission of submissions) {
    const knownSolver = solverDirectory.get(submission.solver.id);
    if (knownSolver !== undefined && knownSolver.username !== submission.solver.username) {
      throw new Error(`solver ${submission.solver.id} has conflicting usernames: ${knownSolver.username} and ${submission.solver.username}`);
    }
    solverDirectory.set(submission.solver.id, submission.solver);

    const improvement = direction === "+"
      ? subtractDecimal(submission.score, frontier)
      : subtractDecimal(frontier, submission.score);
    if (compareDecimal(improvement, zeroDecimal()) <= 0) continue;

    frontier = submission.score;
    frontierStepCount += 1;
    totalFrontierImprovement = addDecimal(totalFrontierImprovement, improvement);
    if (excludedGithubLoginSet.has(submission.solver.username.toLowerCase())) {
      excludedSolverIds.add(submission.solver.id);
      excludedFrontierImprovement = addDecimal(excludedFrontierImprovement, improvement);
      continue;
    }

    eligibleFrontierStepCount += 1;
    const date = new Date(submission.promotedAtMs).toISOString().slice(0, 10);
    const prior = aggregates.get(submission.solver.id);
    if (prior === undefined) {
      aggregates.set(submission.solver.id, {
        solver: submission.solver,
        improvement,
        frontierSteps: 1,
        days: new Set([date]),
      });
    } else {
      prior.improvement = addDecimal(prior.improvement, improvement);
      prior.frontierSteps += 1;
      prior.days.add(date);
    }
  }

  const eligibleImprovement = sumDecimals([...aggregates.values()].map((row) => row.improvement));
  const ranked = [...aggregates.values()].sort(compareSolverAggregates);
  const solverImprovements = ranked.map((row, index) => ({
    rank: index + 1,
    solverAccountId: row.solver.id,
    solverUsername: row.solver.username,
    totalImprovement: formatDecimal(row.improvement),
    improvementSharePercent: formatPercent(decimalToNumber(row.improvement) / decimalToNumber(eligibleImprovement)),
    frontierSteps: row.frontierSteps,
    daysContributed: row.days.size,
  }));
  const topWinners: Winner[] = solverImprovements
    .slice(0, options.topCount)
    .map((row, index) => withPrize(row, TOP_PRIZES_LIT[index]!));
  const topIds = new Set(topWinners.map((winner) => winner.solverAccountId));
  const randomPool = solverImprovements.filter((row) => options.includeTopInRandom || !topIds.has(row.solverAccountId));
  const randomWinners = selectWeightedWithoutReplacement(randomPool, options.randomCount, options.seed);

  if (compareDecimal(addDecimal(eligibleImprovement, excludedFrontierImprovement), totalFrontierImprovement) !== 0) {
    throw new Error("eligible and excluded improvements do not reconcile to the frontier total");
  }

  return {
    metadata: {
      benchmarkId,
      benchmarkName,
      direction,
      baselineScore: formatDecimal(baseline),
      finalFrontierScore: formatDecimal(frontier),
      submissionCount: submissions.length,
      solverCount: solverDirectory.size,
      frontierStepCount,
      eligibleFrontierStepCount,
      contributingSolverCount: solverImprovements.length,
      totalFrontierImprovement: formatDecimal(totalFrontierImprovement),
      eligibleImprovement: formatDecimal(eligibleImprovement),
      excludedGithubLogins,
      excludedSubmissionSolverCount: excludedSolverIds.size,
      excludedFrontierImprovement: formatDecimal(excludedFrontierImprovement),
      firstPromotion: submissions[0]!.promotedAt,
      lastPromotion: submissions.at(-1)!.promotedAt,
      seed: options.seed,
      randomPool: options.includeTopInRandom ? "all-contributors" : "non-top-contributors",
    },
    solverImprovements,
    topWinners,
    randomWinners,
  };
}

function selectWeightedWithoutReplacement(
  candidates: SolverImprovementRow[],
  requestedCount: number,
  seed: string,
): RandomWinner[] {
  const random = seededRandom(seed);
  const pool = candidates
    .map((row) => {
      const improvement = parseDecimal(row.totalImprovement, `improvement for ${row.solverUsername}`);
      const weight = decimalToNumber(improvement);
      if (!Number.isFinite(weight) || weight <= 0) throw new Error(`invalid improvement weight for ${row.solverUsername}`);
      return { row, improvement, weight };
    })
    .sort((left, right) => left.row.solverAccountId.localeCompare(right.row.solverAccountId));
  const winners: RandomWinner[] = [];
  const drawCount = Math.min(requestedCount, pool.length);

  for (let draw = 1; draw <= drawCount; draw += 1) {
    const totalWeight = pool.reduce((sum, candidate) => sum + candidate.weight, 0);
    if (!Number.isFinite(totalWeight) || totalWeight <= 0) break;
    const target = random() * totalWeight;
    let cumulative = 0;
    let selectedIndex = pool.findIndex((candidate) => {
      cumulative += candidate.weight;
      return target < cumulative;
    });
    // Floating-point addition can differ by one last-place bit at the upper
    // boundary. The random target is below the total, so the final row owns it.
    if (selectedIndex < 0) selectedIndex = pool.length - 1;
    const [selected] = pool.splice(selectedIndex, 1);
    if (selected === undefined) throw new Error("weighted draw selected an invalid pool index");
    winners.push({
      ...withPrize(selected.row, RANDOM_PRIZES_LIT[draw - 1]!),
      draw,
      eligibleImprovementAtDraw: formatDecimal(sumDecimals([
        selected.improvement,
        ...pool.map((candidate) => candidate.improvement),
      ])),
      probabilityAtDrawPercent: formatPercent(selected.weight / totalWeight),
    });
  }
  return winners;
}

function seededRandom(seed: string): () => number {
  let counter = 0n;
  return () => {
    const digest = createHash("sha256").update(seed).update(":").update(String(counter)).digest();
    counter += 1n;
    // Use the first 53 bits, matching JavaScript's exact integer precision.
    const sample = Number(digest.readBigUInt64BE(0) >> 11n);
    return sample / 2 ** 53;
  };
}

function parseDecimal(value: string, label: string): Decimal {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value.trim());
  if (match === null) throw new Error(`${label} is not a finite decimal: ${value}`);
  const sign = match[1] === "-" ? -1n : 1n;
  const integerDigits = match[2] ?? "0";
  const fractionalDigits = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) throw new Error(`${label} has an unsupported exponent: ${value}`);
  let coefficient = sign * BigInt(`${integerDigits}${fractionalDigits}`);
  let scale = fractionalDigits.length - exponent;
  if (scale < 0) {
    coefficient *= powerOfTen(-scale);
    scale = 0;
  }
  return normalizeDecimal({ coefficient, scale });
}

function normalizeDecimal(decimal: Decimal): Decimal {
  let { coefficient, scale } = decimal;
  if (coefficient === 0n) return zeroDecimal();
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function zeroDecimal(): Decimal {
  return { coefficient: 0n, scale: 0 };
}

function addDecimal(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return normalizeDecimal({
    coefficient: left.coefficient * powerOfTen(scale - left.scale) + right.coefficient * powerOfTen(scale - right.scale),
    scale,
  });
}

function subtractDecimal(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return normalizeDecimal({
    coefficient: left.coefficient * powerOfTen(scale - left.scale) - right.coefficient * powerOfTen(scale - right.scale),
    scale,
  });
}

function sumDecimals(values: Decimal[]): Decimal {
  return values.reduce(addDecimal, zeroDecimal());
}

function compareDecimal(left: Decimal, right: Decimal): number {
  const difference = subtractDecimal(left, right).coefficient;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function formatDecimal(decimal: Decimal): string {
  const normalized = normalizeDecimal(decimal);
  const sign = normalized.coefficient < 0n ? "-" : "";
  const digits = (normalized.coefficient < 0n ? -normalized.coefficient : normalized.coefficient).toString();
  if (normalized.scale === 0) return `${sign}${digits}`;
  const padded = digits.padStart(normalized.scale + 1, "0");
  return `${sign}${padded.slice(0, -normalized.scale)}.${padded.slice(-normalized.scale)}`;
}

function decimalToNumber(decimal: Decimal): number {
  return Number(formatDecimal(decimal));
}

function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) throw new Error("percentage ratio must be finite and non-negative");
  return `${(ratio * 100).toFixed(2)}%`;
}

function powerOfTen(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 10_000) throw new Error(`invalid decimal scale ${exponent}`);
  while (POWERS_OF_TEN.length <= exponent) POWERS_OF_TEN.push(POWERS_OF_TEN.at(-1)! * 10n);
  return POWERS_OF_TEN[exponent]!;
}

function compareSolverAggregates(left: SolverAggregate, right: SolverAggregate): number {
  const improvementOrder = compareDecimal(right.improvement, left.improvement);
  if (improvementOrder !== 0) return improvementOrder;
  return left.solver.id.localeCompare(right.solver.id);
}

function withPrize(row: SolverImprovementRow, prizeLit: number): Winner {
  return {
    ...row,
    prize: {
      token: "LIT",
      amount: prizeLit,
    },
  };
}

function required(record: CsvRecord, field: string, csvRow: number): string {
  if (!(field in record)) throw new Error(`CSV is missing required column: ${field}`);
  const value = record[field]!.trim();
  if (value.length === 0) throw new Error(`${field} is empty on CSV row ${csvRow}`);
  return value;
}

function requireConsistent(record: CsvRecord, field: string, expected: string, csvRow: number): void {
  const actual = required(record, field, csvRow);
  if (actual !== expected) throw new Error(`${field} changes on CSV row ${csvRow}: expected ${expected}, received ${actual}`);
}

function parseDirection(value: string, csvRow: number): Direction {
  if (value !== "+" && value !== "-") throw new Error(`direction on CSV row ${csvRow} must be + or -`);
  return value;
}

function assertUniqueSubmissionIds(submissions: Submission[]): void {
  const seen = new Set<string>();
  for (const submission of submissions) {
    if (seen.has(submission.id)) throw new Error(`duplicate submission_id: ${submission.id}`);
    seen.add(submission.id);
  }
}

function validateOptions(options: AnalyzeOptions): void {
  for (const [label, value] of [["topCount", options.topCount], ["randomCount", options.randomCount]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  }
  if (options.topCount > TOP_PRIZES_LIT.length) {
    throw new Error(`topCount cannot exceed the ${TOP_PRIZES_LIT.length} configured LIT prizes`);
  }
  if (options.randomCount > RANDOM_PRIZES_LIT.length) {
    throw new Error(`randomCount cannot exceed the ${RANDOM_PRIZES_LIT.length} configured LIT prizes`);
  }
  if (options.seed.length === 0) throw new Error("seed must not be empty");
  normalizeExcludedGithubLogins(options.excludedGithubLogins ?? []);
}

export function parseExcludedGithubLogins(text: string): string[] {
  const values = text
    .split(/\r?\n/)
    .flatMap((line) => line.replace(/#.*/, "").split(/[\s,]+/));
  return normalizeExcludedGithubLogins(values);
}

function normalizeExcludedGithubLogins(logins: Iterable<string>): string[] {
  const normalized = new Set<string>();
  for (const rawLogin of logins) {
    const login = rawLogin.trim();
    if (login.length === 0) continue;
    if (!GITHUB_LOGIN.test(login)) throw new Error(`invalid excluded GitHub login: ${login}`);
    normalized.add(login.toLowerCase());
  }
  return [...normalized].sort();
}

function parseCliOptions(arguments_: string[]): CliOptions {
  const options: CliOptions = {
    input: DEFAULT_INPUT,
    outputDir: DEFAULT_OUTPUT_DIR,
    excludedLoginsFile: DEFAULT_EXCLUDED_LOGINS_FILE,
    topCount: 6,
    randomCount: 3,
    seed: randomBytes(32).toString("hex"),
    includeTopInRandom: false,
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const next = () => {
      const value = arguments_[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      return value;
    };
    if (argument === "--input") options.input = next();
    else if (argument === "--output-dir") options.outputDir = next();
    else if (argument === "--excluded-logins-file") options.excludedLoginsFile = next();
    else if (argument === "--top-count") options.topCount = parseInteger(next(), argument);
    else if (argument === "--random-count") options.randomCount = parseInteger(next(), argument);
    else if (argument === "--seed") options.seed = next();
    else if (argument === "--include-top-in-random") options.includeTopInRandom = true;
    else if (argument === "--help" || argument === "-h") printHelpAndExit();
    else throw new Error(`unknown argument: ${argument}`);
  }
  validateOptions(options);
  return options;
}

function parseInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} is outside the safe integer range`);
  return parsed;
}

function printHelpAndExit(): never {
  console.log(`Usage: bun run calculate-improvements.ts [options]

Options:
  --input <csv>                 Input CSV (default: ${DEFAULT_INPUT})
  --output-dir <directory>      Output directory (default: ${DEFAULT_OUTPUT_DIR})
  --excluded-logins-file <txt>  Case-insensitive exclusions (default: ${DEFAULT_EXCLUDED_LOGINS_FILE})
  --top-count <integer>         Deterministic top winners (default: 6; maximum: 6)
  --random-count <integer>      Improvement-weighted random winners (default: 3; maximum: 3)
  --seed <text>                 Reproduce a draw; generated and recorded when omitted
  --include-top-in-random       Let top winners also enter the weighted draw
  -h, --help                    Show this help`);
  process.exit(0);
}

function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv<T>(rows: T[], columns: Array<{ header: string; value: (row: T) => string | number }>): string {
  const lines = [columns.map((column) => csvEscape(column.header)).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvEscape(column.value(row))).join(","));
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const inputPath = resolve(options.input);
  const outputDir = resolve(options.outputDir);
  const excludedLoginsPath = resolve(options.excludedLoginsFile);
  const [csvText, excludedLoginsText] = await Promise.all([
    readFile(inputPath, "utf8"),
    readFile(excludedLoginsPath, "utf8"),
  ]);
  options.excludedGithubLogins = parseExcludedGithubLogins(excludedLoginsText);
  const analysis = analyzeCsv(csvText, options);
  await mkdir(outputDir, { recursive: true });

  await Promise.all([
    writeFile(resolve(outputDir, "solver-improvements.csv"), toCsv(analysis.solverImprovements, [
      { header: "rank", value: (row) => row.rank },
      { header: "solver_account_id", value: (row) => row.solverAccountId },
      { header: "solver_username", value: (row) => row.solverUsername },
      { header: "total_improvement", value: (row) => row.totalImprovement },
      { header: "improvement_share_percent", value: (row) => row.improvementSharePercent },
      { header: "frontier_steps", value: (row) => row.frontierSteps },
      { header: "days_contributed", value: (row) => row.daysContributed },
    ])),
    writeFile(resolve(outputDir, "winners.json"), `${JSON.stringify({
      metadata: analysis.metadata,
      top: analysis.topWinners,
      random: analysis.randomWinners,
    }, null, 2)}\n`),
  ]);

  console.log(JSON.stringify({
    input: inputPath,
    excludedLoginsFile: excludedLoginsPath,
    outputDir,
    metadata: analysis.metadata,
    top: analysis.topWinners,
    random: analysis.randomWinners,
  }, null, 2));
}

const entrypoint = process.argv[1] === undefined ? "" : pathToFileURL(resolve(process.argv[1])).href;
if (import.meta.url === entrypoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
