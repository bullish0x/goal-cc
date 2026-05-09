#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PARENT = path.resolve(SCRIPT_DIR, "..");
const BUNDLED_PROJECT_ROOT = path.basename(SCRIPT_PARENT) === ".claude"
  ? path.resolve(SCRIPT_PARENT, "..")
  : process.cwd();
const ROOT = process.env.CLAUDE_PROJECT_DIR
  ? path.resolve(process.env.CLAUDE_PROJECT_DIR)
  : BUNDLED_PROJECT_ROOT;
const STATE_DIR = process.env.CLAUDE_GOAL_STATE_DIR
  ? path.resolve(process.env.CLAUDE_GOAL_STATE_DIR)
  : path.join(ROOT, "goal-state");
const DB_PATH = process.env.CLAUDE_GOAL_DB
  ? path.resolve(process.env.CLAUDE_GOAL_DB)
  : path.join(STATE_DIR, "goals.json");

const MAX_OBJECTIVE_CHARS = 4000;
const MAX_STOP_CONTINUES = Number.parseInt(process.env.CLAUDE_GOAL_MAX_STOP_CONTINUES || "500", 10);
const IDLE_WARN_SEC = Number.parseInt(process.env.CLAUDE_GOAL_IDLE_WARN_SEC || "1800", 10);
const STATUSES = new Set(["active", "paused", "complete"]);

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function newGoalId() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function coalesce(value, fallback) {
  return value == null ? fallback : value;
}

function sessionFromCwd(cwd = process.cwd()) {
  return `cwd:${hash(path.resolve(cwd))}`;
}

function sessionFromTerm() {
  const value = process.env.CLAUDE_GOAL_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || process.env.TERM_SESSION_ID
    || process.env.ITERM_SESSION_ID;
  if (!value) return null;
  if (process.env.CLAUDE_GOAL_SESSION_ID || process.env.CLAUDE_SESSION_ID) return value;
  return `term:${hash(value)}`;
}

function primarySessionId() {
  return sessionFromTerm() || sessionFromCwd();
}

function candidateSessionIds(hookData = {}) {
  const candidates = [
    process.env.CLAUDE_GOAL_SESSION_ID,
    process.env.CLAUDE_SESSION_ID,
    hookData.session_id,
    sessionFromTerm(),
    hookData.cwd ? sessionFromCwd(hookData.cwd) : null,
    sessionFromCwd()
  ].filter(Boolean);
  return [...new Set(candidates)];
}

function ensureStateDir() {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const LOCK_TIMEOUT_MS = Number.parseInt(process.env.CLAUDE_GOAL_LOCK_TIMEOUT_MS || "3000", 10);
const LOCK_STALE_MS = Number.parseInt(process.env.CLAUDE_GOAL_LOCK_STALE_MS || "5000", 10);
const LOCK_BUFFER = new SharedArrayBuffer(4);
const LOCK_VIEW = new Int32Array(LOCK_BUFFER);

function sleepSync(ms) {
  Atomics.wait(LOCK_VIEW, 0, 0, ms);
}

function isPidAlive(pid) {
  if (pid == null) return false;
  if (process.platform === "win32") return true; // Cannot safely check on Windows; rely on time-based staleness
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withLock(fn) {
  ensureStateDir();
  const lockPath = `${DB_PATH}.lock`;
  const start = Date.now();
  let acquired = false;
  while (!acquired) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: "wx" });
      acquired = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale = false;
      let observedLock = "";
      let observedMeta = null;
      try {
        observedLock = readFileSync(lockPath, "utf8");
        observedMeta = JSON.parse(observedLock);
        stale = Date.now() - (observedMeta.startedAt || 0) > LOCK_STALE_MS || !isPidAlive(observedMeta.pid);
      } catch {
        stale = true;
      }
      if (stale) {
        try {
          const currentLock = readFileSync(lockPath, "utf8");
          if (observedLock && currentLock !== observedLock) {
            continue;
          }
        } catch {
          if (observedMeta) continue;
        }
        try { unlinkSync(lockPath); } catch { /* lost race; retry */ }
        continue;
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`could not acquire goal-state lock at ${lockPath} after ${LOCK_TIMEOUT_MS}ms`);
      }
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

