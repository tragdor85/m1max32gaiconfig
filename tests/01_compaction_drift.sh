#!/usr/bin/env bash
# test/01_compaction_drift.sh
# Verifies that the known drift (legacy compaction keys) has been resolved:
# 1. settings.json must NOT contain legacy dotted keys (reserveTokens.models / keepRecentTokens.models)
# 2. settings.json MUST contain compaction.modelOverrides
# 3. The "Known drift" section must be removed from docs/05-extensions.md

set -euo pipefail

PASS=0
FAIL=0
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

check() {
  local label="$1"
  shift
  if eval "$@" >/dev/null 2>&1; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Compaction drift regression tests ==="

SETTINGS="$REPO_ROOT/pi/settings.json"

# 1. No legacy compaction.reserveTokens.models
check "No legacy key: compaction.reserveTokens.models" \
  "! grep -q 'reserveTokens\.models' '$SETTINGS'"

# 2. No legacy compaction.keepRecentTokens.models
check "No legacy key: compaction.keepRecentTokens.models" \
  "! grep -q 'keepRecentTokens\.models' '$SETTINGS'"

# 3. settings.json has compaction.modelOverrides
check "Has compaction.modelOverrides" \
  "grep -q 'modelOverrides' '$SETTINGS'"

# 4. docs/05-extensions.md does NOT mention the legacy drift section
check "No 'Known drift' section in docs/05-extensions.md" \
  "! grep -qi 'Known drift: legacy compaction' '$REPO_ROOT/docs/05-extensions.md'"

# 5. docs/05-extensions.md does NOT mention legacy dotted keys
check "No legacy key references in docs/05-extensions.md" \
  "! grep -q 'reserveTokens\.models' '$REPO_ROOT/docs/05-extensions.md'"

# 6. No other doc references the legacy keys either
LEGACY_MATCH=$(grep -rl 'reserveTokens\.models\|keepRecentTokens\.models' $(find "$REPO_ROOT/docs" -name '*.md' 2>/dev/null) 2>/dev/null || true)
if [ -z "$LEGACY_MATCH" ]; then
  echo "  ✓ No legacy key references in any doc"
  PASS=$((PASS + 1))
else
  echo "  ✗ No legacy key references in any doc (found in: $LEGACY_MATCH)"
  FAIL=$((FAIL + 1))
fi

# 7. modelOverrides entries exist for all three models
for model in \
  "splash/mlx-community/Qwen3.8-27B-4bit" \
  "splash/mlx-community/Qwen3.6-35B-A3B-4bit" \
  "splash/prism-ml/Ternary-Bonsai-2-27B-gguf:PQ2_0"; do
  check "modelOverrides entry: $model" \
    "grep -q \"$model\" '$SETTINGS'"
done

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo "FAIL: compaction drift regression tests"
  exit 1
fi
echo "PASS: compaction drift regression tests"
exit 0
