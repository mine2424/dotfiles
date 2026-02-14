---
name: prompt-forge
description: Turn rough requirements into a high-fidelity Codex task prompt using goal-seek + reverse-interview; outputs a copy-pastable prompt + DoD checklist; never edits code.
---

# Prompt Forge (for Codex)

## Purpose
Generate the best possible prompt to run Codex effectively from partial user input.
Do not implement code.
Do not run commands.
Only output a ready-to-use prompt package.

Codex works best when prompts include usable context (relevant files, constraints, outputs).
Reference: [OpenAI Developers - Codex Prompting](https://developers.openai.com/codex/prompting/)

## When to use
- User has an idea, bug, or feature request but instructions are vague.
- User wants a one-shot task prompt that Codex can execute reliably.
- User wants a repeatable workflow: clarify -> plan -> execute -> verify.

## When NOT to use
- User already has a complete, precise Codex task prompt.
- User asks to actually modify code or run tests (hand off to normal Codex workflow).

## Interaction Protocol (must follow)

### 0) Parse input into GCCO
Extract as much as possible into:
- Goal: final artifact or outcome
- Context: repo/app/domain background, current behavior, constraints
- Constraints: safety, style, scope, time, "do not touch"
- Output: expected format (diff, PR description, doc, checklist, JSON)

If any are missing, mark as `UNKNOWN`.

### 1) Goal-seek: enumerate required variables
List the minimal variable set needed to succeed with these buckets:
- Product/behavior: what should change, success criteria
- Surface area: target modules/files, APIs, UI screens
- Non-goals: what must not change
- Verification: how to prove it works (tests/commands/acceptance checks)
- Risk posture: minimal patch vs refactor allowed
- Output: what the user wants back (diff-only, explanation, steps)

### 2) Reverse-interview: ask prioritized questions (max 10)
Ask the most important missing questions first.
Rules:
- Include `Why it matters` in one short line for each question.
- Mix Yes/No and free-text questions.
- If user asked for no questions or time is tight:
- Ask at most 3 critical questions.
- Then proceed with clearly labeled assumptions.

### 3) Produce final deliverable: Codex Task Prompt
Output one prompt the user can paste into Codex.
The prompt must enforce:
- A short plan first (no thrashing).
- Explicit file touch list (`expected files to edit`).
- Verification steps (tests/commands) and DoD checklist.
- Clear boundaries (what NOT to do).
- Compact reporting format (what to include in final response).

### 4) Provide variants (optional but recommended)
Always output:
- Prompt A (Plan-only / Read-only): inspect and propose plan without changes.
- Prompt B (Execute): perform changes, run verification, summarize.

## Output Format (STRICT)

### Section 1: Clarifying Questions
- Up to 10 questions, prioritized.
- Provide an `Answer:` line under each.

### Section 2: Assumptions (if any)
- Bullet list labeled `ASSUMPTION`.
- If assumptions materially change approach, provide A/B branching.

### Section 3: Generated Prompts
Provide two copy-pastable prompts:

#### Prompt A: Plan-only
```text
<PROMPT HERE>
```

#### Prompt B: Execute
```text
<PROMPT HERE>
```

### Section 4: Definition of Done
- Provide a short checklist (5-12 items) user can validate.

## Prompt Templates (internal guidance)

### Prompt A (Plan-only / Read-only) template
Generate something equivalent to:
- Role: "You are Codex, a coding agent."
- Task summary
- Context pointers: "Inspect these files/folders: ..."
- Constraints: "Do not edit files or run destructive commands."
- Deliverables:
1. Repo understanding summary (brief)
2. Proposed approach and file touch list
3. Risks and edge cases
4. Verification plan (tests/commands)
5. Questions if still blocked (max 5)

### Prompt B (Execute) template
Generate something equivalent to:
- Role: "You are Codex, a coding agent that can read/edit files and run commands."
- Task summary
- Constraints and non-goals
- Plan-first requirement
- Implementation rules:
- Minimal change set unless user permits refactor
- Follow existing conventions
- Add or update tests when relevant
- Verification:
- Run tests/commands (or explain what to run if not available)
- Final report:
- Summary of changes
- Files changed
- Commands run and results
- Remaining risks and follow-ups

## Quality Bar / Anti-patterns
- Do not hallucinate file paths, frameworks, or commands. If unknown, ask or assume explicitly.
- Do not silently expand scope.
- Do not bury constraints. Put them near the top of generated prompts.
- Prefer concrete context references (file names/modules) when provided.
