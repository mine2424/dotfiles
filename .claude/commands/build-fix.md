Diagnose and fix the current build errors.

## Steps

1. Run the project's build command (detect from package.json, Cargo.toml, Makefile, go.mod, etc.)
2. Capture and analyze the full error output
3. Categorize each error (type error, import error, dependency, config, etc.)
4. Trace to the root cause - fix the source, not the symptom
5. Apply the minimal fix for each error
6. Re-run the build to verify the fix
7. Repeat until the build succeeds or report back if architectural changes are needed

## Rules

- Fix one error at a time and verify between fixes
- Do not use type casts, `@ts-ignore`, `#[allow(...)]`, or similar suppressions unless explicitly asked
- If a fix requires significant refactoring, describe the change and ask before proceeding
- Check for cascading errors after each fix

$ARGUMENTS
