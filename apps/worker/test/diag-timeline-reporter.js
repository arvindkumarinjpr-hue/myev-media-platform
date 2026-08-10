/* DIAG ONLY — temporary custom Jest reporter for the Module 1F Phase A CI
 * forensics investigation. Prints FILE_START/FILE_END and, for every
 * individual test case, TEST_START/TEST_END lines with elapsedMs, so the
 * real CI log can be correlated against the manager/connection DIAG lines
 * printed by apps/worker/src/testing/diag-timing.ts. Will be fully deleted
 * (and the jest-e2e.config.js `reporters` entry reverted) before any real
 * PR is opened or merged.
 */

class DiagTimelineReporter {
  onTestFileStart(test) {
    console.log(JSON.stringify({ diag: true, event: "FILE_START", file: test.path, time: Date.now() }));
  }

  onTestFileResult(test, testResult) {
    const durationMs = testResult.perfStats ? testResult.perfStats.end - testResult.perfStats.start : null;
    console.log(JSON.stringify({ diag: true, event: "FILE_END", file: test.path, time: Date.now(), durationMs }));
    for (const result of testResult.testResults) {
      console.log(
        JSON.stringify({
          diag: true,
          event: "TEST_RESULT",
          file: test.path,
          title: result.fullName,
          status: result.status,
          durationMs: result.duration,
        }),
      );
    }
  }
}

module.exports = DiagTimelineReporter;