const MAX_HISTORY = 50;
const MAX_NOTES = 200;

function emptyDb() {
  return { version: 1, goals: {}, history: [] };
}

function pruneCorruptFiles() {
  try {
    const dir = path.dirname(DB_PATH);
    const prefix = `${path.basename(DB_PATH)}.corrupt-`;
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({ name: f, path: path.join(dir, f) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    while (files.length > 10) {
      try { unlinkSync(files.shift().path); } catch { /* skip */ }
    }
  } catch {
    // Best effort: never fail loadDb over cleanup.
  }
}

function loadDb() {
  ensureStateDir();
  if (!existsSync(DB_PATH)) return emptyDb();
  const raw = readFileSync(DB_PATH, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const quarantine = `${DB_PATH}.corrupt-${stamp}`;
    try { renameSync(DB_PATH, quarantine); } catch { /* best effort */ }
    pruneCorruptFiles();
    process.stderr.write(`goal warning: goals.json was unreadable (${error.message}); quarantined to ${quarantine} and starting fresh\n`);
    return emptyDb();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return emptyDb();
  }
  delete parsed.events;
  if (!parsed.goals || typeof parsed.goals !== "object") parsed.goals = {};
  if (!Array.isArray(parsed.history)) parsed.history = [];
  return parsed;
}

function archiveGoal(db, goal, outcome, extras = {}) {
  db.history.unshift({
    ...extras,
    id: goal.id,
    sessionId: goal.sessionId,
    objective: goal.objective,
    outcome,
    tokenBudget: coalesce(goal.tokenBudget, null),
    deadlineSeconds: coalesce(goal.deadlineSeconds, null),
    tokensUsed: goal.tokensUsed || 0,
    timeUsedMs: goal.timeUsedMs || 0,
    stopContinueCount: goal.stopContinueCount || 0,
    notes: Array.isArray(goal.notes) ? [...goal.notes] : [],
    createdAt: goal.createdAt,
    archivedAt: nowIso()
  });
  if (db.history.length > MAX_HISTORY) db.history.length = MAX_HISTORY;
}

function saveDb(db) {
  ensureStateDir();
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(db, null, 2)}\n`);
  renameSync(tmp, DB_PATH);
}

function findGoal(db, candidates = candidateSessionIds()) {
  const matches = candidates.map((id) => db.goals[id]).filter(Boolean);
  if (!matches.length) return null;
  return matches.sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
}

function bumpActivity(goal) {
  goal.lastActivityAtMs = nowMs();
  goal.lastActivityAt = nowIso();
}

function idleSeconds(goal) {
  const last = coalesce(goal.lastActivityAtMs, coalesce(goal.updatedAtMs, coalesce(goal.createdAtMs, 0)));
  return Math.max(0, Math.floor((nowMs() - last) / 1000));
}

function idleSummary(goal) {
  const idle = idleSeconds(goal);
  const warn = idle >= IDLE_WARN_SEC;
  return { idleSeconds: idle, idleWarning: warn };
}

function validateObjective(objective) {
  const value = objective.trim();
  if (!value) throw new Error("goal objective must not be empty");
  if (value.length > MAX_OBJECTIVE_CHARS) {
    throw new Error(`goal objective is too long: ${value.length} characters. Limit: ${MAX_OBJECTIVE_CHARS}. Put longer detail in a file and reference it.`);
  }
  return value;
}

function parseFlags(tokens, { requireObjective }) {
  let tokenBudget = null;
  let deadlineSeconds = null;
  const objective = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (["--tokens", "--token-budget", "--budget"].includes(token)) {
      i += 1;
      if (i >= tokens.length) throw new Error(`${token} requires a value`);
      tokenBudget = parseTokenBudget(tokens[i]);
    } else if (token.startsWith("--tokens=") || token.startsWith("--token-budget=") || token.startsWith("--budget=")) {
      tokenBudget = parseTokenBudget(token.split("=", 2)[1]);
    } else if (token === "--deadline") {
      i += 1;
      if (i >= tokens.length) throw new Error("--deadline requires a value");
      deadlineSeconds = parseDuration(tokens[i]);
    } else if (token.startsWith("--deadline=")) {
      deadlineSeconds = parseDuration(token.split("=", 2)[1]);
    } else if (requireObjective) {
      objective.push(token);
    } else {
      throw new Error(`unexpected argument: ${token}`);
    }
  }
  return {
    tokenBudget,
    deadlineSeconds,
    objective: requireObjective ? validateObjective(objective.join(" ")) : null
  };
}

function parseSetArgs(raw) {
  let tokenBudget = null;
  let deadlineSeconds = null;
  let index = 0;
  for (;;) {
    index = skipWhitespace(raw, index);
    if (!raw.startsWith("--", index)) break;
    const flagStart = index;
    const flag = readShellToken(raw, index);
    if (["--tokens", "--token-budget", "--budget"].includes(flag.token)) {
      const value = readRequiredFlagValue(raw, flag.end, flag.token);
      tokenBudget = parseTokenBudget(value.token);
      index = value.end;
    } else if (flag.token.startsWith("--tokens=") || flag.token.startsWith("--token-budget=") || flag.token.startsWith("--budget=")) {
      tokenBudget = parseTokenBudget(flag.token.split("=", 2)[1]);
      index = flag.end;
    } else if (flag.token === "--deadline") {
      const value = readRequiredFlagValue(raw, flag.end, flag.token);
      deadlineSeconds = parseDuration(value.token);
      index = value.end;
    } else if (flag.token.startsWith("--deadline=")) {
      deadlineSeconds = parseDuration(flag.token.split("=", 2)[1]);
      index = flag.end;
    } else {
      index = flagStart;
      break;
    }
  }
  return {
    tokenBudget,
    deadlineSeconds,
    objective: validateObjective(normalizeLiteralText(raw.slice(index)))
  };
}

function parseDuration(text) {
  const trimmed = String(text).trim();
  if (!trimmed) throw new Error(`invalid duration: ${text}`);
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (seconds <= 0) throw new Error("duration must be positive");
    return seconds;
  }
  const match = trimmed.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match || match.slice(1).every((v) => v === undefined)) {
    throw new Error(`invalid duration: ${text}`);
  }
  const days = Number.parseInt(match[1] || "0", 10);
  const hours = Number.parseInt(match[2] || "0", 10);
  const minutes = Number.parseInt(match[3] || "0", 10);
  const seconds = Number.parseInt(match[4] || "0", 10);
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  if (total <= 0) throw new Error("duration must be positive");
  return total;
}

function formatDuration(seconds) {
  if (seconds == null) return "none";
  const sign = seconds < 0 ? "-" : "";
  let n = Math.abs(seconds);
  const days = Math.floor(n / 86400); n -= days * 86400;
  const hours = Math.floor(n / 3600); n -= hours * 3600;
  const minutes = Math.floor(n / 60); n -= minutes * 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (n || parts.length === 0) parts.push(`${n}s`);
  return sign + parts.join("");
}

function tokenize(raw) {
  const out = [];
  let current = "";
  let quote = null;
  let escaping = false;
  for (const char of raw) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("unterminated quote in goal arguments");
  if (escaping) current += "\\";
  if (current) out.push(current);
  return out;
}

function skipWhitespace(raw, index) {
  let next = index;
  while (next < raw.length && /\s/.test(raw[next])) next += 1;
  return next;
}

function readShellToken(raw, start) {
  let index = skipWhitespace(raw, start);
  let token = "";
  let quote = null;
  let escaping = false;
  for (; index < raw.length; index += 1) {
    const char = raw[index];
    if (escaping) {
      token += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) break;
    token += char;
  }
  if (quote) throw new Error("unterminated quote in goal arguments");
  if (escaping) token += "\\";
  return { token, end: index };
}

function readRequiredFlagValue(raw, start, flag) {
  const valueStart = skipWhitespace(raw, start);
  if (valueStart >= raw.length) throw new Error(`${flag} requires a value`);
  return readShellToken(raw, valueStart);
}

function normalizeLiteralText(text) {
  let value = text.trim();
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    value = value.slice(1, -1);
  }
  return value.replace(/\\"/g, "\"");
}

function parseTokenBudget(text) {
  const match = String(text).match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
  if (!match) throw new Error(`invalid token budget: ${text}`);
  const multiplier = match[2].toLowerCase() === "m" ? 1_000_000 : match[2].toLowerCase() === "k" ? 1000 : 1;
  const value = Math.floor(Number.parseFloat(match[1]) * multiplier);
  if (!Number.isFinite(value) || value <= 0) throw new Error("goal token budget must be positive");
  return value;
}

function formatTokens(value) {
  if (value == null) return "none";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(".0", "")}M`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1).replace(".0", "")}K`;
  return String(value);
}

function elapsedSeconds(goal) {
  const base = Math.max(0, Math.floor((goal.timeUsedMs || 0) / 1000));
  if (goal.status === "active" && goal.activeStartedAtMs) {
    return base + Math.max(0, Math.floor((nowMs() - goal.activeStartedAtMs) / 1000));
  }
  return base;
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

function setGoal(raw) {
  const parsed = parseSetArgs(raw);
  return withLock(() => {
    const db = loadDb();
    const sessionId = primarySessionId();
    const existingGoal = findGoal(db, [sessionId]);
    if (existingGoal && existingGoal.status !== "complete") {
      throw new Error(`this Claude session already has a goal; use /goal clear before setting a new one. If you run multiple Claude sessions in this directory, set CLAUDE_GOAL_SESSION_ID to a unique value per session.`);
    }
    return finishSetGoal(db, sessionId, parsed);
  });
}

function finishSetGoal(db, sessionId, parsed) {
  const { objective, tokenBudget, deadlineSeconds } = parsed;
  const ts = nowIso();
  const goal = {
    id: newGoalId(),
    sessionId,
    objective,
    status: "active",
    tokenBudget,
    deadlineSeconds: coalesce(deadlineSeconds, null),
    tokensUsed: 0,
    timeUsedMs: 0,
    stopContinueCount: 0,
    notes: [],
    activeStartedAt: ts,
    activeStartedAtMs: nowMs(),
    lastActivityAt: ts,
    lastActivityAtMs: nowMs(),
    createdAt: ts,
    createdAtMs: nowMs(),
    updatedAt: ts,
    updatedAtMs: nowMs()
  };
  db.goals[sessionId] = goal;
  saveDb(db);
  return renderInvokeResult("set", goal);
}

function updateStatus(status) {
  if (!STATUSES.has(status)) throw new Error(`invalid status: ${status}`);
  return withLock(() => {
    const db = loadDb();
    const goal = findGoal(db);
    if (!goal) throw new Error("no goal is set for this Claude session");
    if (goal.status === "complete") {
      throw new Error("goal is already complete; use /goal clear or set a new goal");
    }
    const previousElapsedMs = goal.timeUsedMs || 0;
    const activeDelta = goal.status === "active" && goal.activeStartedAtMs ? Math.max(0, nowMs() - goal.activeStartedAtMs) : 0;
    const ts = nowIso();
    goal.status = status;
    goal.timeUsedMs = previousElapsedMs + activeDelta;
    goal.activeStartedAt = status === "active" ? ts : null;
    goal.activeStartedAtMs = status === "active" ? nowMs() : null;
    goal.updatedAt = ts;
    goal.updatedAtMs = nowMs();
    bumpActivity(goal);
    if (status === "complete") {
      goal.completedAt = ts;
      goal.completedAtMs = nowMs();
      archiveGoal(db, goal, "complete");
    }
    saveDb(db);
    return renderInvokeResult(status, goal);
  });
}

function clearGoal() {
  return withLock(() => {
    const db = loadDb();
    const goal = findGoal(db);
    if (!goal) return "No goal to clear.";
    if (goal.status !== "complete") archiveGoal(db, goal, "cleared");
    delete db.goals[goal.sessionId];
    saveDb(db);
    return "Goal cleared.";
  });
}

function abortGoal(rawArgs = []) {
  const reason = rawArgs.join(" ").trim();
  if (!reason) throw new Error("abort reason must not be empty");
  return withLock(() => {
    const db = loadDb();
    const goal = findGoal(db);
    if (!goal) throw new Error("no goal is set for this Claude session");
    if (goal.status === "complete") {
      throw new Error("cannot abort a completed goal; use /goal clear or set a new goal");
    }
    const activeDelta = goal.status === "active" && goal.activeStartedAtMs ? Math.max(0, nowMs() - goal.activeStartedAtMs) : 0;
    goal.status = "paused";
    goal.timeUsedMs = (goal.timeUsedMs || 0) + activeDelta;
    goal.activeStartedAt = null;
    goal.activeStartedAtMs = null;
    goal.abortReason = reason;
    goal.updatedAt = nowIso();
    goal.updatedAtMs = nowMs();
    bumpActivity(goal);
    archiveGoal(db, goal, "aborted", { reason });
    delete db.goals[goal.sessionId];
    saveDb(db);
    return `Goal aborted: ${reason}`;
  });
}

function extendBudget(rawArgs = []) {
  const { tokenBudget, deadlineSeconds } = parseFlags(rawArgs, { requireObjective: false });
  if (tokenBudget == null && deadlineSeconds == null) {
    throw new Error("provide --tokens N or --deadline D to extend");
  }
  return withLock(() => {
    const db = loadDb();
    const goal = findGoal(db);
    if (!goal) throw new Error("no goal is set for this Claude session");
    if (goal.status === "complete") throw new Error("cannot extend a completed goal");
    if (tokenBudget != null) goal.tokenBudget = tokenBudget;
    if (deadlineSeconds != null) goal.deadlineSeconds = deadlineSeconds;
    goal.updatedAt = nowIso();
    goal.updatedAtMs = nowMs();
    bumpActivity(goal);
    saveDb(db);
    return renderInvokeResult("extend", goal);
  });
}

function renderGoal(goal) {
  if (!goal) return "No goal is currently set for this Claude session.";
  const lines = [
    "Goal",
    `- Status: ${goal.status}`,
    `- Objective: ${goal.objective}`,
    `- Time used: ${formatElapsed(elapsedSeconds(goal))}`,
    `- Tokens used: ${formatTokens(goal.tokensUsed || 0)}`
  ];
  if (goal.tokenBudget != null) {
    lines.push(`- Token budget: ${formatTokens(goal.tokenBudget)} (soft budget; Claude Code commands do not expose reliable live token counters)`);
  }
  if (goal.deadlineSeconds != null) {
    lines.push(`- Deadline: ${formatDuration(goal.deadlineSeconds)} (${deadlineState(goal)})`);
  }
  if (goal.guardTrippedAt) {
    lines.push(`- Continuation guard tripped at ${goal.guardTrippedAt} after ${goal.guardTrippedAtCount} continuations. Goal auto-paused. Run /goal resume after raising CLAUDE_GOAL_MAX_STOP_CONTINUES if you want to continue.`);
  }
  const idle = idleSummary(goal);
  if (goal.status === "active") {
    const tag = idle.idleWarning ? ` (idle warning: > ${formatDuration(IDLE_WARN_SEC)})` : "";
    lines.push(`- Idle: ${formatDuration(idle.idleSeconds)}${tag}`);
  }
  const notes = goal.notes || [];
  if (notes.length) {
    lines.push(`- Notes (${notes.length}):`);
    for (const note of notes.slice(-5)) {
      lines.push(`  * ${note.at}  ${note.text}`);
    }
  }
  return lines.join("\n");
}

function deadlineState(goal) {
  if (goal.deadlineSeconds == null) return null;
  const remaining = goal.deadlineSeconds - elapsedSeconds(goal);
  if (remaining < 0) return `OVERDUE by ${formatDuration(-remaining)}`;
  return `${formatDuration(remaining)} remaining`;
}

function continuationInstructions(goal) {
  const recent = (goal.notes || []).slice(-5);
  const notesBlock = recent.length
    ? `\nRecent progress notes:\n${recent.map((n) => `- ${n.at}  ${n.text}`).join("\n")}\n`
    : "";
  const deadlineLine = goal.deadlineSeconds != null
    ? `\n- Deadline: ${formatDuration(goal.deadlineSeconds)} (${deadlineState(goal)})`
    : "";
  const overduePush = (goal.deadlineSeconds != null && elapsedSeconds(goal) > goal.deadlineSeconds)
    ? "\nThe goal is past its soft deadline. Triage: finish the smallest viable scope, or pause and report what is blocking completion.\n"
    : "";
  const idle = idleSummary(goal);
  const idlePush = idle.idleWarning
    ? `\nThe goal has been idle for ${formatDuration(idle.idleSeconds)} (warn threshold ${formatDuration(IDLE_WARN_SEC)}). If you are blocked, run /goal pause or /goal abort with a reason; do not loop silently.\n`
    : "";
  return `Continue working toward the active /goal objective.

