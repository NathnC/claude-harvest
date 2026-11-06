// Decides when to remind the user to run /harvest before a chat compacts.
//
// Hook input doesn't report context usage, so the token count comes from the newest
// assistant `usage` record in the transcript. The compaction point isn't reported either,
// so it's worked out from the documented defaults and the user's settings:
// https://code.claude.com/docs/en/model-config.md#default-auto-compact-thresholds
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WINDOW_200K = 200_000;
const WINDOW_1M = 1_000_000;
const NATIVE_1M_AUTO_COMPACT = 967_000; // documented default for models with a native 1M window
const IDLE_COMPACT_DEFAULT = 200_000; // documented default for CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS
const NUDGE_FRACTION = 0.85;
const WORTH_SAVING = 30_000; // less unsaved context than this isn't worth interrupting for
const STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TAIL_SIZES = [256 * 1024, 4 * 1024 * 1024];
const HARVEST_SKILL = /^(harvest:)?harvest$/;
const PREVIEW_ARGS = /\b(dry|preview)\b/i;

export const DEFAULT_CONFIG = {
  enabled: true,
  nudgeAtTokens: null, // null = 85% of the earliest point this chat can compact
  renudgeEveryTokens: 150_000,
  guardManualCompact: true,
};

// ---- paths and files -------------------------------------------------------

const configDir = (env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const harvestDir = (env) => env.CLAUDE_HARVEST_HOME || path.join(configDir(env), 'harvest');

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

export function loadConfig(env) {
  return { ...DEFAULT_CONFIG, ...(readJSON(path.join(harvestDir(env), 'config.json')) || {}) };
}

function stateFile(env, sessionId) {
  if (!/^[\w-]+$/.test(sessionId || '')) return null;
  return path.join(harvestDir(env), 'state', `${sessionId}.json`);
}

function loadState(env, sessionId) {
  const file = stateFile(env, sessionId);
  return (file && readJSON(file)) || {};
}

function saveState(env, sessionId, state) {
  const file = stateFile(env, sessionId);
  if (!file) return;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) pruneState(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

function pruneState(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > STATE_MAX_AGE_MS) fs.unlinkSync(file);
    } catch {
      // Another session may be pruning at the same time.
    }
  }
}

// ---- reading context usage from the transcript -----------------------------

function readTail(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size: total } = fs.fstatSync(fd);
    const length = Math.min(size, total);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, total - length);
    const lines = buffer.toString('utf8').split('\n');
    if (length < total) lines.shift(); // The first line is probably cut off.
    return { lines, complete: length === total };
  } finally {
    fs.closeSync(fd);
  }
}

function scanForUsage(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"usage"') && !line.includes('compact_boundary')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    // Nothing has been measured since the last compaction, so the older usage is stale.
    if (record.type === 'system' && record.subtype === 'compact_boundary') return { tokens: 0, model: null };
    if (record.type !== 'assistant' || record.isSidechain) continue;
    const usage = record.message?.usage;
    if (!usage) continue;
    const tokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    if (tokens > 0) return { tokens, model: record.message.model || null };
  }
  return null;
}

// Returns the context size after the newest API call, or 0 tokens if it can't be read.
export function readContextUsage(transcriptPath) {
  try {
    for (const size of TAIL_SIZES) {
      const { lines, complete } = readTail(transcriptPath, size);
      const found = scanForUsage(lines);
      if (found) return found;
      if (complete) break;
    }
  } catch {
    // A missing or unreadable transcript reads as no usage.
  }
  return { tokens: 0, model: null };
}

// ---- working out when this chat can compact --------------------------------

export function parseTokens(value) {
  if (typeof value === 'number') return value > 0 ? value : null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(String(value ?? ''));
  if (!match) return null;
  const scale = { '': 1, k: 1_000, m: 1_000_000 }[match[2].toLowerCase()];
  return Number(match[1]) * scale || null;
}

