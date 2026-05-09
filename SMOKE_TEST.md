# /goal Smoke Test

A minimal manual checklist to confirm the `/goal` command, helper, and Stop
hook are wired up correctly in a fresh checkout. Run from the project root.
Each step lists PowerShell (Windows) and bash (Linux/Mac) commands plus the
expected observable result.

## 1. Install Check

Confirm the hidden `.claude/` directory and helper script came along.

PowerShell:

```powershell
Test-Path .\.claude\commands\goal.md           # True
Test-Path .\.claude\settings.json              # True
Test-Path .\.claude\scripts\goal-helper.mjs    # True
node --version                                 # >= 18 for tests
npm test                                       # all tests pass
```

Bash:

```bash
test -f .claude/commands/goal.md        && echo OK || echo MISSING
test -f .claude/settings.json           && echo OK || echo MISSING
test -f .claude/scripts/goal-helper.mjs && echo OK || echo MISSING
node --version                          # >= 18 for tests
npm test                                # all tests pass
```

If any PowerShell `Test-Path` prints `False` or any bash check prints
`MISSING`, re-copy with hidden items visible (see README install notes).

## 1A. Direct Lifecycle Helper Check

Use a disposable target to confirm install, update, and uninstall do not touch
local settings.

PowerShell:

```powershell
$target = Join-Path $env:TEMP "goal-lifecycle-smoke"
New-Item -ItemType Directory -Force $target | Out-Null
New-Item -ItemType Directory -Force (Join-Path $target ".claude") | Out-Null
'{"permissions":{"allow":["Bash(git status)"]}}' |
  Set-Content (Join-Path $target ".claude\settings.local.json")

npm run goal:install -- --project $target    # settings.local: untouched
npm run goal:update -- --project $target     # settings.local: untouched
npm run goal:uninstall -- --project $target  # settings.local: untouched

Get-Content (Join-Path $target ".claude\settings.local.json")
# Expect the original permissions JSON.
```

Bash:

```bash
target="${TMPDIR:-/tmp}/goal-lifecycle-smoke"
mkdir -p "$target/.claude"
printf '%s\n' '{"permissions":{"allow":["Bash(git status)"]}}' > "$target/.claude/settings.local.json"

npm run goal:install -- --project "$target"    # settings.local: untouched
npm run goal:update -- --project "$target"     # settings.local: untouched
npm run goal:uninstall -- --project "$target"  # settings.local: untouched

cat "$target/.claude/settings.local.json"
# Expect the original permissions JSON.
```

## 2. Helper Lifecycle

Drive the helper directly with a temporary state file so the real
`goal-state/goals.json` is untouched. Keep these environment variables set
through steps 3 and 4, then remove them in step 5.

PowerShell:

```powershell
$env:CLAUDE_GOAL_DB = "$env:TEMP\goal-smoke.json"
$env:CLAUDE_GOAL_SESSION_ID = "smoke"

node .claude/scripts/goal-helper.mjs invoke "smoke objective"   # Action: set, Status: active
node .claude/scripts/goal-helper.mjs status                     # Status: active
node .claude/scripts/goal-helper.mjs pause                      # Status: paused
node .claude/scripts/goal-helper.mjs resume                     # Status: active
node .claude/scripts/goal-helper.mjs doctor                     # "Goal doctor", read-only diagnostics
node .claude/scripts/goal-helper.mjs complete                   # Status: complete
node .claude/scripts/goal-helper.mjs clear                      # "Goal cleared."
```

Bash:

```bash
export CLAUDE_GOAL_DB="${TMPDIR:-/tmp}/goal-smoke.json"
export CLAUDE_GOAL_SESSION_ID="smoke"

node .claude/scripts/goal-helper.mjs invoke "smoke objective"   # Action: set, Status: active
node .claude/scripts/goal-helper.mjs status                     # Status: active
node .claude/scripts/goal-helper.mjs pause                      # Status: paused
node .claude/scripts/goal-helper.mjs resume                     # Status: active
node .claude/scripts/goal-helper.mjs doctor                     # "Goal doctor", read-only diagnostics
node .claude/scripts/goal-helper.mjs complete                   # Status: complete
node .claude/scripts/goal-helper.mjs clear                      # "Goal cleared."
```

## 3. Stop Hook Continuation

With an active goal, the Stop hook must emit a JSON block decision so Claude
Code keeps working.

PowerShell:

