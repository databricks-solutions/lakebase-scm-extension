#!/usr/bin/env bash
# Run all integration test suites (without unit tests).
# Suites: Python devloop (4 scenarios), Java ecommerce (8 scenarios), self-hosted runner.
#
# Usage:
#   ./test/integration/run-all.sh              # all suites in parallel
#   ./test/integration/run-all.sh python       # python only
#   ./test/integration/run-all.sh java         # java ecommerce only
#   ./test/integration/run-all.sh runner       # self-hosted runner only

set -e
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

export TS_NODE_TRANSPILE_ONLY=1

# --no-config skips .mocharc.yml (which includes unit tests via spec glob)
MOCHA="npx mocha --no-config --require test/setup.js --require ts-node/register --timeout 600000"

SUITE="${1:-all}"

run_suite() {
  local name="$1" file="$2" logfile="$3"
  echo "  Starting: $name"
  $MOCHA "$file" > "$logfile" 2>&1 &
  echo $!
}

collect_result() {
  local name="$1" pid="$2" logfile="$3"
  if wait "$pid" 2>/dev/null; then
    RESULT=$(grep -E "passing|failing" "$logfile" 2>/dev/null | tail -1)
    echo "  $name: $RESULT"
    return 0
  else
    RESULT=$(grep -E "passing|failing" "$logfile" 2>/dev/null | tail -1)
    echo "  $name: FAILED — $RESULT"
    tail -20 "$logfile" | grep -E "failing|AssertionError|Error" || true
    return 1
  fi
}

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
FAIL=0

echo "Integration tests ($SUITE):"
echo ""

if [ "$SUITE" = "all" ] || [ "$SUITE" = "python" ]; then
  PID_PY=$(run_suite "Python devloop (4 scenarios)" "test/integration/python-devloop/pythonDevloop.test.ts" "$TMPDIR/python.log")
fi
if [ "$SUITE" = "all" ] || [ "$SUITE" = "java" ]; then
  PID_JAVA=$(run_suite "Java ecommerce (8 scenarios)" "test/integration/ecommerce/ecommerceScenarios.test.ts" "$TMPDIR/java.log")
fi
if [ "$SUITE" = "all" ] || [ "$SUITE" = "runner" ]; then
  PID_RUNNER=$(run_suite "Self-hosted runner" "test/integration/ecommerce/scenarioSelfHostedRunner.test.ts" "$TMPDIR/runner.log")
fi

echo ""
echo "Waiting..."
echo ""

[ -n "$PID_PY" ] && { collect_result "Python" "$PID_PY" "$TMPDIR/python.log" || FAIL=1; }
[ -n "$PID_JAVA" ] && { collect_result "Java" "$PID_JAVA" "$TMPDIR/java.log" || FAIL=1; }
[ -n "$PID_RUNNER" ] && { collect_result "Runner" "$PID_RUNNER" "$TMPDIR/runner.log" || FAIL=1; }

echo ""
[ $FAIL -eq 0 ] && echo "ALL PASSED" || { echo "SOME SUITES FAILED"; exit 1; }
