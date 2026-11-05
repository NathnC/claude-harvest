# claude-harvest

**Save what a Claude Code session learned before it's lost to compaction.** Type `/harvest` and Claude reviews the whole chat, keeps what's worth keeping (your corrections, preferences, project decisions, references, repo conventions) and writes it to memory files and `CLAUDE.md`. When a long chat gets close to compacting, the plugin reminds you to run it.

## Install: paste this into Claude Code

```text
Install the claude-harvest plugin for me from https://github.com/NathnC/claude-harvest.
1. Run: claude plugin marketplace add NathnC/claude-harvest
2. Run: claude plugin install harvest@claude-harvest
3. Check Node.js is on my PATH (node --version). The plugin's reminder hooks need it; tell me if it's missing.
4. Check whether I already have a personal skill at ~/.claude/skills/harvest. If I do, tell me it takes priority over the plugin's /harvest, and don't delete it.
5. Tell me to restart Claude Code, then summarise in two lines how to use /harvest.
```

Or type this at the Claude Code prompt:

```text
/plugin install harvest --marketplace NathnC/claude-harvest
```

Or install from a terminal:

```bash
claude plugin marketplace add NathnC/claude-harvest
claude plugin install harvest@claude-harvest
# then restart Claude Code
```

## Use

| Command | What it does |
|---|---|
| `/harvest` | Saves memories straight away and shows `CLAUDE.md` edits as a diff for you to approve. |
| `/harvest dry` | Shows what it would save and writes nothing. |
| `/harvest auto` | Applies `CLAUDE.md` edits without asking. |

It ends with a short report, including what it skipped and why, so you can catch a bad call:

```text
Memories:  2 new (feedback_x, project_y), 1 updated (project_z)
CLAUDE.md: 1 edit to ./CLAUDE.md (build command)
Skipped:   <thing> — already in git history; <thing> — one-off
```

Most sessions yield 0–3 entries, and zero is a valid result. It won't save anything the code, git history or an existing `CLAUDE.md` already records, and it won't save secrets.

`/harvest` works after a compaction too, because it reads the full transcript from disk.

## The reminders

Once a chat is big enough to compact soon, you'll see this under Claude's reply:

```text
Stop says: Harvest: this chat is at 172k tokens and it can compact from 200k. Run /harvest to save what it learned first.
```

The reminder is shown only to you, so it uses no tokens and Claude doesn't act on it.

| When | What happens |
|---|---|
| The chat reaches 85% of the earliest point it can compact | One reminder when Claude finishes a reply, repeated every 150k tokens of further growth |
| You run `/compact` with unsaved work | The first `/compact` is held with a reminder. Run it again to go ahead |
| The chat auto-compacted before you harvested | One notice after the next reply, saying `/harvest` still works. Auto-compaction is never blocked |
| You've run `/harvest` | No more reminders until the chat has grown by another 150k tokens. `/harvest dry` doesn't count |

### When a chat can compact

Claude Code doesn't tell hooks how full the context is or when it will compact, so the plugin works it out:

- **Context size** comes from the latest API usage in the session transcript. It's one reply behind at most.
- **Auto-compact point** comes from the [documented defaults](https://code.claude.com/docs/en/model-config.md#default-auto-compact-thresholds): about 967k on models with a native 1M window and 200k on older ones. It also reads `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_DISABLE_1M_CONTEXT`, and `autoCompactWindow` and `modelSettings` from your user and project settings.
- **Idle compaction** counts too. Claude Code can [compact a chat you've left for about an hour](https://code.claude.com/docs/en/settings-reference.md#idlecompaction) once it passes 200k tokens, so on a 1M model the first reminder comes at about 170k, not 820k. Set `"idleCompaction": false` in your settings and the reminders follow the auto-compact point instead.

## Config (optional)

Settings go in `~/.claude/harvest/config.json`:

```json
{
  "enabled": true,
  "nudgeAtTokens": 150000,
  "renudgeEveryTokens": 150000,
  "guardManualCompact": true
}
```

- `enabled: false` turns off all reminders. `/harvest` still works.
- `nudgeAtTokens` sets a fixed token count for the first reminder, replacing the calculated one.
- `renudgeEveryTokens` sets how much the chat must grow before the next reminder.
- `guardManualCompact: false` stops `/compact` being held.

## Limits

- **A reminder can only appear between replies.** A single long turn can compact before you see one. You'll get the notice afterwards instead.
- **The compaction point is an estimate.** The plugin can't see a window set with `claude --autocompact`, or `autoCompactWindow` in managed settings. If reminders come at the wrong time, set `nudgeAtTokens`.
- **Older models on `[1m]` variants** are treated as 200k until the chat passes 200k, because transcripts don't record the variant.
- **`/compact` with instructions:** if it's held, you'll need to type the instructions again.
- **`claude-incognito`:** reminders stay off in sessions running [incognito mode](https://github.com/NathnC/claude-incognito).
- Reminders need Node.js on `PATH`. Claude Code installed through npm already has it. `/harvest` itself doesn't need Node.

## Develop

```bash
node --test
claude --plugin-dir .
```

## Uninstall

```bash
claude plugin uninstall harvest@claude-harvest
claude plugin marketplace remove claude-harvest
```

Then delete `~/.claude/harvest/`. Memories and `CLAUDE.md` edits that `/harvest` wrote are yours to keep.

## License

MIT
