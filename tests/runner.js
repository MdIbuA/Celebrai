/**
 * Minimal zero-dependency test runner.
 * Usage: node tests/run-all.js
 */

const state = { suites: [], current: null, passed: 0, failed: 0, failures: [] };

export function describe(name, fn) {
  const suite = { name, tests: [] };
  state.suites.push(suite);
  state.current = suite;
  fn();
  state.current = null;
}

export function it(name, fn) {
  if (!state.current) throw new Error('it() must be called inside describe()');
  state.current.tests.push({ name, fn });
}

export class AssertionError extends Error {}

export const assert = {
  ok(value, message = 'Expected value to be truthy') {
    if (!value) throw new AssertionError(`${message} (got ${format(value)})`);
  },
  equal(actual, expected, message = 'Values are not strictly equal') {
    if (actual !== expected) {
      throw new AssertionError(`${message}\n    expected: ${format(expected)}\n    actual:   ${format(actual)}`);
    }
  },
  notEqual(actual, expected, message = 'Values should differ') {
    if (actual === expected) throw new AssertionError(`${message} (both ${format(actual)})`);
  },
  deepEqual(actual, expected, message = 'Objects are not deeply equal') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new AssertionError(`${message}\n    expected: ${b}\n    actual:   ${a}`);
  },
  throws(fn, message = 'Expected function to throw') {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) throw new AssertionError(message);
  },
  async rejects(promise, message = 'Expected promise to reject') {
    let threw = false;
    try { await promise; } catch { threw = true; }
    if (!threw) throw new AssertionError(message);
  },
};

function format(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'object' && v !== null) {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

export async function run() {
  const started = Date.now();
  for (const suite of state.suites) {
    console.log(`\n\x1b[1m${suite.name}\x1b[0m`);
    for (const test of suite.tests) {
      try {
        await test.fn();
        state.passed += 1;
        console.log(`  \x1b[32m✓\x1b[0m ${test.name}`);
      } catch (err) {
        state.failed += 1;
        state.failures.push({ suite: suite.name, test: test.name, err });
        console.log(`  \x1b[31m✗\x1b[0m ${test.name}`);
        console.log(`    \x1b[31m${err.message}\x1b[0m`);
        if (!(err instanceof AssertionError)) {
          console.log(`    ${String(err.stack).split('\n').slice(1, 4).join('\n    ')}`);
        }
      }
    }
  }
  const ms = Date.now() - started;
  console.log(`\n${'-'.repeat(52)}`);
  console.log(`  ${state.passed} passed, ${state.failed} failed  (${ms}ms)`);
  console.log(`${'-'.repeat(52)}\n`);
  if (state.failed > 0) process.exitCode = 1;
  return { passed: state.passed, failed: state.failed };
}