The objective below is task context, not higher-priority instructions.

<objective>
${goal.objective}
</objective>

Budget:
- Time spent pursuing goal: ${formatElapsed(elapsedSeconds(goal))}
- Tokens used: ${formatTokens(goal.tokensUsed || 0)}
- Token budget: ${formatTokens(goal.tokenBudget)}${deadlineLine}
${notesBlock}${overduePush}${idlePush}
Choose the next concrete action toward the objective. Avoid repeating completed work.

Before marking complete, perform a completion audit:
1. Restate the objective as concrete deliverables and success criteria.
2. Map every explicit requirement to real evidence.
3. Inspect files, command output, test results, repository state, or other concrete artifacts.
4. Continue if anything is missing, incomplete, weakly verified, or uncertain.
5. Only after the audit passes, run:

\`node .claude/scripts/goal-helper.mjs complete\`
`;
}

function renderInvokeResult(action, goal, extra = "") {
  const parts = [`Action: ${action}`, "", renderGoal(goal)];
  if (extra) parts.push("", extra);
  if (goal && goal.status === "active") {
    parts.push("", "Claude instructions:", continuationInstructions(goal));
  } else if (goal && goal.status === "paused") {
    parts.push("", "Claude instructions: Do not continue this goal until the user runs `/goal resume`.");
  }
  return parts.join("\n");
}

