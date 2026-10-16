Review the current uncommitted changes (staged and unstaged) for code quality issues.

## Steps

1. Run `git diff` and `git diff --cached` to see all pending changes
2. For each changed file, review for:
   - Logic errors and edge cases
   - Security vulnerabilities (hardcoded secrets, injection, XSS)
   - Performance issues (N+1 queries, unbounded operations)
   - Maintainability (long functions, deep nesting, unclear naming)
3. Report findings grouped by severity: critical > warning > suggestion
4. For each finding, include the file, line number, and a concrete fix

## Rules

- Only review changed lines and their immediate context
- Do not suggest stylistic changes unless they affect readability
- Skip praise and padding - only report actionable findings
- If no issues found, say so briefly

$ARGUMENTS
