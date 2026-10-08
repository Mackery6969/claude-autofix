# Repository standards

## Security fixes
- Treat every finding in `semgrep-results.json` as something to triage.
- Real flaws: fix them with standard, well-tested library mechanisms, not custom string filters.
- False positives: leave the logic alone. On the line directly above the flagged code, add a comment saying why it is safe, then a `// nosemgrep: <rule-id>` (or `# nosemgrep: <rule-id>`) line.
- Every existing test suite must still pass.

## Code quality
- Keep public functions, classes and APIs backward compatible.
- Prefer early returns and guard clauses over deep nesting.
- Pull duplicated logic into small private helpers.
- Modernize outdated idioms where it reads better.
- Never mix security fixes and refactoring in the same change.
