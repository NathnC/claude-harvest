---
name: harvest
description: Review the entire session so far, extract anything durable (user preferences, feedback/corrections, project state, references, repo conventions), and persist it — new/updated memory files plus targeted CLAUDE.md edits. Use when the user asks to save what was learned, consolidate the session, "remember this session", wrap up, or update CLAUDE.md from the conversation.
argument-hint: "[dry|auto]"
---

# Harvest

End-of-session consolidation. Read the whole conversation, decide what is worth keeping,
write it to the right place, and report what changed.

**Args:** `dry` / `preview` = report the plan, write nothing. `auto` / `yes` = apply CLAUDE.md
edits without asking. No args = write memories directly, confirm CLAUDE.md edits first.

Below, `~/.claude` means `$CLAUDE_CONFIG_DIR` if that is set.

## 1. Gather the session

Re-read the conversation from the first user message. Do not rely on impressions — go back
through it. You are looking for things that were *established*, not things that were merely
discussed. If an earlier harvest ran in this session, start from where it finished.

If the context was compacted (a summary appears in place of early turns), read the raw
transcript instead. It is the one file named `${CLAUDE_SESSION_ID}.jsonl` somewhere under
`~/.claude/projects/`:

```
Glob pattern '*/${CLAUDE_SESSION_ID}.jsonl' in ~/.claude/projects
```

Grep it for user turns rather than reading it whole, because it can be very large. Skip matches
that only hold a `tool_result`:

```
Grep pattern '"role":"user"' with output_mode content on that .jsonl
```

## 2. Classify each candidate

Walk the session and sort what you find. Most sessions yield 0–3 keepers. Zero is a valid
outcome — say so rather than manufacturing entries.

| Signal in the session | Destination |
|---|---|
| A correction: "don't do X", "stop doing Y", "always Z" — or an approach they explicitly endorsed | memory, `type: feedback` |
| Who they are: hardware, tooling, expertise, working style, standing preferences | memory, `type: user` |
| Ongoing work, decisions made, goals, constraints, state that outlives this session | memory, `type: project` |
| URLs, dashboards, IPs, hostnames, ticket links, absolute paths to external resources | memory, `type: reference` |
| How to build/test/run *this repo*, its conventions, invariants, gotchas | repo `CLAUDE.md` |
| Behavior that must hold in **every** repo (cross-repo tooling, infra reachable from anywhere) | `~/.claude/CLAUDE.md` |

**Do not save:**
- Anything derivable from the code, git history, or an existing CLAUDE.md
- Bugs you already fixed — the fix is in the code
- Detail that only mattered inside this conversation
- Restatements of default behavior ("write clean code", "run the tests")
- Secrets, tokens or passwords — record where they live, never their values

The test for a feedback memory: *would a fresh session get this wrong without it?* If no, skip it.

## 3. Dedupe before writing

Find the memory directory. Your system prompt gives its path; if it doesn't, use the `memory/`
folder next to this session's transcript. If auto-memory is turned off for this session, say so
and propose CLAUDE.md edits only.

Read `MEMORY.md` there, then read any existing file that looks even loosely related.

- Same subject already covered → **edit that file**, don't create a second one
- Existing memory now contradicted by this session → rewrite it, or delete it if it's simply wrong
- New subject → new file

Never end up with two files about one thing.

## 4. Write the memories

If your system prompt specifies a memory format, or the directory already has a filename
convention, follow that. Otherwise name the file `<type>_<short-slug>.md` and use:

```markdown
---
name: <short-kebab-case-slug>
description: <one line — this is what future-you reads to decide relevance>
metadata:
  type: user | feedback | project | reference
---

<The fact, stated so it is actionable without the conversation around it.>

**Why:** <the reason — for feedback and project entries this is the part that survives>

**How to apply:** <what to actually do differently next time>

Link related entries with [[their-name]].
```

Rules:
- Convert every relative date to an absolute one ("last week" → the actual date)
- One fact per file
- `**Why:**` / `**How to apply:**` are required for `feedback` and `project`, optional otherwise
- Then add exactly one line to `MEMORY.md`: `- [Title](file.md) — short hook`. Never put the
  memory's content in `MEMORY.md` — it is an index that loads every session.

## 5. Update CLAUDE.md

Pick the file by scope: repo-specific → `CLAUDE.md` in the project root (create it if the
learning genuinely warrants one). Cross-repo → the global file at `~/.claude/CLAUDE.md`. Keep the
global file small and pointer-based — add a pointer to a memory file rather than a wall of detail.

Edits must be surgical: extend an existing section if one fits, keep the surrounding voice, and
prefer replacing a stale line over appending a contradicting one. CLAUDE.md is loaded into every
future session in that repo — length is a real cost, so only content that changes behavior earns a line.

Unless invoked with `auto`, show the proposed CLAUDE.md changes as a diff and get a yes before applying.
Memory files you may write without asking.

## 6. Report

End with a compact summary — no prose padding:

```
Memories:  2 new (feedback_x, project_y), 1 updated (project_z)
CLAUDE.md: 1 edit to ./CLAUDE.md (build command)
Skipped:   <thing> — already in git history; <thing> — one-off
```

Naming what you skipped and why matters as much as what you saved — it is how the user catches
a bad judgment call.

## Notes

- Write only to the memory directory and CLAUDE.md files. Leave other plugins' stores alone
  (for example `.remember/`).
- Auto-memory only loads inside its own project directory. A learning that must apply everywhere
  belongs in the global CLAUDE.md, with the detail in a memory file it points to.
