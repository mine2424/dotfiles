## Security Rules

### Secrets
- Never hardcode API keys, tokens, passwords, or connection strings in source code
- Use environment variables or secret management services
- If you find a hardcoded secret, flag it immediately and replace with an env var reference

### Input Validation
- Validate and sanitize all user input at system boundaries (API handlers, form inputs, CLI args)
- Use parameterized queries for all database operations - never string concatenation
- Escape output rendered in HTML to prevent XSS

### Authentication & Authorization
- Verify authorization on every state-changing endpoint
- Do not rely on client-side checks for access control
- Use constant-time comparison for secrets and tokens

### Error Handling
- Never expose stack traces, internal paths, or system details in user-facing errors
- Log errors with context for debugging, but sanitize sensitive fields
- Return generic error messages to clients

### Dependencies
- Do not add dependencies without checking for known vulnerabilities
- Prefer well-maintained packages with active security disclosure processes