```powershell
node .claude/scripts/goal-helper.mjs invoke "stop hook smoke"

'{"session_id":"smoke","cwd":".","hook_event_name":"Stop"}' |
  node .claude/scripts/goal-helper.mjs stop-hook
# Expect JSON: {"decision":"block","reason":"An active /goal is still running...."}

node .claude/scripts/goal-helper.mjs pause
'{"session_id":"smoke","cwd":".","hook_event_name":"Stop"}' |
  node .claude/scripts/goal-helper.mjs stop-hook
# Expect: empty output (paused goals do not block Stop)

node .claude/scripts/goal-helper.mjs clear
```

Bash:

```bash
node .claude/scripts/goal-helper.mjs invoke "stop hook smoke"

printf '%s' '{"session_id":"smoke","cwd":".","hook_event_name":"Stop"}' |
  node .claude/scripts/goal-helper.mjs stop-hook
# Expect JSON: {"decision":"block","reason":"An active /goal is still running...."}

node .claude/scripts/goal-helper.mjs pause
printf '%s' '{"session_id":"smoke","cwd":".","hook_event_name":"Stop"}' |
  node .claude/scripts/goal-helper.mjs stop-hook
# Expect: empty output (paused goals do not block Stop)

node .claude/scripts/goal-helper.mjs clear
```

## 4. Literal Objective Quoting

The slash command passes objective text on stdin through a quoted heredoc. This
smoke test reproduces nested quotes, parentheses, and multiline text.

PowerShell:

```powershell
$objective = @'
some loopholes were found "Other loopholes considered but not fixed
(and why):
- Same-cwd session collision -- documented fallback
'@
$objective | node .claude/scripts/goal-helper.mjs invoke
node .claude/scripts/goal-helper.mjs status --json
node .claude/scripts/goal-helper.mjs clear
```

Bash:

```bash
node .claude/scripts/goal-helper.mjs invoke <<'__CLAUDE_GOAL_ARGUMENTS_5E2D8D9F__'
some loopholes were found "Other loopholes considered but not fixed
(and why):
- Same-cwd session collision -- documented fallback
__CLAUDE_GOAL_ARGUMENTS_5E2D8D9F__
node .claude/scripts/goal-helper.mjs status --json
node .claude/scripts/goal-helper.mjs clear
```

Expect the JSON objective to contain the quote, newline, and parentheses
literally. There should be no shell syntax error.

## 5. Refusal Auto-Pause

When the last assistant message looks like a refusal or hard blocker, the Stop
hook must auto-pause the goal instead of looping forever.

PowerShell:

```powershell
node .claude/scripts/goal-helper.mjs invoke "refusal auto pause"

'{"session_id":"smoke","cwd":".","hook_event_name":"Stop","last_assistant_message":"I cannot help with this request."}' |
  node .claude/scripts/goal-helper.mjs stop-hook
# Expect: empty output

node .claude/scripts/goal-helper.mjs status
# Expect: Status: paused

node .claude/scripts/goal-helper.mjs clear
```

Bash:

```bash
node .claude/scripts/goal-helper.mjs invoke "refusal auto pause"

printf '%s' '{"session_id":"smoke","cwd":".","hook_event_name":"Stop","last_assistant_message":"I cannot help with this request."}' |
  node .claude/scripts/goal-helper.mjs stop-hook
# Expect: empty output

node .claude/scripts/goal-helper.mjs status
# Expect: Status: paused

node .claude/scripts/goal-helper.mjs clear
```

## 5A. Deadline-Limited Stop

When the active-time deadline has elapsed, the Stop hook should stop automatic
continuation by marking the goal `deadline_limited`. Extend the deadline to
continue.

PowerShell:

```powershell
$env:CLAUDE_GOAL_DB = "$env:TEMP\goal-smoke-deadline.json"
$env:CLAUDE_GOAL_SESSION_ID = "smoke-deadline"
node .claude/scripts/goal-helper.mjs invoke --deadline 1s "deadline smoke"
Start-Sleep -Seconds 2
'{"session_id":"smoke-deadline","cwd":".","hook_event_name":"Stop"}' |
  node .claude/scripts/goal-helper.mjs stop-hook
# Expect: empty output
node .claude/scripts/goal-helper.mjs status --json
# Expect: "status": "deadline_limited"
node .claude/scripts/goal-helper.mjs extend --deadline 1m
# Expect: Status: active
node .claude/scripts/goal-helper.mjs clear
```

Bash:

```bash
export CLAUDE_GOAL_DB="${TMPDIR:-/tmp}/goal-smoke-deadline.json"
export CLAUDE_GOAL_SESSION_ID="smoke-deadline"
node .claude/scripts/goal-helper.mjs invoke --deadline 1s "deadline smoke"
sleep 2
printf '%s' '{"session_id":"smoke-deadline","cwd":".","hook_event_name":"Stop"}' |
  node .claude/scripts/goal-helper.mjs stop-hook
# Expect: empty output
node .claude/scripts/goal-helper.mjs status --json
# Expect: "status": "deadline_limited"
node .claude/scripts/goal-helper.mjs extend --deadline 1m
# Expect: Status: active
node .claude/scripts/goal-helper.mjs clear
```

