import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { compactionPoints, handle, hasNative1M, parseTokens, readContextUsage, shouldNudge } from '../scripts/lib.mjs';

let home;
let env;
const SESSION = 'test-session';

const assistant = (tokens, model = 'claude-sonnet-5-5', extra = {}) => JSON.stringify({
  type: 'assistant',
  ...extra,
  message: { model, usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0, output_tokens: 999 } },
});
const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } });

function transcript(...lines) {
  const file = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

const run = (hook, file, extra = {}) => handle({ hook_event_name: hook, session_id: SESSION, transcript_path: file, cwd: home, ...extra }, env);
const message = (result) => JSON.parse(result.stdout).systemMessage;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-test-'));
  env = { CLAUDE_CONFIG_DIR: home };
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

test('usage counts input and cache tokens, not output', () => {
  assert.equal(readContextUsage(transcript(assistant(5000))).tokens, 5000);
});

test('usage ignores subagent turns and reads the newest main turn', () => {
  const file = transcript(assistant(5000), assistant(90000, 'claude-haiku-5-5', { isSidechain: true }));
  assert.equal(readContextUsage(file).tokens, 5000);
});

test('usage from before a compaction is stale', () => {
  assert.equal(readContextUsage(transcript(assistant(180000), boundary)).tokens, 0);
  assert.equal(readContextUsage(transcript(assistant(180000), boundary, assistant(20000))).tokens, 20000);
});

test('a user message quoting usage JSON is not treated as a usage record', () => {
  const quote = JSON.stringify({ type: 'user', message: { content: '"usage" compact_boundary' } });
  assert.equal(readContextUsage(transcript(assistant(5000), quote)).tokens, 5000);
});

test('usage survives a missing transcript and malformed lines', () => {
  assert.equal(readContextUsage(path.join(home, 'nope.jsonl')).tokens, 0);
  assert.equal(readContextUsage(transcript('{"usage" broken', assistant(5000), '{"usage" broken')).tokens, 5000);
});

test('usage reads past a large tail when the last record is huge', () => {
  const huge = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(300 * 1024) } });
  assert.equal(readContextUsage(transcript(assistant(5000), huge)).tokens, 5000);
});

test('parseTokens handles the documented forms', () => {
  assert.equal(parseTokens(200000), 200000);
  assert.equal(parseTokens('500k'), 500000);
  assert.equal(parseTokens('1M'), 1000000);
  assert.equal(parseTokens('auto'), null);
  assert.equal(parseTokens(undefined), null);
});

test('native 1M detection follows the documented model list', () => {
  for (const model of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'us.anthropic.claude-opus-4-7-v1:0']) {
    assert.equal(hasNative1M(model), true, model);
  }
  for (const model of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-opus-4-20250514', 'claude-haiku-4-5', 'my-gateway-model', null]) {
    assert.equal(hasNative1M(model), false, model);
  }
});

test('compaction points use the documented defaults', () => {
  assert.deepEqual(compactionPoints({ model: 'claude-opus-5-5' }), { auto: 967000, idle: 200000, autoEnabled: true });
  assert.equal(compactionPoints({ model: 'claude-sonnet-4-6' }).auto, 200000);
  assert.equal(compactionPoints({ model: 'claude-opus-4-6', tokens: 400000 }).auto, 967000);
  assert.equal(compactionPoints({ model: 'claude-opus-5-5', env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } }).auto, 200000);
});