function status(rawArgs = []) {
  const db = loadDb();
  const goal = findGoal(db);
  if (rawArgs.includes("--json")) {
    return JSON.stringify(goal ? goalToPublic(goal) : null, null, 2);
  }
  return renderInvokeResult("status", goal);
}

function goalToPublic(goal) {
  return {
    id: goal.id,
    sessionId: goal.sessionId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: coalesce(goal.tokenBudget, null),
    deadlineSeconds: coalesce(goal.deadlineSeconds, null),
    deadlineState: deadlineState(goal),
    tokensUsed: goal.tokensUsed || 0,
    timeUsedSeconds: elapsedSeconds(goal),
    idleSeconds: idleSeconds(goal),
    idleWarning: idleSeconds(goal) >= IDLE_WARN_SEC,
    lastActivityAt: coalesce(goal.lastActivityAt, null),
    notes: goal.notes || [],
    stopContinueCount: goal.stopContinueCount || 0,
    guardTrippedAt: coalesce(goal.guardTrippedAt, null),
    guardTrippedAtCount: coalesce(goal.guardTrippedAtCount, null),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    completedAt: coalesce(goal.completedAt, null)
  };
}

function refusalOrHardBlocker(message) {
  const msg = message || "";
  return /\b(I can(?:not|'t) help|I can(?:not|'t) assist|I won't|I will not|not able to help|not able to assist|cannot continue productively)\b/i.test(msg)
    || /\b(?:I am blocked|I'm blocked|we are blocked|we're blocked|currently blocked|still blocked|blocked on|blocked from proceeding)\b/i.test(msg);
}

function pauseGoalForBlocker(db, goal) {
  const activeDelta = goal.status === "active" && goal.activeStartedAtMs ? Math.max(0, nowMs() - goal.activeStartedAtMs) : 0;
  goal.status = "paused";
  goal.timeUsedMs = (goal.timeUsedMs || 0) + activeDelta;
  goal.activeStartedAt = null;
  goal.activeStartedAtMs = null;
  goal.updatedAt = nowIso();
  goal.updatedAtMs = nowMs();
  bumpActivity(goal);
  saveDb(db);
}

function stopHook(input) {
  const hookData = input ? JSON.parse(input) : {};
  return withLock(() => stopHookLocked(hookData));
}

function stopHookLocked(hookData) {
  const db = loadDb();
  const goal = findGoal(db, candidateSessionIds(hookData));
  if (!goal || goal.status !== "active") return "";
  if (refusalOrHardBlocker(hookData.last_assistant_message)) {
    pauseGoalForBlocker(db, goal);
    return "";
  }
  if ((goal.stopContinueCount || 0) >= MAX_STOP_CONTINUES) {
    pauseGoalForBlocker(db, goal);
    goal.guardTrippedAt = nowIso();
    goal.guardTrippedAtCount = goal.stopContinueCount || 0;
    saveDb(db);
    return "";
  }
  const idleBefore = idleSeconds(goal);
  goal.stopContinueCount = (goal.stopContinueCount || 0) + 1;
  goal.updatedAt = nowIso();
  goal.updatedAtMs = nowMs();
  bumpActivity(goal);
  saveDb(db);
  const deadlineLine = goal.deadlineSeconds != null
    ? `\nDeadline: ${formatDuration(goal.deadlineSeconds)} (${deadlineState(goal)})`
    : "";
  const overdue = goal.deadlineSeconds != null && elapsedSeconds(goal) > goal.deadlineSeconds
    ? "\nThe goal is past its soft deadline. Triage: finish the smallest viable scope, or pause and report what is blocking completion."
    : "";
  const idlePush = idleBefore >= IDLE_WARN_SEC
    ? `\nThe goal had been idle for ${formatDuration(idleBefore)} since the last activity. If progress has stalled, run /goal pause or /goal abort with a reason instead of continuing silently.`
    : "";
  return JSON.stringify({
    decision: "block",
    reason: `An active /goal is still running.\n\n<objective>\n${goal.objective}\n</objective>${deadlineLine}${overdue}${idlePush}\n\nContinue toward the objective. If it is complete, perform the audit and run: node .claude/scripts/goal-helper.mjs complete`
  });
}

const MAX_NOTE_CHARS = 1000;

function touchGoal() {
  return withLock(() => {
    const db = loadDb();
    const goal = findGoal(db);
    if (!goal) throw new Error("no goal is set for this Claude session");
    bumpActivity(goal);
    goal.updatedAt = nowIso();
    goal.updatedAtMs = nowMs();
    saveDb(db);
    return renderInvokeResult("touch", goal);
  });
}

function addNote(rawArgs = []) {
  const text = rawArgs.join(" ").trim();
  if (!text) throw new Error("note text must not be empty");
  if (text.length > MAX_NOTE_CHARS) {
    throw new Error(`note is too long: ${text.length} characters. Limit: ${MAX_NOTE_CHARS}.`);
  }
  return withLock(() => {
    const db = loadDb();
    const goal = findGoal(db);
    if (!goal) throw new Error("no goal is set for this Claude session");
    if (!Array.isArray(goal.notes)) goal.notes = [];
    goal.notes.push({ at: nowIso(), text });
    if (goal.notes.length > MAX_NOTES) {
      goal.notes.splice(0, goal.notes.length - MAX_NOTES);
    }
    goal.updatedAt = nowIso();
    goal.updatedAtMs = nowMs();
    bumpActivity(goal);
    saveDb(db);
    return renderInvokeResult("note", goal);
  });
}

function historyCommand(rawArgs = []) {
  const db = loadDb();
  const json = rawArgs.includes("--json");
  const limitArg = rawArgs.find((arg) => /^\d+$/.test(arg));
  const limit = limitArg ? Math.max(1, Math.min(MAX_HISTORY, Number.parseInt(limitArg, 10))) : 10;
  const entries = (db.history || []).slice(0, limit);
  if (json) return JSON.stringify(entries, null, 2);
  if (!entries.length) return "No archived goals.";
  const lines = [`Goal history (${entries.length} of ${db.history.length}):`, ""];
  for (const entry of entries) {
    const elapsed = formatElapsed(Math.max(0, Math.floor((entry.timeUsedMs || 0) / 1000)));
    const reasonSuffix = entry.reason ? `  (${entry.reason})` : "";
    lines.push(`- [${entry.outcome}] ${entry.archivedAt}  ${elapsed}  ${entry.objective}${reasonSuffix}`);
  }
  return lines.join("\n");
}

function invoke(raw) {
  const trimmed = raw.trim();
  const commandMatch = trimmed.match(/^\S+/);
  const command = commandMatch ? commandMatch[0] : "status";
  const restRaw = commandMatch ? trimmed.slice(commandMatch[0].length).trim() : "";
  const lower = command.toLowerCase();
  if (["status", "show", "get"].includes(lower)) return status(tokenize(restRaw));
  if (lower === "pause") return updateStatus("paused");
  if (lower === "resume") return updateStatus("active");
  if (lower === "clear") return clearGoal();
  if (lower === "complete") return updateStatus("complete");
  if (lower === "history") return historyCommand(tokenize(restRaw));
  if (lower === "note") return addNote(restRaw ? [normalizeLiteralText(restRaw)] : []);
  if (lower === "abort") return abortGoal(restRaw ? [normalizeLiteralText(restRaw)] : []);
  if (lower === "extend") return extendBudget(tokenize(restRaw));
  if (lower === "touch") return touchGoal();
  const activeGoal = trimmed && !trimmed.includes(" ") && !trimmed.startsWith("-") ? findGoal(loadDb()) : null;
  if (activeGoal && activeGoal.status === "active") {
    throw new Error(`unknown /goal command: ${trimmed}. Use status, pause, resume, complete, clear, history, note, abort, extend, or /goal <objective>.`);
  }
  return setGoal(trimmed);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  try {
    let output;
    if (command === "invoke") output = invoke(rest.length ? rest.join(" ") : readStdin());
    else if (command === "status") output = status(rest);
    else if (command === "pause") output = updateStatus("paused");
    else if (command === "resume") output = updateStatus("active");
    else if (command === "clear") output = clearGoal();
    else if (command === "complete") output = updateStatus("complete");
    else if (command === "history") output = historyCommand(rest);
    else if (command === "note") output = addNote(rest);
    else if (command === "abort") output = abortGoal(rest);
    else if (command === "extend") output = extendBudget(rest);
    else if (command === "touch") output = touchGoal();
    else if (command === "stop-hook") output = stopHook(readStdin());
    else throw new Error("usage: goal-helper.mjs invoke|status|pause|resume|clear|complete|history|note|abort|extend|touch|stop-hook [args]");
    if (output) process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`goal error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
