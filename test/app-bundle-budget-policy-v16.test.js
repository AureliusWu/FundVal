import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAppChunkBudgets, assertAppBundleBudget } from '../scripts/release-fingerprint.mjs';

const measurement = (cold = 46_149, all = 85_969) => ({
  actualColdStartGzipBytes: cold, actualAllNonOcrGzipBytes: all,
});

test('user-unbounded total policy reports provenance without rebasing v15 or 90 KiB history', () => {
  const report = analyzeAppChunkBudgets(measurement());
  assert.equal(report.budgetPolicy, 'v16-total-unbounded-by-user-20261028');
  assert.equal(report.previousAllBudgetBytes, 77_227.7);
  assert.equal(report.previousApprovedAllBudgetBytes, 92_160);
  assert.equal(report.baselineCommit, '40e68edab9cb3fba0b17338dc3672a82d13ad17e');
  assert.equal(report.baselineAllNonOcrGzipBytes, 70_207);
  assert.equal(report.allLimitEnabled, false);
  assert.equal(report.allVerdict, 'NOT_ENFORCED');
  assert.equal(report.allPass, null);
  assert.equal(report.allBudgetNumerator, null);
  assert.equal(report.allBudgetDenominator, null);
  assert.equal(report.allBudgetBytes, null);
  assert.equal(report.coldBudgetBytes, 52_241);
  assert.equal(report.pass, true);
  assert.ok(Object.isFrozen(report));
});

test('existing unchanged product keeps actual measurements under the explicit user-unbounded policy', () => {
  const report = assertAppBundleBudget(measurement());
  assert.equal(report.actualAllNonOcrGzipBytes, 85_969);
  assert.equal(report.actualColdStartGzipBytes, 46_149);
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.allVerdict, 'NOT_ENFORCED');
  assert.equal(report.importClosureVerified, false);
});

test('former 90 KiB boundary is historical and one more actual gzip byte is recorded without a total gate', () => {
  assert.equal(assertAppBundleBudget(measurement(52_241, 92_160)).pass, true);
  const report = assertAppBundleBudget(measurement(52_241, 92_161));
  assert.equal(report.actualAllNonOcrGzipBytes, 92_161);
  assert.equal(report.allVerdict, 'NOT_ENFORCED');
  assert.equal(report.allPass, null);
  assert.equal(report.pass, true);
});

test('cold ceiling is unchanged even when total fits the new policy', () => {
  const report = analyzeAppChunkBudgets(measurement(52_242, 85_969));
  assert.equal(report.allPass, null);
  assert.equal(report.allVerdict, 'NOT_ENFORCED');
  assert.equal(report.coldPass, false);
  assert.equal(report.pass, false);
  assert.throws(() => assertAppBundleBudget(measurement(52_242, 85_969)), /cold.*52241/);
});

test('cold ceiling still fails when actual total also exceeds the former ceiling', () => {
  const report = analyzeAppChunkBudgets(measurement(52_242, 92_161));
  assert.equal(report.allPass, null);
  assert.equal(report.allVerdict, 'NOT_ENFORCED');
  assert.equal(report.coldPass, false);
  assert.equal(report.verdict, 'FAIL');
  assert.throws(() => assertAppBundleBudget(measurement(52_242, 92_161)), /cold.*52241/);
});

test('artifact metadata cannot supply or override approved admission policy', () => {
  const report = analyzeAppChunkBudgets({ ...measurement(52_242, 92_161),
    allBudgetBytes: 999_999, allBudgetNumerator: 999_999, allBudgetDenominator: 1,
    coldBudgetBytes: 999_999, budgetPolicy: 'forged', previousAllBudgetBytes: 0,
    previousApprovedAllBudgetBytes: 0, allLimitEnabled: true, allVerdict: 'PASS', allPass: true,
  });
  assert.equal(report.allBudgetBytes, null);
  assert.equal(report.allBudgetNumerator, null);
  assert.equal(report.allBudgetDenominator, null);
  assert.equal(report.allLimitEnabled, false);
  assert.equal(report.allVerdict, 'NOT_ENFORCED');
  assert.equal(report.allPass, null);
  assert.equal(report.coldBudgetBytes, 52_241);
  assert.equal(report.budgetPolicy, 'v16-total-unbounded-by-user-20261028');
  assert.equal(report.previousAllBudgetBytes, 77_227.7);
  assert.equal(report.previousApprovedAllBudgetBytes, 92_160);
  assert.equal(report.actualColdStartGzipBytes, 52_242);
  assert.equal(report.actualAllNonOcrGzipBytes, 92_161);
  assert.equal(report.pass, false);
});

test('former total boundary is not silently reused after explicit approval', () => {
  assert.equal(assertAppBundleBudget(measurement(52_241, 77_228)).pass, true);
  for (const all of [92_161, 95_223, 200_000, Number.MAX_SAFE_INTEGER]) {
    const report = assertAppBundleBudget(measurement(52_241, all));
    assert.equal(report.actualAllNonOcrGzipBytes, all);
    assert.equal(report.allPass, null);
    assert.equal(report.allVerdict, 'NOT_ENFORCED');
    assert.equal(report.pass, true);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  }
});
