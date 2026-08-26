import { describe, expect, test } from "bun:test";
import { analyzeCsv } from "./calculate-improvements.ts";

const HEADER = "submission_id,benchmark_id,benchmark_name,direction,baseline_score,solver_account_id,solver_username,official_score,promotion_finished_at";

describe("cumulative metric improvement", () => {
  test("attributes only positive frontier advances and ranks by their cumulative sum", () => {
    const csv = [
      HEADER,
      "s1,b1,bench,+,10,a,alice,12,2026-08-01T01:00:00Z",
      "s2,b1,bench,+,10,b,bob,11,2026-08-01T02:00:00Z",
      "s3,b1,bench,+,10,b,bob,13,2026-08-01T03:00:00Z",
      "s4,b1,bench,+,10,b,bob,15,2026-08-02T03:00:00Z",
      "",
    ].join("\n");
    const result = analyzeCsv(csv, {
      topCount: 1,
      randomCount: 1,
      seed: "test-seed",
      includeTopInRandom: false,
    });

    expect(result.solverImprovements.map((row) => [row.solverUsername, row.totalImprovement, row.improvementSharePercent])).toEqual([
      ["bob", "3", "60.00%"],
      ["alice", "2", "40.00%"],
    ]);
    expect(result.metadata.totalFrontierImprovement).toBe("5");
    expect(result.topWinners.map((winner) => winner.solverUsername)).toEqual(["bob"]);
    expect(result.randomWinners.map((winner) => winner.solverUsername)).toEqual(["alice"]);
    expect(result.topWinners[0]!.prize).toEqual({ token: "LIT", amount: 8_600 });
    expect(result.randomWinners[0]!.prize).toEqual({ token: "LIT", amount: 800 });
  });

  test("supports lower-is-better scores and decimal-exact ties", () => {
    const csv = [
      HEADER,
      "s1,b1,bench,-,10,a,alice,9.9,2026-08-01T01:00:00Z",
      "s2,b1,bench,-,10,b,bob,9.8,2026-08-01T02:00:00Z",
      "",
    ].join("\n");
    const result = analyzeCsv(csv, {
      topCount: 2,
      randomCount: 0,
      seed: "test-seed",
      includeTopInRandom: false,
    });

    expect(result.solverImprovements.map((row) => [row.solverUsername, row.totalImprovement])).toEqual([
      ["alice", "0.1"],
      ["bob", "0.1"],
    ]);
  });

  test("excluded usernames advance the frontier but remain ineligible", () => {
    const csv = [
      HEADER,
      "s1,b1,bench,+,10,a,InternalUser,12,2026-08-01T01:00:00Z",
      "s2,b1,bench,+,10,b,bob,13,2026-08-01T02:00:00Z",
      "",
    ].join("\n");
    const result = analyzeCsv(csv, {
      topCount: 1,
      randomCount: 0,
      seed: "test-seed",
      includeTopInRandom: false,
      excludedGithubLogins: ["internaluser"],
    });

    expect(result.solverImprovements.map((row) => [row.solverUsername, row.totalImprovement])).toEqual([["bob", "1"]]);
    expect(result.metadata.totalFrontierImprovement).toBe("3");
    expect(result.metadata.eligibleImprovement).toBe("1");
    expect(result.metadata.excludedFrontierImprovement).toBe("2");
  });

  test("produces a reproducible improvement-weighted draw without replacement", () => {
    const csv = [
      HEADER,
      "s1,b1,bench,+,0,a,alice,1,2026-08-01T01:00:00Z",
      "s2,b1,bench,+,0,b,bob,3,2026-08-01T02:00:00Z",
      "s3,b1,bench,+,0,c,carol,6,2026-08-01T03:00:00Z",
      "",
    ].join("\n");
    const options = { topCount: 0, randomCount: 3, seed: "same-seed", includeTopInRandom: false };
    const first = analyzeCsv(csv, options);
    const second = analyzeCsv(csv, options);

    expect(first.randomWinners).toEqual(second.randomWinners);
    expect(new Set(first.randomWinners.map((winner) => winner.solverAccountId)).size).toBe(3);
    expect(first.randomWinners.map((winner) => winner.prize.amount)).toEqual([800, 800, 800]);
  });

  test("assigns the fixed LIT schedule to six ranked and three random winners", () => {
    const csv = [
      HEADER,
      ...Array.from({ length: 9 }, (_, index) =>
        `s${index + 1},b1,bench,+,0,solver-${index + 1},solver${index + 1},${index + 1},2026-08-01T${String(index).padStart(2, "0")}:00:00Z`
      ),
      "",
    ].join("\n");
    const result = analyzeCsv(csv, {
      topCount: 6,
      randomCount: 3,
      seed: "prize-test-seed",
      includeTopInRandom: false,
    });

    expect(result.topWinners.map((winner) => winner.prize.amount)).toEqual([8_600, 5_500, 3_600, 2_400, 1_550, 950]);
    expect(result.randomWinners.map((winner) => winner.prize.amount)).toEqual([800, 800, 800]);
    expect(new Set([...result.topWinners, ...result.randomWinners].map((winner) => winner.solverAccountId)).size).toBe(9);
    expect([...result.topWinners, ...result.randomWinners].reduce((sum, winner) => sum + winner.prize.amount, 0)).toBe(25_000);
  });
});
