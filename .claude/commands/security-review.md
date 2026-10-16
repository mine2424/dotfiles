Perform a security-focused review of the current uncommitted changes.

## Steps

1. Run `git diff` and `git diff --cached` to see all pending changes
2. Check for OWASP Top 10 vulnerabilities in changed code
3. Scan for hardcoded secrets, API keys, tokens, or credentials
4. Verify user input is validated at system boundaries
5. Check authorization and access control on new endpoints
6. Report findings sorted by severity with remediation steps

## Focus Areas

- Injection (SQL, command, XSS)
- Authentication & authorization gaps
- Sensitive data exposure
- Missing input validation
- Insecure dependencies

## Rules

- Only review changed lines and their immediate context
- For each finding: severity, location, vulnerability type, and specific fix
- Critical and high severity findings must include code examples for the fix

$ARGUMENTS
