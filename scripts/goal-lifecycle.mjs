#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(SCRIPT_DIR, "..");

const MANAGED_FILES = [
  [".claude/commands/goal.md", ".claude/commands/goal.md"],
  [".claude/scripts/goal-helper.mjs", ".claude/scripts/goal-helper.mjs"]
];

const SETTINGS_RELATIVE = ".claude/settings.json";

function usage() {
  return [
    "usage: node scripts/goal-lifecycle.mjs install|update|uninstall [--project DIR] [--force]",
    "",
    "install    Add the direct project /goal command, helper, and managed Stop hook.",
    "update     Refresh the direct project /goal command, helper, and managed Stop hook.",
    "uninstall  Remove managed direct project files and Stop hook.",
    "",
    "--project DIR  Target project directory. Defaults to the current working directory.",
    "--force        With uninstall, remove command/helper files even if they were customized."
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["install", "update", "uninstall"].includes(command)) {
    throw new Error(usage());
  }

  let projectDir = process.cwd();
  let force = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--project") {
      i += 1;
      if (i >= rest.length) throw new Error("--project requires a directory");
      projectDir = rest[i];
    } else if (arg.startsWith("--project=")) {
      projectDir = arg.slice("--project=".length);
    } else if (arg === "--force") {
      force = true;
    } else {
      throw new Error(`unexpected argument: ${arg}\n\n${usage()}`);
    }
  }

  return { command, projectDir: path.resolve(projectDir), force };
}

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function writeTextAtomic(filePath, text) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, filePath);
}

function readJsonIfPresent(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readText(filePath));
  } catch (error) {
    throw new Error(`cannot parse ${filePath}: ${error.message}. No files were changed.`);
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceStopHook() {
  const sourceSettings = JSON.parse(readText(path.join(SOURCE_ROOT, SETTINGS_RELATIVE)));
  const stopHooks = sourceSettings.hooks && Array.isArray(sourceSettings.hooks.Stop)
    ? sourceSettings.hooks.Stop.flatMap((entry) => Array.isArray(entry.hooks) ? entry.hooks : [])
    : [];
  const hook = stopHooks.find(isManagedGoalHook);
  if (!hook) throw new Error(`managed Stop hook not found in ${path.join(SOURCE_ROOT, SETTINGS_RELATIVE)}`);
  return cloneJson(hook);
}

function isManagedGoalHook(hook) {
  if (!hook || hook.type !== "command" || typeof hook.command !== "string") return false;
  return hook.command.includes("goal-helper.mjs")
    && (hook.command.includes(".claude") || hook.command.includes("CLAUDE_PROJECT_DIR"));
}

function sameHook(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function ensureObjectSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`${SETTINGS_RELATIVE} must contain a JSON object. No files were changed.`);
  }
  return settings;
}

function removeManagedStopHooks(settings) {
  const next = cloneJson(ensureObjectSettings(settings));
  if (!next.hooks || typeof next.hooks !== "object" || Array.isArray(next.hooks)) {
    return { settings: next, changed: false };
  }
  if (!Array.isArray(next.hooks.Stop)) {
    return { settings: next, changed: false };
  }

  let changed = false;
  const stop = [];
  for (const entry of next.hooks.Stop) {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) {
      stop.push(entry);
      continue;
    }
    const keptHooks = entry.hooks.filter((hook) => !isManagedGoalHook(hook));
    if (keptHooks.length !== entry.hooks.length) changed = true;
    if (keptHooks.length > 0) stop.push({ ...entry, hooks: keptHooks });
    else changed = true;
  }

  if (stop.length > 0) next.hooks.Stop = stop;
  else {
    delete next.hooks.Stop;
    changed = true;
  }
  if (Object.keys(next.hooks).length === 0) {
    delete next.hooks;
    changed = true;
  }
  return { settings: next, changed };
}

function addManagedStopHook(settings, hook) {
  const stripped = removeManagedStopHooks(settings).settings;
  const next = cloneJson(stripped);
  if (!next.hooks || typeof next.hooks !== "object" || Array.isArray(next.hooks)) next.hooks = {};
  if (!Array.isArray(next.hooks.Stop)) next.hooks.Stop = [];

  const alreadyPresent = next.hooks.Stop.some((entry) =>
    entry && Array.isArray(entry.hooks) && entry.hooks.some((candidate) => sameHook(candidate, hook))
  );
  if (!alreadyPresent) next.hooks.Stop.push({ hooks: [hook] });
  return next;
}

function copyManagedFiles(projectDir) {
  const copied = [];
  for (const [sourceRel, targetRel] of MANAGED_FILES) {
    const source = path.join(SOURCE_ROOT, sourceRel);
    const target = path.join(projectDir, targetRel);
    writeTextAtomic(target, readText(source));
    copied.push(targetRel);
  }
  return copied;
}

function removeManagedFiles(projectDir, { force }) {
  const removed = [];
  const skipped = [];
  for (const [sourceRel, targetRel] of MANAGED_FILES) {
    const source = path.join(SOURCE_ROOT, sourceRel);
    const target = path.join(projectDir, targetRel);
    if (!existsSync(target)) continue;
    const matchesSource = readText(target) === readText(source);
    if (!matchesSource && !force) {
      skipped.push(`${targetRel} (customized; re-run uninstall --force to remove)`);
      continue;
    }
    rmSync(target, { force: true });
    removed.push(targetRel);
  }
  return { removed, skipped };
}

function writeSettingsIfChanged(settingsPath, beforeText, nextSettings) {
  const nextText = stableJson(nextSettings);
  if (beforeText === nextText) return false;
  writeTextAtomic(settingsPath, nextText);
  return true;
}

function installOrUpdate(command, projectDir) {
  const settingsPath = path.join(projectDir, SETTINGS_RELATIVE);
  const beforeSettingsText = existsSync(settingsPath) ? readText(settingsPath) : "";
  const beforeSettings = readJsonIfPresent(settingsPath);
  const nextSettings = addManagedStopHook(beforeSettings, sourceStopHook());

  const settingsChanged = writeSettingsIfChanged(settingsPath, beforeSettingsText, nextSettings);
  const copied = copyManagedFiles(projectDir);

  return [
    `${command}: ${projectDir}`,
    `copied: ${copied.join(", ")}`,
    `settings: ${settingsChanged ? "updated managed Stop hook" : "already current"}`,
    "settings.local: untouched"
  ].join("\n");
}

function uninstall(projectDir, { force }) {
  const settingsPath = path.join(projectDir, SETTINGS_RELATIVE);
  const beforeSettingsText = existsSync(settingsPath) ? readText(settingsPath) : "";
  const beforeSettings = readJsonIfPresent(settingsPath);
  const removedSettings = removeManagedStopHooks(beforeSettings);
  const settingsChanged = writeSettingsIfChanged(settingsPath, beforeSettingsText, removedSettings.settings);
  const files = removeManagedFiles(projectDir, { force });

  const lines = [
    `uninstall: ${projectDir}`,
    `removed: ${files.removed.length ? files.removed.join(", ") : "none"}`,
    `settings: ${settingsChanged ? "removed managed Stop hook" : "no managed Stop hook found"}`,
    "settings.local: untouched"
  ];
  if (files.skipped.length) lines.push(`skipped: ${files.skipped.join("; ")}`);
  return lines.join("\n");
}

function main(argv) {
  try {
    const { command, projectDir, force } = parseArgs(argv);
    const output = command === "uninstall"
      ? uninstall(projectDir, { force })
      : installOrUpdate(command, projectDir);
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
