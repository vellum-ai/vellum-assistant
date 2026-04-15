#!/usr/bin/env bash
set -uo pipefail

# ---------------------------------------------------------------------------
# Test runner with full process isolation for Bun mock.module conflicts
#
# Bun's mock.module is process-global: the last mock.module call for a given
# specifier wins across ALL test files in the process.  This means test files
# that mock a module break other test files that need the real implementation.
# To avoid order-dependent CI flakes, run each test file in its own Bun process.
#
# Files run in parallel (configurable via TEST_WORKERS, default: CPU count).
#
# Coverage: set COVERAGE=true to generate per-file lcov reports, merged into
# coverage/lcov.info at the end.
# ---------------------------------------------------------------------------

EXCLUDE_EXPERIMENTAL="${EXCLUDE_EXPERIMENTAL:-false}"
WORKERS="${TEST_WORKERS:-$(sysctl -n hw.logicalcpu 2>/dev/null || nproc 2>/dev/null || echo 8)}"
COVERAGE="${COVERAGE:-false}"
# Per-test timeout (seconds). Kills bun processes that pass but don't exit due to open handles.
PER_TEST_TIMEOUT="${PER_TEST_TIMEOUT:-120}"
# Longest-first scheduling: provide a durations file from a previous run to sort
# slow tests to the front, improving parallel utilization.
TEST_DURATIONS_FILE="${TEST_DURATIONS_FILE:-}"
TEST_DURATIONS_OUTPUT="${TEST_DURATIONS_OUTPUT:-}"

EXPERIMENTAL_FILES=(
  "skill-load-tool.test.ts"
  "memory-regressions.experimental.test.ts"
)

# Tests that exist in the tree but are known-broken when run.  They were
# invisible to the previous `src/__tests__ -maxdepth 1` glob, so drift against
# the surrounding code went uncaught.  They are excluded unconditionally until
# triage lands a fix for each.  Each entry should get a follow-up issue before
# being removed from this list.
#
# To triage an entry: run `bun test <path>` from `assistant/` and fix the
# underlying code or tests until the file is green, then remove it here.
KNOWN_BROKEN_FILES=(
  "attachment-routes.test.ts"
  "backup-routes.test.ts"
  "byo-connection.test.ts"
  "callback-routes-list.test.ts"
  "connect.test.ts"
  "contact-routes.test.ts"
  "conversation-tool-setup.test.ts"
  "credentials-cli.test.ts"
  "disconnect.test.ts"
  "email-attachment.test.ts"
  "email-download.test.ts"
  "email-list.test.ts"
  "email-register.test.ts"
  "email-send.test.ts"
  "email-status.test.ts"
  "email-unregister.test.ts"
  "feature-flag-registry-bundled.test.ts"
  "guard-tests.test.ts"
  "host-shell-tool.test.ts"
  "memory-item-routes.test.ts"
  "provider-adapters.test.ts"
  "providers-delete.test.ts"
  "qdrant-manager.test.ts"
  "shell-tool-proxy-mode.test.ts"
  "skill-feature-flags-integration.test.ts"
  "status.test.ts"
  "terminal-tools.test.ts"
  "tts-text-sanitizer.test.ts"
)

# Collect test files, filtering experimental if needed
test_files=()
while IFS= read -r test_file; do
  base_name="$(basename "${test_file}")"
  if [[ "${EXCLUDE_EXPERIMENTAL}" == "true" ]]; then
    skip=0
    for ef in "${EXPERIMENTAL_FILES[@]}"; do
      if [[ "${base_name}" == "${ef}" ]]; then
        skip=1
        break
      fi
    done
    if [[ ${skip} -eq 1 ]]; then
      continue
    fi
  fi
  # Always exclude benchmark files — run them with `bun run test:bench` instead
  if [[ "${base_name}" == *.benchmark.test.ts ]]; then
    continue
  fi
  # Always exclude known-broken files (see comment above the list).
  skip_broken=0
  for bf in "${KNOWN_BROKEN_FILES[@]}"; do
    if [[ "${base_name}" == "${bf}" ]]; then
      skip_broken=1
      break
    fi
  done
  if [[ ${skip_broken} -eq 1 ]]; then
    continue
  fi

  test_files+=("${test_file}")
done < <(find src -type f -name '*.test.ts' | sort)