test('compaction window precedence: env, then per-model, then top-level', () => {
  const settings = [{ autoCompactWindow: 400000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: '500k' } } }];
  assert.equal(compactionPoints({ model: 'claude-opus-5-5', settings }).auto, 500000);
  assert.equal(compactionPoints({ model: 'claude-fable-5-1', settings }).auto, 400000);
  assert.equal(compactionPoints({ model: 'claude-opus-5-5', settings, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300k' } }).auto, 300000);
  assert.equal(compactionPoints({ model: 'claude-opus-5-5', settings, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200' } }).auto, 500000);
  assert.equal(compactionPoints({ model: 'claude-opus-5-5', settings: [{ autoCompactWindow: 'auto' }] }).auto, 967000);
  assert.equal(compactionPoints({ model: 'claude-sonnet-4-6', settings: [{ autoCompactWindow: 500000 }] }).auto, 200000);
});

test('idle compaction honours settings and its documented floor', () => {
  assert.equal(compactionPoints({ model: 'claude-opus-5-5', settings: [{ idleCompaction: false }] }).idle, Infinity);
  assert.equal(compactionPoints({ model: 'claude-opus-5-5', settings: [{ autoCompactEnabled: false }] }).idle, Infinity);
  assert.equal(compactionPoints({ model: 'claude-opus-5-5', env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '50000' } }).idle, 100000);
});

test('shouldNudge fires at the threshold, then only after further growth', () => {
  const args = { nudgeAt: 170000, step: 150000 };
  assert.equal(shouldNudge({ ...args, tokens: 169999, state: {} }), false);
  assert.equal(shouldNudge({ ...args, tokens: 170000, state: {} }), true);
  assert.equal(shouldNudge({ ...args, tokens: 300000, state: { lastNudgeTokens: 170000 } }), false);
  assert.equal(shouldNudge({ ...args, tokens: 320000, state: { lastNudgeTokens: 170000 } }), true);
  assert.equal(shouldNudge({ ...args, tokens: 180000, state: { harvestedAtTokens: 165000 } }), false);
});

test('Stop stays silent below the threshold', () => {
  assert.deepEqual(run('Stop', transcript(assistant(100000))), {});
});

test('Stop nudges once per threshold', () => {
  const file = transcript(assistant(172000));
  assert.match(message(run('Stop', file)), /172k tokens.*can compact from 200k.*\/harvest/);
  assert.deepEqual(run('Stop', file), {});
});

test('Stop message says the chat is past the idle point on a 1M model', () => {
  const file = transcript(assistant(320000, 'claude-opus-5-5'));
  assert.match(message(run('Stop', file)), /about an hour idle, or at about 967k/);
});

test('harvesting silences the nudge until the chat grows again', () => {
  run('UserPromptExpansion', transcript(assistant(172000)), { command_name: 'harvest', command_args: '' });
  assert.deepEqual(run('Stop', transcript(assistant(200000))), {});
  assert.ok(message(run('Stop', transcript(assistant(330000)))));
});

test('harvest through the Skill tool counts, under either name', () => {
  run('PostToolUse', transcript(assistant(172000)), { tool_name: 'Skill', tool_input: { skill: 'harvest:harvest' } });
  assert.deepEqual(run('Stop', transcript(assistant(180000))), {});
});

test('a dry run does not count as harvesting', () => {
  const file = transcript(assistant(172000));
  run('UserPromptExpansion', file, { command_name: 'harvest', command_args: 'dry' });
  run('PostToolUse', file, { tool_name: 'Skill', tool_input: { skill: 'harvest', args: 'preview' } });
  assert.ok(message(run('Stop', file)));
});

test('other skills do not count as harvesting', () => {
  const file = transcript(assistant(172000));
  run('PostToolUse', file, { tool_name: 'Skill', tool_input: { skill: 'harvester' } });
  assert.ok(message(run('Stop', file)));
});

test('/compact is held once, then goes through', () => {
  const file = transcript(assistant(60000));
  const first = run('PreCompact', file, { trigger: 'manual' });
  assert.equal(first.code, 2);
  assert.match(first.stderr, /\/harvest.*\/compact again/);
  assert.deepEqual(run('PreCompact', file, { trigger: 'manual' }), {});
});

test('/compact is not held after a harvest or on a short chat', () => {
  const file = transcript(assistant(60000));
  run('UserPromptExpansion', file, { command_name: 'harvest', command_args: '' });
  assert.deepEqual(run('PreCompact', file, { trigger: 'manual' }), {});
  fs.rmSync(path.join(home, 'harvest'), { recursive: true });
  assert.deepEqual(run('PreCompact', transcript(assistant(10000)), { trigger: 'manual' }), {});
});

test('the /compact guard can be turned off', () => {
  fs.mkdirSync(path.join(home, 'harvest'));
  fs.writeFileSync(path.join(home, 'harvest', 'config.json'), '{"guardManualCompact":false}');
  assert.deepEqual(run('PreCompact', transcript(assistant(60000)), { trigger: 'manual' }), {});
});

test('auto-compaction is never blocked, and tells the user afterwards', () => {
  const before = transcript(assistant(190000));
  assert.deepEqual(run('PreCompact', before, { trigger: 'auto' }), {});
  run('PostCompact', transcript(assistant(190000), boundary), { trigger: 'auto' });
  const after = transcript(assistant(190000), boundary, assistant(20000));
  assert.match(message(run('Stop', after)), /compacted before \/harvest ran/);
  assert.deepEqual(run('Stop', after), {});
});

test('no compaction notice when the chat was already harvested', () => {
  const before = transcript(assistant(190000));
  run('UserPromptExpansion', before, { command_name: 'harvest', command_args: '' });
  run('PreCompact', before, { trigger: 'auto' });
  run('PostCompact', transcript(assistant(190000), boundary), { trigger: 'auto' });
  assert.deepEqual(run('Stop', transcript(assistant(190000), boundary, assistant(20000))), {});
});

test('counting restarts after compaction', () => {
  const before = transcript(assistant(190000));
  run('UserPromptExpansion', before, { command_name: 'harvest', command_args: '' });
  run('PreCompact', before, { trigger: 'auto' });
  run('PostCompact', transcript(assistant(190000), boundary), { trigger: 'auto' });
  assert.ok(message(run('Stop', transcript(assistant(172000)))));
});

test('config can disable the plugin or set the threshold', () => {
  const dir = path.join(home, 'harvest');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), '{"nudgeAtTokens":50000}');
  assert.ok(message(run('Stop', transcript(assistant(60000)))));
  fs.writeFileSync(path.join(dir, 'config.json'), '{"enabled":false}');
  assert.deepEqual(run('Stop', transcript(assistant(400000))), {});
});

test('silent in an incognito session', () => {
  const dir = path.join(home, 'incognito', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SESSION}.json`), '{}');
  assert.deepEqual(run('Stop', transcript(assistant(400000))), {});
});

test('a session id cannot escape the state directory', () => {
  const file = transcript(assistant(172000));
  handle({ hook_event_name: 'Stop', session_id: '../../evil', transcript_path: file, cwd: home }, env);
  assert.equal(fs.existsSync(path.join(home, 'evil.json')), false);
});