## 5B. Budget-Limited Stop

When Claude Code supplies a Stop-hook `transcript_path`, the helper should read
bounded JSONL usage data, persist the observed total once, and stop automatic
continuation when the token budget is reached.

PowerShell:

```powershell
$env:CLAUDE_GOAL_DB = "$env:TEMP\goal-smoke-budget.json"
$env:CLAUDE_GOAL_SESSION_ID = "smoke-budget"
$transcript = "$env:TEMP\goal-smoke-budget-transcript.jsonl"
node .claude/scripts/goal-helper.mjs invoke --tokens 100 "budget smoke"
'{"message":{"usage":{"input_tokens":70,"cache_creation_input_tokens":10,"cache_read_input_tokens":10,"output_tokens":10}}}' |
  Set-Content -NoNewline $transcript
$hook = @{ session_id = "smoke-budget"; cwd = "."; hook_event_name = "Stop"; transcript_path = $transcript } |
  ConvertTo-Json -Compress
$hook |
  node .claude/scripts/goal-helper.mjs stop-hook
# Expect: empty output
node .claude/scripts/goal-helper.mjs status --json
# Expect: "status": "budget_limited" and "tokensUsed": 100
node .claude/scripts/goal-helper.mjs extend --tokens 150
# Expect: Status: active
node .claude/scripts/goal-helper.mjs clear
Remove-Item $transcript -ErrorAction SilentlyContinue
```

Bash:

```bash
export CLAUDE_GOAL_DB="${TMPDIR:-/tmp}/goal-smoke-budget.json"
export CLAUDE_GOAL_SESSION_ID="smoke-budget"
transcript="${TMPDIR:-/tmp}/goal-smoke-budget-transcript.jsonl"
node .claude/scripts/goal-helper.mjs invoke --tokens 100 "budget smoke"
printf '%s\n' '{"message":{"usage":{"input_tokens":70,"cache_creation_input_tokens":10,"cache_read_input_tokens":10,"output_tokens":10}}}' > "$transcript"
printf '{"session_id":"smoke-budget","cwd":".","hook_event_name":"Stop","transcript_path":"%s"}' "$transcript" |
  node .claude/scripts/goal-helper.mjs stop-hook
# Expect: empty output
node .claude/scripts/goal-helper.mjs status --json
# Expect: "status": "budget_limited" and "tokensUsed": 100
node .claude/scripts/goal-helper.mjs extend --tokens 150
# Expect: Status: active
node .claude/scripts/goal-helper.mjs clear
rm -f "$transcript"
```

## 6. Cleanup

Remove smoke-test artifacts and confirm the real project state is untouched.

PowerShell:

```powershell
Remove-Item Env:CLAUDE_GOAL_DB
Remove-Item Env:CLAUDE_GOAL_SESSION_ID
Remove-Item "$env:TEMP\goal-smoke.json" -ErrorAction SilentlyContinue
Remove-Item "$env:TEMP\goal-smoke-budget.json" -ErrorAction SilentlyContinue
Remove-Item "$env:TEMP\goal-smoke-budget-transcript.jsonl" -ErrorAction SilentlyContinue

# Confirm the real state file did not pick up smoke-test goals.
Get-Content .\goal-state\goals.json -ErrorAction SilentlyContinue |
  Select-String -Pattern "smoke" -SimpleMatch
# Expect: no matches

# Confirm runtime state is still gitignored.
Select-String -Path .\.gitignore -Pattern "goal-state/goals.json"
# Expect: a match
```

Bash:

```bash
unset CLAUDE_GOAL_DB
unset CLAUDE_GOAL_SESSION_ID
rm -f "${TMPDIR:-/tmp}/goal-smoke.json" "${TMPDIR:-/tmp}/goal-smoke.json.lock"
rm -f "${TMPDIR:-/tmp}/goal-smoke-budget.json" "${TMPDIR:-/tmp}/goal-smoke-budget.json.lock"
rm -f "${TMPDIR:-/tmp}/goal-smoke-budget-transcript.jsonl"

# Confirm the real state file did not pick up smoke-test goals.
if test -f goal-state/goals.json; then
  grep -F "smoke" goal-state/goals.json
fi
# Expect: no matches

# Confirm runtime state is still gitignored.
grep -F "goal-state/goals.json" .gitignore
# Expect: a match
```

If every step above behaves as described, the install is healthy.