export function hasNative1M(model) {
  const match = /(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(model || '');
  if (!match) return false;
  const [, family, major, minor = '0'] = match;
  const version = Number(major) + Number(minor) / 100;
  if (family === 'fable') return true;
  if (family === 'opus') return version >= 4.07;
  return version >= 5; // sonnet and haiku
}

function loadSettings(env, cwd) {
  const files = [
    cwd && path.join(cwd, '.claude', 'settings.local.json'),
    cwd && path.join(cwd, '.claude', 'settings.json'),
    path.join(configDir(env), 'settings.json'),
  ];
  return files.filter(Boolean).map(readJSON).filter(Boolean); // highest precedence first
}

function firstSetting(settings, pick) {
  for (const file of settings) {
    const value = pick(file);
    if (value !== undefined) return value;
  }
  return undefined;
}

function truthyEnv(value) {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

// Returns the token counts at which this chat auto-compacts and can idle-compact.
export function compactionPoints({ model, tokens = 0, env = {}, settings = [] }) {
  const pickWindow = (file) => file.modelSettings?.[model]?.autoCompactWindow ?? file.autoCompactWindow;
  const envWindow = parseTokens(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  const validEnvWindow = envWindow >= 100_000 && envWindow <= WINDOW_1M ? envWindow : null;
  const configured = validEnvWindow ?? parseTokens(firstSetting(settings, pickWindow));

  const disabled1M = truthyEnv(env.CLAUDE_CODE_DISABLE_1M_CONTEXT);
  const native1M = !disabled1M && hasNative1M(model);
  // An older model running past 200K must be on its [1m] variant, which transcripts don't show.
  const window = native1M || (!disabled1M && tokens >= WINDOW_200K) ? WINDOW_1M : WINDOW_200K;

  let auto = Math.min(configured ?? (window === WINDOW_1M ? NATIVE_1M_AUTO_COMPACT : WINDOW_200K), window);

  const autoEnabled = !truthyEnv(env.DISABLE_AUTO_COMPACT)
    && firstSetting(settings, (file) => file.autoCompactEnabled) !== false;
  const percent = Number(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
  if (autoEnabled && percent >= 1 && percent <= 100) auto = Math.min(auto, Math.round((window * percent) / 100));

  const idleEnabled = autoEnabled && firstSetting(settings, (file) => file.idleCompaction) !== false;
  const idle = idleEnabled
    ? Math.max(parseTokens(env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS) ?? IDLE_COMPACT_DEFAULT, 100_000)
    : Infinity;

  return { window, auto, idle, autoEnabled };
}

// ---- the decisions ---------------------------------------------------------

const unsavedTokens = (state, tokens) => tokens - (state.harvestedAtTokens || 0);

export function shouldNudge({ tokens, state, nudgeAt, step }) {
  if (tokens < nudgeAt) return false;
  const baseline = Math.max(state.lastNudgeTokens || 0, state.harvestedAtTokens || 0);
  return baseline === 0 || tokens - baseline >= step;
}

const kilo = (n) => (n >= WINDOW_1M ? `${n / WINDOW_1M}M` : `${Math.round(n / 1000)}k`);

export function nudgeMessage(tokens, { window, auto, idle, autoEnabled }) {
  let when;
  if (!autoEnabled) when = `Auto-compact is off, so it stops at the ${kilo(window)} limit`;
  else if (idle < auto && tokens >= idle) when = `It compacts at about ${kilo(auto)}, or after about an hour idle`;
  else if (idle < auto) when = `It compacts at about ${kilo(auto)}, or from ${kilo(idle)} if left idle for about an hour`;
  else when = `It compacts at about ${kilo(auto)}`;
  return `Harvest: this chat is at ${kilo(tokens)} of ${kilo(window)}. ${when}. Run /harvest to save what it learned first.`;
}

function isIncognito(env, sessionId) {
  return fs.existsSync(path.join(configDir(env), 'incognito', 'sessions', `${sessionId}.json`));
}

function onStop(input, env, config) {
  const state = loadState(env, input.session_id);

  if (state.compactedUnsaved) {
    saveState(env, input.session_id, { ...state, compactedUnsaved: false });
    return {
      stdout: JSON.stringify({
        systemMessage: 'Harvest: this chat compacted before /harvest ran. You can still run it: it reads the full transcript from disk.',
      }),
    };
  }

  const { tokens, model } = readContextUsage(input.transcript_path);
  if (!tokens) return {};

  const points = compactionPoints({ model, tokens, env, settings: loadSettings(env, input.cwd) });
  const earliest = Math.min(points.auto, points.idle);
  const nudgeAt = config.nudgeAtTokens ?? Math.round(earliest * NUDGE_FRACTION);
  if (!shouldNudge({ tokens, state, nudgeAt, step: config.renudgeEveryTokens })) return {};

  saveState(env, input.session_id, { ...state, lastNudgeTokens: tokens });
  return { stdout: JSON.stringify({ systemMessage: nudgeMessage(tokens, points) }) };
}

function onPreCompact(input, env, config) {
  const state = loadState(env, input.session_id);
  const { tokens } = readContextUsage(input.transcript_path);
  const unsaved = unsavedTokens(state, tokens) >= WORTH_SAVING;
  const next = { ...state, preCompactTokens: tokens };

  // A PreCompact hook can't show a message without blocking, so a deliberate /compact is
  // held once. Running /compact again goes through. Auto-compaction is never blocked,
  // because blocking it can fail the request when the context limit has been reached.
  if (input.trigger === 'manual' && config.guardManualCompact && unsaved && !state.guardedManual) {
    saveState(env, input.session_id, { ...next, guardedManual: true });
    return {
      code: 2,
      stderr: 'Harvest: nothing from this chat has been saved yet. Run /harvest first, or run /compact again to compact anyway.',
    };
  }
  saveState(env, input.session_id, next);
  return {};
}

function onPostCompact(input, env) {
  const state = loadState(env, input.session_id);
  const unsaved = unsavedTokens(state, state.preCompactTokens || 0) >= WORTH_SAVING;
  // Token counts restart after compaction, so the old baselines no longer apply.
  saveState(env, input.session_id, { compactedUnsaved: input.trigger === 'auto' && unsaved });
  return {};
}

function markHarvested(input, env) {
  const state = loadState(env, input.session_id);
  const { tokens } = readContextUsage(input.transcript_path);
  saveState(env, input.session_id, {
    ...state,
    harvestedAtTokens: tokens,
    compactedUnsaved: false,
    guardedManual: false,
  });
  return {};
}

// Returns { stdout, stderr, code }. The caller writes them out.
export function handle(input, env = process.env) {
  const config = loadConfig(env);
  if (!config.enabled || isIncognito(env, input.session_id)) return {};

  switch (input.hook_event_name) {
    case 'Stop':
      return onStop(input, env, config);
    case 'PreCompact':
      return onPreCompact(input, env, config);
    case 'PostCompact':
      return onPostCompact(input, env);
    case 'UserPromptExpansion':
      if (!HARVEST_SKILL.test(input.command_name || '') || PREVIEW_ARGS.test(input.command_args || '')) return {};
      return markHarvested(input, env);
    case 'PostToolUse':
      if (!HARVEST_SKILL.test(input.tool_input?.skill || '') || PREVIEW_ARGS.test(input.tool_input?.args || '')) return {};
      return markHarvested(input, env);
    default:
      return {};
  }
}
