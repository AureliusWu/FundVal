import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAppChunkBudgets, assertAppBundleBudget } from '../scripts/release-fingerprint.mjs';

const measurement = (cold = 46_149, all = 85_969) => ({
  actualColdStartGzipBytes: cold, actualAllNonOcrGzipBytes: all,
});

test('approved total budget reports policy provenance without rebasing v15 history', () => {
  const report = analyzeAppChunkBudgets(measurement());
  assert.equal(report.budgetPolicy, 'v16-total-90kib-approved-20261023');
  assert.equal(report.previousAllBudgetBytes, 77_227.7);
  assert.equal(report.baselineCommit, '40e68edab9cb3fba0b17338dc3672a82d13ad17e');
  assert.equal(report.baselineAllNonOcrGzipBytes, 70_207);
  assert.equal(report.allBudgetNumerator, 921_600);
  assert.equal(report.allBudgetDenominator, 10);
  assert.equal(report.allBudgetBytes, 92_160);
  assert.equal(report.coldBudgetBytes, 52_241);
  assert.equal(report.pass, true);
  assert.ok(Object.isFrozen(report));
});

test('existing unchanged product is admitted only under the explicitly approved total ceiling', () => {
  const report = assertAppBundleBudget(measurement());
  assert.equal(report.actualAllNonOcrGzipBytes, 85_969);
  assert.equal(report.actualColdStartGzipBytes, 46_149);
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.importClosureVerified, false);
});

test('90 KiB is inclusive and one more actual gzip byte is rejected', () => {
  assert.equal(assertAppBundleBudget(measurement(52_241, 92_160)).pass, true);
  assert.throws(() => assertAppBundleBudget(measurement(52_241, 92_161)), /all non-OCR.*92160/);
});

test('cold ceiling is unchanged even when total fits the new policy', () => {
  const report = analyzeAppChunkBudgets(measurement(52_242, 85_969));
  assert.equal(report.allPass, true);
  assert.equal(report.coldPass, false);
  assert.equal(report.pass, false);
  assert.throws(() => assertAppBundleBudget(measurement(52_242, 85_969)), /cold.*52241/);
});

test('both ceilings still fail independently when both are exceeded', () => {
  const report = analyzeAppChunkBudgets(measurement(52_242, 92_161));
  assert.equal(report.allPass, false);
  assert.equal(report.coldPass, false);
  assert.equal(report.verdict, 'FAIL');
});

test('artifact metadata cannot supply or override approved admission policy', () => {
  const report = analyzeAppChunkBudgets({ ...measurement(52_241, 92_161),
    allBudgetBytes: 999_999, allBudgetNumerator: 999_999, allBudgetDenominator: 1,
    coldBudgetBytes: 999_999, budgetPolicy: 'forged', previousAllBudgetBytes: 0,
  });
  assert.equal(report.allBudgetBytes, 92_160);
  assert.equal(report.coldBudgetBytes, 52_241);
  assert.equal(report.budgetPolicy, 'v16-total-90kib-approved-20261023');
  assert.equal(report.previousAllBudgetBytes, 77_227.7);
  assert.equal(report.pass, false);
});

test('former total boundary is not silently reused after explicit approval', () => {
  assert.equal(assertAppBundleBudget(measurement(52_241, 77_228)).pass, true);
  assert.equal(analyzeAppChunkBudgets(measurement(52_241, 92_161)).allPass, false);
});
