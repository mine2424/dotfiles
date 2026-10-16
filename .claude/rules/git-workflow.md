## Git Workflow Rules

### Commits
- Use conventional commit format: `type(scope): description`
  - Types: feat, fix, refactor, docs, test, chore, perf, ci
- Keep commits atomic - one logical change per commit
- Write commit messages that explain **why**, not **what** (the diff shows what)

### Branches
- Never force push to main/master
- Never commit directly to main/master in team projects

### Before Committing
- Run the project's linter and type checker
- Run relevant tests
- Review `git diff --cached` to verify only intended changes are staged
- Do not commit: `.env`, credentials, IDE settings, OS files, build artifacts

### Pull Requests
- Keep PRs focused on a single concern
- Include a clear description of what changed and why
- Add test plan describing how to verify the change
