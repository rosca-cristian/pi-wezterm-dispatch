---
name: full-review
display_name: Full Project Review
description: Complete project review — architecture, security, testing, and code quality. Dispatches 4 agents.
layout: grid
---

## code-analyst
Analyze the complete architecture of the project at {working_dir}:
- Directory structure and module organization
- Key entry points, data flow, and dependency graph
- Patterns, conventions, and frameworks used
- Technical debt and improvement opportunities

## security-auditor
Perform a security audit of the project at {working_dir}:
- OWASP Top 10 vulnerabilities
- Authentication/authorization review
- Input validation and data handling
- Secrets management and dependency CVEs

## tester
Assess the testing state of the project at {working_dir}:
- What test frameworks are used?
- What is the current test coverage?
- Identify untested critical paths
- Suggest tests that should exist but don't

## researcher
Research the tech stack and dependencies used in {working_dir}:
- Read package.json / requirements / go.mod etc.
- For each major dependency, check if it's up to date
- Note any deprecated or unmaintained dependencies
- Suggest modern alternatives where applicable
