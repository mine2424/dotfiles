## Coding Style Rules

### General Principles
- Write the simplest code that solves the problem
- Prefer immutable data - use `const`, `readonly`, `final` by default
- Keep functions under 40 lines - extract when logic is independently testable
- Maximum 3 levels of nesting - use early returns or extract functions
- Name things for what they represent, not how they're implemented

### File Organization
- One primary export per file
- Keep files under 300 lines - split by responsibility when larger
- Group imports: stdlib/builtin, external packages, internal modules

### Error Handling
- Handle errors at the appropriate level - don't catch and ignore
- Use the language's idiomatic error handling (Result in Rust, error returns in Go, exceptions in Python/TS)
- Provide context in error messages: what was attempted and what failed

### Code Changes
- Do not add features, refactoring, or cleanup beyond what was requested
- Do not add comments for self-explanatory code
- Do not add type annotations or docstrings to code you didn't change
- Three similar lines of code is better than a premature abstraction
