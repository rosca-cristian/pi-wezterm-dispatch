---
name: audit
display_name: Security Audit
description: Full security audit with architecture analysis. Dispatches security-auditor and code-analyst.
layout: grid
---

## security-auditor
Perform a comprehensive security audit of the project at {working_dir}. Focus on:
- OWASP Top 10 vulnerabilities (XSS, SQL injection, CSRF, etc.)
- Authentication and authorization flows
- Input validation and sanitization at system boundaries
- Secrets management (hardcoded keys, .env exposure)
- Dependency vulnerabilities (check package.json / lock files)
- API endpoint security (rate limiting, auth checks)

Be thorough. Read the actual source code, don't just scan file names.

## code-analyst
Analyze the architecture and code quality of the project at {working_dir}. Focus on:
- Overall architecture pattern (monolith, microservices, layered, etc.)
- Directory structure and module organization
- Key entry points and data flow
- Dependency graph (internal and external)
- Code patterns and conventions used
- Potential technical debt or anti-patterns
- Test coverage assessment (do tests exist? what frameworks?)