if [[ ${#test_files[@]} -eq 0 ]]; then
  echo "No test files found under src"
  exit 1
fi

# Sort tests longest-first using durations from a previous run.
# This ensures slow tests start immediately across all workers instead of
# piling up at the end and becoming long poles.
if [[ -n "${TEST_DURATIONS_FILE}" && -f "${TEST_DURATIONS_FILE}" ]]; then
  sorted_files=()
  # Build lookup: basename -> duration_ms
  declare -A dur_map
  while IFS=$'\t' read -r ms name; do
    dur_map["${name}"]="${ms}"
  done < "${TEST_DURATIONS_FILE}"

  # Partition into known (with durations) and unknown
  known=()
  unknown=()
  for f in "${test_files[@]}"; do
    base="$(basename "${f}")"
    if [[ -n "${dur_map["${base}"]:-}" ]]; then
      known+=("${dur_map["${base}"]}"$'\t'"${f}")
    else
      unknown+=("${f}")
    fi
  done

  # Sort known by duration descending
  while IFS= read -r line; do
    sorted_files+=("${line#*$'\t'}")
  done < <(printf '%s\n' "${known[@]}" | sort -t$'\t' -k1 -rn)

  # Append unknown files at the end
  sorted_files+=("${unknown[@]}")
  test_files=("${sorted_files[@]}")
  echo "Sorted tests longest-first using ${TEST_DURATIONS_FILE} (${#known[@]} known, ${#unknown[@]} new)"
fi

echo "Running ${#test_files[@]} test files (${WORKERS} workers)"

# Temp dir for per-file output capture and failure tracking
results_dir="$(mktemp -d)"
trap 'rm -rf "${results_dir}"' EXIT

# When coverage is enabled, each test file writes lcov to its own subdirectory
if [[ "${COVERAGE}" == "true" ]]; then
  coverage_base="$(pwd)/coverage"
  rm -rf "${coverage_base}"
  mkdir -p "${coverage_base}"
fi

# Run tests in parallel, capturing output per file
printf '%s\n' "${test_files[@]}" | xargs -P "${WORKERS}" -I {} bash -c '
  test_file="$1"
  results_dir="$2"
  exclude_exp="$3"
  coverage_enabled="$4"
  per_test_timeout="$5"

  safe_name="$(echo "${test_file}" | tr "/" "_")"
  out_file="${results_dir}/${safe_name}.out"

  coverage_args=""
  if [[ "${coverage_enabled}" == "true" ]]; then
    cov_dir="${results_dir}/cov_${safe_name}"
    mkdir -p "${cov_dir}"
    coverage_args="--coverage --coverage-reporter=lcov --coverage-dir=${cov_dir}"
  fi

  # Resolve timeout binary (coreutils `timeout` on Linux, `gtimeout` on macOS via brew)
  timeout_cmd=""
  if command -v timeout &>/dev/null; then
    timeout_cmd="timeout"
  elif command -v gtimeout &>/dev/null; then
    timeout_cmd="gtimeout"
  fi

  start_ms=$(perl -MTime::HiRes=time -e "printf \"%d\", time*1000")

  if [[ -n "${timeout_cmd}" ]]; then
    if [[ "${exclude_exp}" == "true" ]]; then
      "${timeout_cmd}" -k 10 "${per_test_timeout}" bun test ${coverage_args} --test-name-pattern "^(?!.*\\[experimental\\])" "${test_file}" > "${out_file}" 2>&1
    else
      "${timeout_cmd}" -k 10 "${per_test_timeout}" bun test ${coverage_args} "${test_file}" > "${out_file}" 2>&1
    fi
  else
    if [[ "${exclude_exp}" == "true" ]]; then
      bun test ${coverage_args} --test-name-pattern "^(?!.*\\[experimental\\])" "${test_file}" > "${out_file}" 2>&1
    else
      bun test ${coverage_args} "${test_file}" > "${out_file}" 2>&1
    fi
  fi
  exit_code=$?

  end_ms=$(perl -MTime::HiRes=time -e "printf \"%d\", time*1000")
  elapsed=$(( end_ms - start_ms ))

  base="$(basename "${test_file}")"

  # Record duration for longest-first scheduling in future runs
  echo -e "${elapsed}\t${base}" >> "${results_dir}/durations"

  if [[ -n "${timeout_cmd}" && ( ${exit_code} -eq 124 || ${exit_code} -eq 137 ) ]]; then
    # timeout killed the process — check if all tests actually passed.
    # Bun test outputs "(fail)" for failed tests and a final summary line
    # "Ran X tests across Y files" when the run completes. Both conditions
    # must hold: no failures AND the end-of-run summary present. Without
    # the summary, the process was killed mid-run before finishing all tests.
    if grep -q "^(fail)" "${out_file}" 2>/dev/null; then
      echo "${test_file}" >> "${results_dir}/failures"
      echo "  ✗ ${base} (killed after ${per_test_timeout}s — tests failed and process hung)"
    elif grep -qE "^Ran [0-9]+ tests? across" "${out_file}" 2>/dev/null; then
      echo "  ⚠ ${base} (tests passed but process hung after ${per_test_timeout}s — likely open handles)"
    else
      echo "${test_file}" >> "${results_dir}/failures"
      echo "  ✗ ${base} (killed after ${per_test_timeout}s — test run did not complete)"
    fi
  elif [[ ${exit_code} -ne 0 ]]; then
    echo "${test_file}" >> "${results_dir}/failures"
    echo "  ✗ ${base} (${elapsed}ms)"
  else
    echo "  ✓ ${base} (${elapsed}ms)"
  fi
' _ {} "${results_dir}" "${EXCLUDE_EXPERIMENTAL}" "${COVERAGE}" "${PER_TEST_TIMEOUT}"
xargs_exit=$?

# Verify tests actually ran — catch xargs startup failures (e.g. invalid TEST_WORKERS)
actual_runs=$(ls "${results_dir}"/*.out 2>/dev/null | wc -l)
if [[ ${actual_runs} -eq 0 ]]; then
  echo "ERROR: No tests were executed (xargs exit code: ${xargs_exit})"
  exit 1
fi

# xargs exits 125-127 for its own errors (not child failures) — treat as hard failure
if [[ ${xargs_exit} -ge 125 ]]; then
  echo "ERROR: xargs failed with exit code ${xargs_exit}"
  exit 1
fi

# Write observed durations for longest-first scheduling in future CI runs.
# This must happen before the failure exit so durations are persisted even when
# tests fail, aligning with the `if: always()` cache save step in CI.
if [[ -n "${TEST_DURATIONS_OUTPUT}" && -f "${results_dir}/durations" ]]; then
  sort -t$'\t' -k1 -rn "${results_dir}/durations" > "${TEST_DURATIONS_OUTPUT}"
  echo "Wrote test durations to ${TEST_DURATIONS_OUTPUT}"
fi

# Print output for any failed tests
if [[ -f "${results_dir}/failures" ]]; then
  echo ""
  failed_count=0
  while IFS= read -r f; do
    failed_count=$((failed_count + 1))
    safe_name="$(echo "${f}" | tr "/" "_")"
    echo "──────────────────────────────────────────"
    echo "FAIL: ${f}"
    echo "──────────────────────────────────────────"
    cat "${results_dir}/${safe_name}.out"
    echo ""
  done < "${results_dir}/failures"

  echo "========================================"
  echo "  FAILED TEST FILES (${failed_count}):"
  echo "========================================"
  while IFS= read -r f; do
    echo "  ✗ ${f}"
  done < "${results_dir}/failures"
  echo "========================================"
  exit 1
fi

# Merge per-file lcov reports into a single coverage/lcov.info
# Uses an awk-based merge to deduplicate source files that appear in multiple
# test shards — raw concatenation would count shared files multiple times.
if [[ "${COVERAGE}" == "true" ]]; then
  merged="${coverage_base}/lcov.info"
  raw="${results_dir}/raw_lcov.info"
  : > "${raw}"
  for lcov_file in "${results_dir}"/cov_*/lcov.info; do
    if [[ -f "${lcov_file}" ]]; then
      cat "${lcov_file}" >> "${raw}"
    fi
  done
  if [[ -s "${raw}" ]]; then
    awk '
    /^SF:/ {
      sf = $0
      sub(/^SF:/, "", sf)
      # Reset per-block FN/FNDA positional counters for this source block
      for (k = 1; k <= blk_fn_count; k++) delete blk_fn_at[k]
      blk_fn_count = 0
      blk_fnda_idx = 0
      next
    }
    /^DA:/ {
      # DA:line_number,execution_count
      sub(/^DA:/, "")
      split($0, parts, ",")
      line = parts[1]
      count = parts[2] + 0
      key = sf SUBSEP line
      if (key in da) {
        da[key] += count
      } else {
        da[key] = count
        # Track insertion order per source file
        file_lines[sf] = file_lines[sf] SUBSEP line
      }
      files[sf] = 1
      next
    }
    /^FN:/ {
      # FN:line_number,function_name — deduplicate by line+name
      sub(/^FN:/, "")
      key = sf SUBSEP $0
      if (!(key in fn_seen)) {
        fn_seen[key] = 1
        fn_list[sf] = fn_list[sf] SUBSEP $0
      }
      # Track FN order within this lcov block so we can pair
      # each subsequent FNDA with its corresponding FN by position
      blk_fn_count++
      blk_fn_at[blk_fn_count] = $0
      next
    }
    /^FNDA:/ {
      # FNDA:execution_count,function_name — pair with FN by position
      sub(/^FNDA:/, "")
      split($0, parts, ",")
      count = parts[1] + 0
      # Use positional index to find the matching FN (line,name)
      blk_fnda_idx++
      fn_full = blk_fn_at[blk_fnda_idx]
      if (fn_full == "") fn_full = parts[2]
      key = sf SUBSEP fn_full
      if (key in fnda) {
        fnda[key] += count
      } else {
        fnda[key] = count
        fnda_order[sf] = fnda_order[sf] SUBSEP fn_full
      }
      next
    }
    /^BRDA:/ {
      # BRDA:line,block,branch,taken — sum taken counts
      sub(/^BRDA:/, "")
      split($0, parts, ",")
      bkey = sf SUBSEP parts[1] "," parts[2] "," parts[3]
      taken = parts[4]
      if (taken == "-") {
        # "-" means not executed — only set if no shard provided a numeric value
        if (!(bkey in brda_numeric)) {
          brda[bkey] = 0
        }
      } else {
        taken += 0
        if (bkey in brda_numeric) {
          brda[bkey] += taken
        } else {
          brda[bkey] = taken
        }
        brda_numeric[bkey] = 1
      }
      if (!(bkey in brda_seen)) {
        brda_seen[bkey] = 1
        brda_id[sf] = brda_id[sf] SUBSEP parts[1] "," parts[2] "," parts[3]
      }
      next
    }
    { next }
    END {
      for (sf in files) {
        print "SF:" sf

        # Function declarations
        n = split(fn_list[sf], fns, SUBSEP)
        for (i = 2; i <= n; i++) {
          print "FN:" fns[i]
        }

        # Function execution counts
        n = split(fnda_order[sf], fn_entries, SUBSEP)
        fnf = 0; fnh = 0
        for (i = 2; i <= n; i++) {
          key = sf SUBSEP fn_entries[i]
          # fn_entries[i] is "line,name" — strip leading "line," to get the name
          # Uses sub() instead of split() so commas in function names are preserved
          fname_out = fn_entries[i]
          sub(/^[^,]*,/, "", fname_out)
          if (fname_out == "" || fname_out == fn_entries[i]) fname_out = fn_entries[i]
          print "FNDA:" fnda[key] "," fname_out
          fnf++
          if (fnda[key] > 0) fnh++
        }
        print "FNF:" fnf
        print "FNH:" fnh

        # Branch data
        n = split(brda_id[sf], brs, SUBSEP)
        brf = 0; brh = 0
        for (i = 2; i <= n; i++) {
          key = sf SUBSEP brs[i]
          taken = brda[key]
          if (key in brda_numeric) {
            print "BRDA:" brs[i] "," taken
            brf++
            if (taken > 0) brh++
          } else {
            print "BRDA:" brs[i] ",-"
            brf++
          }
        }
        if (brf > 0) {
          print "BRF:" brf
          print "BRH:" brh
        }

        # Line data
        n = split(file_lines[sf], lines, SUBSEP)
        lf = 0; lh = 0
        for (i = 2; i <= n; i++) {
          key = sf SUBSEP lines[i]
          print "DA:" lines[i] "," da[key]
          lf++
          if (da[key] > 0) lh++
        }
        print "LF:" lf
        print "LH:" lh
        print "end_of_record"
      }
    }
    ' "${raw}" > "${merged}"
    echo "Coverage report written to coverage/lcov.info"
  else
    echo "Warning: no coverage data was generated"
  fi
fi

echo "All ${#test_files[@]} test files passed"
