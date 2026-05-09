import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const commandPath = path.join(root, ".claude", "commands", "goal.md");
const settingsPath = path.join(root, ".claude", "settings.json");
const helperPath = path.join(root, ".claude", "scripts", "goal-helper.mjs");
const pluginCommandPath = path.join(root, "plugins", "goal", "commands", "goal.md");
const pluginHelperPath = path.join(root, "plugins", "goal", "scripts", "goal-helper.mjs");
const pluginHooksPath = path.join(root, "plugins", "goal", "hooks", "hooks.json");
const pluginManifestPath = path.join(root, "plugins", "goal", ".claude-plugin", "plugin.json");
const marketplacePath = path.join(root, ".claude-plugin", "marketplace.json");
const stateFormatPath = path.join(root, "goal-state", "state-format.md");
const goalReadmePath = path.join(root, "goal-state", "README.md");
const gitignorePath = path.join(root, ".gitignore");
const skillDirPath = path.join(root, ".claude", "skills");

async function fileText(filePath) {
  return readFile(filePath, "utf8");
}

async function withTempGoalDb(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "goal-helper-test-"));
  try {
    return await fn(path.join(dir, "goals.json"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runHelper(dbPath, args, options = {}) {
  const sessionValue = Object.prototype.hasOwnProperty.call(options, "session") ? options.session : "test-session";
  const env = {
    ...process.env,
    CLAUDE_GOAL_DB: dbPath,
    CLAUDE_GOAL_MAX_STOP_CONTINUES: options.maxStopContinues ?? "500",
    ...(options.env ?? {})
  };
  if (sessionValue == null) delete env.CLAUDE_GOAL_SESSION_ID;
  else env.CLAUDE_GOAL_SESSION_ID = sessionValue;

  return spawnSync(process.execPath, [helperPath, ...args], {
    cwd: options.cwd ?? root,
    input: options.input,
    text: true,
    encoding: "utf8",
    env
  });
}

describe("Claude Code goal command", () => {
  it("has the required project command, settings, helper, and state files", async () => {
    await Promise.all([
      access(commandPath),
      access(settingsPath),
      access(helperPath),
      access(pluginCommandPath),
      access(pluginHelperPath),
      access(pluginHooksPath),
      access(pluginManifestPath),
      access(marketplacePath),
      access(stateFormatPath),
      access(goalReadmePath)
    ]);
  });

  it("declares a direct /goal project slash command wired to the helper", async () => {
    const text = await fileText(commandPath);

    assert.match(text, /^---\n/);
    assert.match(text, /\ndescription: .+\n/);
    assert.match(text, /\nargument-hint: "\[status\|pause\|resume\|complete\|clear\] \[--tokens N\] <objective>"\n/);
    assert.match(text, /\ndisable-model-invocation: true\n/);
    assert.match(text, /\nallowed-tools: Bash\(node:\*\)\n/);
    assert.match(text, /node \.claude\/scripts\/goal-helper\.mjs invoke <<'__CLAUDE_GOAL_ARGUMENTS_5E2D8D9F__'/);
    assert.match(text, /\$ARGUMENTS/);
    assert.match(text, /__CLAUDE_GOAL_ARGUMENTS_5E2D8D9F__/);
  });

  it("declares an installable Claude Code plugin marketplace and plugin", async () => {
    const marketplace = JSON.parse(await fileText(marketplacePath));
    const manifest = JSON.parse(await fileText(pluginManifestPath));
    const pluginCommand = await fileText(pluginCommandPath);
    const pluginHooks = JSON.parse(await fileText(pluginHooksPath));

    assert.equal(marketplace.name, "goal-cc");
    assert.deepEqual(marketplace.plugins.map((plugin) => plugin.name), ["goal"]);
    assert.equal(marketplace.plugins[0].source, "./plugins/goal");

    assert.equal(manifest.name, "goal");
    assert.equal(manifest.version, "0.1.0");
    assert.equal(manifest.repository, "https://github.com/bullish0x/goal-cc");

    assert.match(pluginCommand, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/goal-helper\.mjs" invoke <<'__CLAUDE_GOAL_ARGUMENTS_5E2D8D9F__'/);
    const stopHooks = pluginHooks.hooks?.Stop?.flatMap((entry) => entry.hooks ?? []) ?? [];
    assert.equal(
      stopHooks.some((hook) => hook.type === "command" && hook.command.includes("${CLAUDE_PLUGIN_ROOT}/scripts/goal-helper.mjs")),
      true
    );
  });

  it("keeps the project helper and plugin helper in sync", async () => {
    assert.equal(await fileText(pluginHelperPath), await fileText(helperPath));
  });

  it("configures a Stop hook that calls the helper", async () => {
    const settings = JSON.parse(await fileText(settingsPath));
    const stopHooks = settings.hooks?.Stop?.flatMap((entry) => entry.hooks ?? []) ?? [];

    assert.equal(
      stopHooks.some((hook) => hook.type === "command" && hook.command.includes("goal-helper.mjs") && hook.command.includes("CLAUDE_PROJECT_DIR")),
      true
    );
  });

  it("keeps Bash-facing runtime syntax compatible with Node 12", async () => {
    const text = await fileText(helperPath);
    const result = spawnSync(process.execPath, ["--check", helperPath], { text: true, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(text, /\?\?/, "runtime helper must avoid nullish coalescing for Node 12");
    assert.doesNotMatch(text, /\?\./, "runtime helper must avoid optional chaining for Node 12");
    assert.doesNotMatch(text, /randomUUID/, "runtime helper must avoid crypto.randomUUID for Node 12");
  });

  it("keeps archiveGoal standard fields protected from extras override", async () => {
    const text = await fileText(helperPath);
    const archiveStart = text.indexOf("function archiveGoal");
    const extrasSpread = text.indexOf("...extras", archiveStart);
    const idField = text.indexOf("id: goal.id", archiveStart);
    const outcomeField = text.indexOf("\n    outcome,", archiveStart);
    const archivedAtField = text.indexOf("archivedAt: nowIso()", archiveStart);

    assert.ok(archiveStart >= 0, "archiveGoal must exist");
    assert.ok(extrasSpread > archiveStart, "archiveGoal must include extras");
    assert.ok(extrasSpread < idField, "extras must come before id so id cannot be overridden");
    assert.ok(extrasSpread < outcomeField, "extras must come before outcome so outcome cannot be overridden");
    assert.ok(extrasSpread < archivedAtField, "extras must come before archivedAt so archivedAt cannot be overridden");
  });

  it("documents every lifecycle control and durable state path", async () => {
    const text = await fileText(commandPath);

    for (const requiredTerm of ["pause", "resume", "complete", "clear", "--tokens", "goal-state/goals.json", "Stop hook"]) {
      assert.match(text, new RegExp(requiredTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("does not keep a same-name skill that could shadow the command", async () => {
    const entries = await readdir(skillDirPath, { recursive: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });

    assert.equal(entries.some((entry) => entry.replaceAll("\\", "/") === "goal/SKILL.md"), false);
  });

  it("keeps runtime goal state out of version control", async () => {
    const text = await fileText(gitignorePath);

    assert.match(text, /^goal-state\/goals\.json$/m);
    assert.match(text, /^goal-state\/\*\.tmp$/m);
    assert.match(text, /^goal-state\/\*\.lock$/m);
  });

  it("sets, reports, pauses, resumes, completes, and clears a goal", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "--tokens", "98.5K", "ship the thing"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Action: set/);
      assert.match(result.stdout, /Token budget: 98.5K/);
      assert.match(result.stdout, /<objective>\nship the thing\n<\/objective>/);

      result = runHelper(dbPath, ["status"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Status: active/);

      result = runHelper(dbPath, ["pause"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Status: paused/);

      result = runHelper(dbPath, ["resume"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Status: active/);

      result = runHelper(dbPath, ["complete"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Status: complete/);

      result = runHelper(dbPath, ["clear"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Goal cleared/);
    });
  });

  it("rejects malformed, oversized, and duplicate active goals", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "--tokens"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /requires a value/);

      result = runHelper(dbPath, ["invoke", "first goal"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["invoke", "second goal"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /already has a goal/);
      assert.match(result.stderr, /CLAUDE_GOAL_SESSION_ID/);

      result = runHelper(dbPath, ["clear"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["invoke", "x".repeat(4001)]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /too long/);
    });
  });

  it("recovers from a corrupt goals.json by quarantining and starting fresh", async () => {
    await withTempGoalDb(async (dbPath, dir) => {
      await writeFile(dbPath, "{ this is not valid json :::");

      const result = runHelper(dbPath, ["invoke", "post-corrupt goal"]);
      assert.equal(result.status, 0, `invoke after corrupt should succeed: ${result.stderr}`);
      assert.match(result.stderr, /goals\.json was unreadable.*quarantined/);

      const status = runHelper(dbPath, ["status", "--json"]);
      assert.equal(status.status, 0, status.stderr);
      const parsed = JSON.parse(status.stdout);
      assert.equal(parsed.objective, "post-corrupt goal");

      const entries = await readdir(dir);
      assert.ok(
        entries.some((name) => name.startsWith("goals.json.corrupt-")),
        `quarantine file expected in ${dir}, got ${entries.join(", ")}`
      );
    });
  });

  it("prunes old corrupt quarantine files after recovering state", async () => {
    await withTempGoalDb(async (dbPath, dir) => {
      for (let i = 0; i < 12; i += 1) {
        await writeFile(path.join(dir, `goals.json.corrupt-2026-01-01T00-00-${String(i).padStart(2, "0")}`), "{}");
      }
      await writeFile(dbPath, "{ invalid");

      const result = runHelper(dbPath, ["invoke", "recover and prune"]);
      assert.equal(result.status, 0, result.stderr);

      const quarantines = (await readdir(dir)).filter((name) => name.startsWith("goals.json.corrupt-"));
      assert.ok(quarantines.length <= 10, `expected at most 10 corrupt files, got ${quarantines.length}`);
    });
  });

  it("tracks lastActivity and exposes idleSeconds in JSON", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "heartbeat goal"]);
      assert.equal(result.status, 0, result.stderr);
      const json = JSON.parse(runHelper(dbPath, ["status", "--json"]).stdout);
      assert.ok(typeof json.idleSeconds === "number" && json.idleSeconds >= 0 && json.idleSeconds < 5);
      assert.equal(json.idleWarning, false);
      assert.ok(json.lastActivityAt);
    });
  });

  it("/goal touch refreshes lastActivity and returns Action: touch", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "touchable"]);
      assert.equal(result.status, 0, result.stderr);

      const before = JSON.parse(await readFile(dbPath, "utf8"));
      const sessionKey = Object.keys(before.goals)[0];
      const oldActivity = before.goals[sessionKey].lastActivityAtMs;
      before.goals[sessionKey].lastActivityAtMs = oldActivity - 60_000;
      before.goals[sessionKey].lastActivityAt = new Date(oldActivity - 60_000).toISOString();
      await writeFile(dbPath, JSON.stringify(before));

      result = runHelper(dbPath, ["touch"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Action: touch/);

      const after = JSON.parse(await readFile(dbPath, "utf8"));
      assert.ok(after.goals[sessionKey].lastActivityAtMs > oldActivity - 60_000);
    });
  });

  it("touch fails when no goal is set", async () => {
    await withTempGoalDb(async (dbPath) => {
      const result = runHelper(dbPath, ["touch"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /no goal is set/);
    });
  });

  it("status and continuation surface an idle warning past the threshold", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "idle goal"]);
      assert.equal(result.status, 0, result.stderr);

      const db = JSON.parse(await readFile(dbPath, "utf8"));
      const sessionKey = Object.keys(db.goals)[0];
      db.goals[sessionKey].lastActivityAtMs = Date.now() - 7200_000;
      db.goals[sessionKey].lastActivityAt = new Date(Date.now() - 7200_000).toISOString();
      await writeFile(dbPath, JSON.stringify(db));

      result = runHelper(dbPath, ["status"], {
        env: { CLAUDE_GOAL_IDLE_WARN_SEC: "300" }
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Idle: \d+h\d*m? \(idle warning: > 5m\)/);
      assert.match(result.stdout, /idle for/);

      const json = JSON.parse(runHelper(dbPath, ["status", "--json"], {
        env: { CLAUDE_GOAL_IDLE_WARN_SEC: "300" }
      }).stdout);
      assert.equal(json.idleWarning, true);
      assert.ok(json.idleSeconds > 300);
    });
  });

  it("Stop-hook continuation reason includes idle push when stale", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "idle stop-hook"]);
      assert.equal(result.status, 0, result.stderr);

      const db = JSON.parse(await readFile(dbPath, "utf8"));
      const sessionKey = Object.keys(db.goals)[0];
      db.goals[sessionKey].lastActivityAtMs = Date.now() - 7200_000;
      db.goals[sessionKey].lastActivityAt = new Date(Date.now() - 7200_000).toISOString();
      await writeFile(dbPath, JSON.stringify(db));

      result = runHelper(dbPath, ["stop-hook"], {
        env: { CLAUDE_GOAL_IDLE_WARN_SEC: "300" },
        input: JSON.stringify({ session_id: "test-session", cwd: root, hook_event_name: "Stop" })
      });
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.match(parsed.reason, /had been idle for/);
    });
  });

  it("serializes concurrent mutations so no notes are lost", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "race host"]);
      assert.equal(result.status, 0, result.stderr);

      const env = {
        ...process.env,
        CLAUDE_GOAL_DB: dbPath,
        CLAUDE_GOAL_SESSION_ID: "test-session"
      };
      const labels = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
      const procs = labels.map((label) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [helperPath, "note", label], { env });
          child.on("exit", (code) => resolve(code));
        })
      );
      const codes = await Promise.all(procs);
      for (const code of codes) assert.equal(code, 0, "concurrent note must succeed");

      const json = JSON.parse(runHelper(dbPath, ["status", "--json"]).stdout);
      assert.equal(json.notes.length, labels.length);
      const got = json.notes.map((n) => n.text).sort();
      assert.deepEqual(got, [...labels].sort());
    });
  });

  it("caps notes per goal at 200, dropping the oldest", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "cap host"]);
      assert.equal(result.status, 0, result.stderr);

      const db = JSON.parse(await readFile(dbPath, "utf8"));
      const sessionKey = Object.keys(db.goals)[0];
      db.goals[sessionKey].notes = Array.from({ length: 200 }, (_, i) => ({
        at: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
        text: `note-${i}`
      }));
      await writeFile(dbPath, JSON.stringify(db));

      result = runHelper(dbPath, ["note", "after-cap"]);
      assert.equal(result.status, 0, result.stderr);

      const json = JSON.parse(runHelper(dbPath, ["status", "--json"]).stdout);
      assert.equal(json.notes.length, 200, "note count must stay capped at 200");
      assert.equal(json.notes[0].text, "note-1", "oldest note must be dropped");
      assert.equal(json.notes[199].text, "after-cap", "newest note must be retained");
    });
  });

  it("steals a stale lock and recovers", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "stale host"]);
      assert.equal(result.status, 0, result.stderr);

      const lockPath = `${dbPath}.lock`;
      await writeFile(lockPath, JSON.stringify({ pid: 999999, startedAt: 0 }));

      result = runHelper(dbPath, ["note", "after-stale"], {
        // shrink stale threshold and timeout so test runs fast
        env: { CLAUDE_GOAL_LOCK_STALE_MS: "1", CLAUDE_GOAL_LOCK_TIMEOUT_MS: "1000" }
      });
      assert.equal(result.status, 0, result.stderr);
      const json = JSON.parse(runHelper(dbPath, ["status", "--json"]).stdout);
      assert.equal(json.notes.at(-1).text, "after-stale");
    });
  });

  it("times out when the lock is held by a fresh holder", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "lock host"]);
      assert.equal(result.status, 0, result.stderr);

      const lockPath = `${dbPath}.lock`;
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

      result = runHelper(dbPath, ["note", "should-fail"], {
        env: { CLAUDE_GOAL_LOCK_STALE_MS: "60000", CLAUDE_GOAL_LOCK_TIMEOUT_MS: "150" }
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /could not acquire goal-state lock/);
      await rm(lockPath);
    });
  });

  it("accepts --deadline at set time and surfaces remaining time in status", async () => {
    await withTempGoalDb(async (dbPath) => {
      const result = runHelper(dbPath, ["invoke", "--deadline", "1h30m", "deadline goal"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Deadline: 1h30m \(1h\d*m? remaining\)/);

      const json = JSON.parse(runHelper(dbPath, ["status", "--json"]).stdout);
      assert.equal(json.deadlineSeconds, 5400);
      assert.match(json.deadlineState, /remaining/);
    });
  });

  it("Stop-hook continuation reason surfaces deadline status and overdue triage", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "--deadline", "60", "stop hook deadline"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["stop-hook"], {
        input: JSON.stringify({ session_id: "test-session", cwd: root, hook_event_name: "Stop" })
      });
      assert.equal(result.status, 0, result.stderr);
      let parsed = JSON.parse(result.stdout);
      assert.match(parsed.reason, /Deadline: 1m \(.+remaining\)/);

      const db = JSON.parse(await readFile(dbPath, "utf8"));
      const sessionKey = Object.keys(db.goals)[0];
      db.goals[sessionKey].timeUsedMs = 600_000;
      db.goals[sessionKey].activeStartedAtMs = Date.now();
      await writeFile(dbPath, JSON.stringify(db));

      result = runHelper(dbPath, ["stop-hook"], {
        input: JSON.stringify({ session_id: "test-session", cwd: root, hook_event_name: "Stop" })
      });
      assert.equal(result.status, 0, result.stderr);
      parsed = JSON.parse(result.stdout);
      assert.match(parsed.reason, /OVERDUE/);
      assert.match(parsed.reason, /past its soft deadline/);
    });
  });

  it("renders OVERDUE and adds a triage push when the deadline has elapsed", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "--deadline", "60", "soon overdue"]);
      assert.equal(result.status, 0, result.stderr);

      const db = JSON.parse(await readFile(dbPath, "utf8"));
      const sessionKey = Object.keys(db.goals)[0];
      db.goals[sessionKey].timeUsedMs = 120_000;
      db.goals[sessionKey].activeStartedAtMs = null;
      db.goals[sessionKey].status = "paused";
      await writeFile(dbPath, JSON.stringify(db));

      result = runHelper(dbPath, ["resume"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Deadline: 1m \(OVERDUE by/);
      assert.match(result.stdout, /past its soft deadline/);
    });
  });

  it("extend can adjust the deadline and combine both flags", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "--tokens", "100K", "combo goal"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["extend", "--deadline", "2h"]);
      assert.equal(result.status, 0, result.stderr);
      let json = JSON.parse(runHelper(dbPath, ["status", "--json"]).stdout);
      assert.equal(json.deadlineSeconds, 7200);
      assert.equal(json.tokenBudget, 100_000);

      result = runHelper(dbPath, ["extend", "--tokens", "1M", "--deadline", "4h"]);
      assert.equal(result.status, 0, result.stderr);
      json = JSON.parse(runHelper(dbPath, ["status", "--json"]).stdout);
      assert.equal(json.tokenBudget, 1_000_000);
      assert.equal(json.deadlineSeconds, 14_400);
    });
  });

  it("extend with no flags now mentions both options", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "host"]);
      assert.equal(result.status, 0, result.stderr);
      result = runHelper(dbPath, ["extend"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /provide --tokens N or --deadline D/);
    });
  });

  it("rejects invalid duration strings", async () => {
    await withTempGoalDb(async (dbPath) => {
      for (const bad of ["abc", "0m", "0", "30x", "1h2"]) {
        const result = runHelper(dbPath, ["invoke", "--deadline", bad, "x"]);
        assert.notEqual(result.status, 0, `should reject duration: ${bad}`);
        assert.match(result.stderr, /(invalid duration|must be positive)/);
      }
    });
  });

  it("archives the deadline with the goal in history", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "--deadline", "45m", "archive me"]);
      assert.equal(result.status, 0, result.stderr);
      result = runHelper(dbPath, ["complete"]);
      assert.equal(result.status, 0, result.stderr);

      const json = JSON.parse(runHelper(dbPath, ["history", "--json"]).stdout);
      assert.equal(json.length, 1);
      assert.equal(json[0].deadlineSeconds, 2700);
    });
  });

  it("extend updates the token budget without resetting the active goal", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "--tokens", "100K", "growable goal"]);
      assert.equal(result.status, 0, result.stderr);
      const beforeId = JSON.parse(runHelper(dbPath, ["status", "--json"]).stdout).id;

      result = runHelper(dbPath, ["extend", "--tokens", "500K"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Action: extend/);
      assert.match(result.stdout, /Token budget: 500K/);

      const after = JSON.parse(runHelper(dbPath, ["status", "--json"]).stdout);
      assert.equal(after.id, beforeId, "extend must not replace the goal");
      assert.equal(after.tokenBudget, 500000);
      assert.equal(after.status, "active");
    });
  });

  it("extend rejects bad input and a missing or completed goal", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["extend", "--tokens", "200K"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /no goal is set/);

      result = runHelper(dbPath, ["invoke", "host"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["extend"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /provide --tokens N/);

      result = runHelper(dbPath, ["extend", "extra-junk"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unexpected argument/);

      result = runHelper(dbPath, ["complete"]);
      assert.equal(result.status, 0, result.stderr);
      result = runHelper(dbPath, ["extend", "--tokens", "1M"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /cannot extend a completed goal/);
    });
  });

  it("abort archives the goal with reason and clears active state", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "doomed goal"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["abort", "blocked", "by", "missing", "credentials"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Goal aborted: blocked by missing credentials/);

      result = runHelper(dbPath, ["status"]);
      assert.match(result.stdout, /No goal is currently set/);

      result = runHelper(dbPath, ["history"]);
      assert.match(result.stdout, /\[aborted\].+doomed goal.+\(blocked by missing credentials\)/);

      const db = JSON.parse(await readFile(dbPath, "utf8"));
      assert.equal(db.history[0].outcome, "aborted");
      assert.equal(db.history[0].reason, "blocked by missing credentials");
    });
  });

  it("abort rejects empty reason and a missing goal", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["abort", "no goal yet"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /no goal is set/);

      result = runHelper(dbPath, ["invoke", "host"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["abort"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /reason must not be empty/);
    });
  });

  it("refuses lifecycle mutations after a goal is completed", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "closed goal"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["complete"]);
      assert.equal(result.status, 0, result.stderr);

      for (const op of ["pause", "resume", "complete"]) {
        const r = runHelper(dbPath, [op]);
        assert.notEqual(r.status, 0, `${op} should fail after completion`);
        assert.match(r.stderr, /goal is already complete/);
      }

      result = runHelper(dbPath, ["abort", "too late"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /cannot abort a completed goal/);

      let db = JSON.parse(await readFile(dbPath, "utf8"));
      assert.equal(db.history.length, 1, "completed goal should only be archived once");
      assert.equal(db.history[0].outcome, "complete");

      result = runHelper(dbPath, ["clear"]);
      assert.equal(result.status, 0, result.stderr);

      db = JSON.parse(await readFile(dbPath, "utf8"));
      assert.equal(db.history.length, 1, "clearing a completed goal should not duplicate history");
      assert.deepEqual(db.goals, {});
    });
  });

  it("status --json emits machine-readable output and null when no goal exists", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["status", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout), null);

      result = runHelper(dbPath, ["invoke", "--tokens", "75K", "json goal"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["status", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.objective, "json goal");
      assert.equal(parsed.status, "active");
      assert.equal(parsed.tokenBudget, 75000);
      assert.ok(Array.isArray(parsed.notes));
      assert.equal(typeof parsed.timeUsedSeconds, "number");
    });
  });

  it("history --json emits an array of archived goals", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["history", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), []);

      result = runHelper(dbPath, ["invoke", "json archived"]);
      assert.equal(result.status, 0, result.stderr);
      result = runHelper(dbPath, ["complete"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["history", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].outcome, "complete");
      assert.equal(parsed[0].objective, "json archived");
    });
  });

  it("appends notes that surface in status, continuation, and archived history", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "noted goal"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["invoke", "note", "checkpoint one"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Action: note/);
      assert.match(result.stdout, /Notes \(1\):/);
      assert.match(result.stdout, /checkpoint one/);
      assert.match(result.stdout, /Recent progress notes:[\s\S]+checkpoint one/);

      result = runHelper(dbPath, ["note", "checkpoint two"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["status"]);
      assert.match(result.stdout, /Notes \(2\):[\s\S]+checkpoint one[\s\S]+checkpoint two/);

      result = runHelper(dbPath, ["complete"]);
      assert.equal(result.status, 0, result.stderr);
      const db = JSON.parse(await readFile(dbPath, "utf8"));
      assert.equal(db.history[0].outcome, "complete");
      assert.equal(db.history[0].notes.length, 2);
      assert.equal(db.history[0].notes[0].text, "checkpoint one");
      assert.equal(db.history[0].notes[1].text, "checkpoint two");
    });
  });

  it("rejects an empty note and a note when no goal exists", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["note", "stranded note"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /no goal is set/);

      result = runHelper(dbPath, ["invoke", "host goal"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["note"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must not be empty/);
    });
  });

  it("archives goals into history on complete and on clear", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "first archived"]);
      assert.equal(result.status, 0, result.stderr);
      result = runHelper(dbPath, ["complete"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["invoke", "second archived"]);
      assert.equal(result.status, 0, result.stderr);
      result = runHelper(dbPath, ["clear"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["history"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Goal history \(2 of 2\)/);
      assert.match(result.stdout, /\[cleared\].+second archived/);
      assert.match(result.stdout, /\[complete\].+first archived/);

      const db = JSON.parse(await readFile(dbPath, "utf8"));
      assert.equal(db.history.length, 2);
      assert.equal(db.history[0].outcome, "cleared");
      assert.equal(db.history[1].outcome, "complete");
    });
  });

  it("history command reports no archived goals on a fresh database", async () => {
    await withTempGoalDb(async (dbPath) => {
      const result = runHelper(dbPath, ["history"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /No archived goals/);
    });
  });

  it("history caps at 50 entries and accepts a custom limit", async () => {
    await withTempGoalDb(async (dbPath) => {
      const history = Array.from({ length: 60 }, (_, i) => ({
        id: `g${i}`,
        sessionId: "test-session",
        objective: `goal ${i}`,
        outcome: "complete",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedMs: 0,
        stopContinueCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        archivedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`
      }));
      await writeFile(dbPath, JSON.stringify({ version: 1, goals: {}, history }));

      let result = runHelper(dbPath, ["invoke", "trim trigger"]);
      assert.equal(result.status, 0, result.stderr);
      result = runHelper(dbPath, ["complete"]);
      assert.equal(result.status, 0, result.stderr);

      const db = JSON.parse(await readFile(dbPath, "utf8"));
      assert.equal(db.history.length, 50, "history should be capped at 50");

      result = runHelper(dbPath, ["history", "3"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Goal history \(3 of 50\)/);
    });
  });

  it("returns empty output from the Stop hook when no goal exists", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["stop-hook"], { input: "" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");

      result = runHelper(dbPath, ["stop-hook"], {
        input: JSON.stringify({ session_id: "x", cwd: root, hook_event_name: "Stop" })
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    });
  });

  it("preserves backslash-escaped double quotes in an objective", async () => {
    await withTempGoalDb(async (dbPath) => {
      const result = runHelper(dbPath, ["invoke", 'say \\"hi\\" softly']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /<objective>\nsay "hi" softly\n<\/objective>/);
    });
  });

  it("reads stdin objectives literally so nested quotes and newlines cannot break invocation", async () => {
    await withTempGoalDb(async (dbPath) => {
      const objective = `some loopholes were found "Other loopholes considered but not fixed\n(and why):\n- Same-cwd session collision -- documented fallback`;
      const result = runHelper(dbPath, ["invoke"], { input: objective });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /some loopholes were found "Other loopholes considered but not fixed/);
      assert.match(result.stdout, /\(and why\):/);
    });
  });

  it("renders Token budget: none when no budget is set", async () => {
    await withTempGoalDb(async (dbPath) => {
      const result = runHelper(dbPath, ["invoke", "no budget goal"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Token budget: none/);
    });
  });

  it("reports no goal and refuses lifecycle ops on an empty database", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["status"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /No goal is currently set/);

      result = runHelper(dbPath, ["clear"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /No goal to clear/);

      for (const op of ["pause", "resume", "complete"]) {
        const r = runHelper(dbPath, [op]);
        assert.notEqual(r.status, 0, `${op} should fail when no goal is set`);
        assert.match(r.stderr, /no goal is set/);
      }
    });
  });

  it("preserves internal spaces inside a quoted objective", async () => {
    await withTempGoalDb(async (dbPath) => {
      const result = runHelper(dbPath, ["invoke", '"keep    these    spaces"']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /<objective>\nkeep    these    spaces\n<\/objective>/);
    });
  });

  it("auto-pauses on alternate refusal phrasings", async () => {
    const phrases = [
      "I will not modify production data.",
      "I am blocked on a missing credential.",
      "I cannot continue productively without more context."
    ];
    for (const phrase of phrases) {
      await withTempGoalDb(async (dbPath) => {
        let result = runHelper(dbPath, ["invoke", "phrasing check"]);
        assert.equal(result.status, 0, result.stderr);

        result = runHelper(dbPath, ["stop-hook"], {
          input: JSON.stringify({
            session_id: "test-session",
            cwd: root,
            hook_event_name: "Stop",
            last_assistant_message: phrase
          })
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "", `phrase should auto-pause: ${phrase}`);

        result = runHelper(dbPath, ["status"]);
        assert.match(result.stdout, /Status: paused/, `phrase should leave goal paused: ${phrase}`);
      });
    }
  });

  it("does not auto-pause on incidental uses of the word blocked", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "false positive check"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["stop-hook"], {
        input: JSON.stringify({
          session_id: "test-session",
          cwd: root,
          hook_event_name: "Stop",
          last_assistant_message: "The blocked request path is covered by a regression test."
        })
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).decision, "block");

      result = runHelper(dbPath, ["status"]);
      assert.match(result.stdout, /Status: active/);
    });
  });

  it("migrates legacy state by dropping the unused events field on load", async () => {
    await withTempGoalDb(async (dbPath) => {
      await writeFile(dbPath, JSON.stringify({
        version: 1,
        goals: {},
        events: [
          { id: "legacy", sessionId: "x", goalId: null, name: "set", detail: null, createdAt: "2025-01-01T00:00:00Z", createdAtMs: 0 }
        ]
      }));

      const result = runHelper(dbPath, ["invoke", "post-migration goal"]);
      assert.equal(result.status, 0, result.stderr);

      const written = JSON.parse(await readFile(dbPath, "utf8"));
      assert.equal(Object.prototype.hasOwnProperty.call(written, "events"), false);
      assert.ok(written.goals);
    });
  });

  it("rejects a zero or negative token budget", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "--tokens", "0", "zero budget"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must be positive/);

      result = runHelper(dbPath, ["invoke", "--tokens", "0K", "zero suffix"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must be positive/);

      result = runHelper(dbPath, ["invoke", "--tokens", "-5K", "negative budget"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid token budget/);
    });
  });

  it("accepts the equals-form token budget and the --budget alias", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "--tokens=125K", "equals form goal"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Token budget: 125K/);
      assert.match(result.stdout, /<objective>\nequals form goal\n<\/objective>/);

      result = runHelper(dbPath, ["clear"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["invoke", "--budget", "2M", "alias goal"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Token budget: 2M/);
    });
  });

  it("allows setting a new goal after the previous one is completed", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "first goal"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["complete"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Status: complete/);

      result = runHelper(dbPath, ["invoke", "second goal"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Action: set/);
      assert.match(result.stdout, /<objective>\nsecond goal\n<\/objective>/);

      result = runHelper(dbPath, ["status"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Status: active/);
      assert.doesNotMatch(result.stdout, /first goal/);
    });
  });

  it("rejects a token-budget flag with no trailing objective", async () => {
    await withTempGoalDb(async (dbPath) => {
      const result = runHelper(dbPath, ["invoke", "--tokens", "100K"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must not be empty/);
    });
  });

  it("accepts apostrophes in objectives literally", async () => {
    await withTempGoalDb(async (dbPath) => {
      const result = runHelper(dbPath, ["invoke", "don't stop until tests pass"]);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /don't stop until tests pass/);
    });
  });

  it("rejects unknown one-word commands when a goal is already active", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "real objective"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["invoke", "pasue"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unknown \/goal command: pasue/);
    });
  });

  it("blocks Stop while active and allows Stop after pause", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "keep going"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["stop-hook"], {
        input: JSON.stringify({ session_id: "test-session", cwd: root, hook_event_name: "Stop" })
      });
      assert.equal(result.status, 0, result.stderr);
      const block = JSON.parse(result.stdout);
      assert.equal(block.decision, "block");
      assert.match(block.reason, /keep going/);

      result = runHelper(dbPath, ["pause"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["stop-hook"], {
        input: JSON.stringify({ session_id: "test-session", cwd: root, hook_event_name: "Stop" })
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    });
  });

  it("auto-pauses instead of looping after a refusal or hard blocker", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "do something unsafe"]);
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["stop-hook"], {
        input: JSON.stringify({
          session_id: "test-session",
          cwd: root,
          hook_event_name: "Stop",
          last_assistant_message: "I can't help with this request."
        })
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");

      result = runHelper(dbPath, ["status"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Status: paused/);
    });
  });

  it("enforces the Stop-hook continuation guard", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "guard me"], { maxStopContinues: "1" });
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["stop-hook"], {
        maxStopContinues: "1",
        input: JSON.stringify({ session_id: "test-session", cwd: root, hook_event_name: "Stop" })
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).decision, "block");

      result = runHelper(dbPath, ["stop-hook"], {
        maxStopContinues: "1",
        input: JSON.stringify({ session_id: "test-session", cwd: root, hook_event_name: "Stop" })
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "", "guard cap must allow the stop, not force another continuation");

      const json = JSON.parse(runHelper(dbPath, ["status", "--json"]).stdout);
      assert.equal(json.status, "paused");
      assert.ok(json.guardTrippedAt, "guardTrippedAt must be set");
      assert.equal(json.guardTrippedAtCount, 1);

      const next = runHelper(dbPath, ["stop-hook"], {
        maxStopContinues: "1",
        input: JSON.stringify({ session_id: "test-session", cwd: root, hook_event_name: "Stop" })
      });
      assert.equal(next.status, 0, next.stderr);
      assert.equal(next.stdout, "", "subsequent stop-hooks must keep allowing the stop on a paused goal");
    });
  });

  it("does not leak goals across explicit sessions", async () => {
    await withTempGoalDb(async (dbPath) => {
      let result = runHelper(dbPath, ["invoke", "session a goal"], { session: "session-a" });
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["status"], { session: "session-b" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /No goal is currently set/);
      assert.doesNotMatch(result.stdout, /session a goal/);

      result = runHelper(dbPath, ["stop-hook"], {
        session: "session-b",
        input: JSON.stringify({ session_id: "session-b", cwd: path.join(root, "different") })
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    });
  });

  it("keeps cwd fallback sessions stable without rotating hidden session files", async () => {
    await withTempGoalDb(async (dbPath, dir) => {
      const cwd = path.join(dir, "project");
      await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));

      let result = runHelper(dbPath, ["invoke", "cwd fallback goal"], { session: null, cwd });
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["status"], { session: null, cwd });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /cwd fallback goal/);

      const db = JSON.parse(await readFile(dbPath, "utf8"));
      const sessionKeys = Object.keys(db.goals);
      assert.equal(sessionKeys.length, 1);
      assert.match(sessionKeys[0], /^cwd:[a-f0-9]{16}$/);

      const files = await readdir(cwd);
      assert.deepEqual(files, []);
    });
  });

  it("stores plugin-installed runtime state in the current project directory", async () => {
    await withTempGoalDb(async (_dbPath, dir) => {
      const project = path.join(dir, "plugin-project");
      await import("node:fs/promises").then(({ mkdir }) => mkdir(project));

      const result = spawnSync(process.execPath, [pluginHelperPath, "invoke", "plugin state goal"], {
        cwd: project,
        text: true,
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_GOAL_SESSION_ID: "plugin-state-test"
        }
      });
      assert.equal(result.status, 0, result.stderr);

      const statePath = path.join(project, "goal-state", "goals.json");
      const db = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(db.goals["plugin-state-test"].objective, "plugin state goal");
    });
  });

  it("uses project-root state even when invoked from a subdirectory", async () => {
    await withTempGoalDb(async (dbPath, dir) => {
      const subdir = path.join(dir, "nested");
      await import("node:fs/promises").then(({ mkdir }) => mkdir(subdir));

      let result = runHelper(dbPath, ["invoke", "subdir goal"], {
        session: "subdir-session",
        cwd: subdir
      });
      assert.equal(result.status, 0, result.stderr);

      result = runHelper(dbPath, ["status"], {
        session: "subdir-session",
        cwd: root
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /subdir goal/);
    });
  });

  it("keeps repository text ASCII-only", async () => {
    const files = [
      commandPath,
      settingsPath,
      helperPath,
      marketplacePath,
      pluginCommandPath,
      pluginHelperPath,
      pluginHooksPath,
      pluginManifestPath,
      stateFormatPath,
      goalReadmePath,
      gitignorePath,
      path.join(root, "README.md"),
      path.join(root, "package.json"),
      path.join(root, "CONTRIBUTING.md"),
      path.join(root, "SECURITY.md"),
      path.join(root, "SMOKE_TEST.md")
    ];

    for (const file of files) {
      assert.doesNotMatch(await fileText(file), /[^\x00-\x7F]/, file);
    }
  });
});
