/**
 * Entry point: node tests/run-all.js
 * Zero dependencies. Exits non-zero if any test fails.
 */
import './budget.test.js';
import './timeline.test.js';
import './ai-storage.test.js';
import { run } from './runner.js';

await run();
