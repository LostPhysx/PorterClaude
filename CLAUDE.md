# PorterClaude — working rules

## Track all work in GitHub issues

Every non-trivial task (feature, bug fix, refactor, docs change) gets a GitHub issue in
`LostPhysx/PorterClaude` — **before** the work starts, not after.

- Open the issue with `gh issue create` (problem, plan, acceptance criteria).
- Reference the issue in the commit (`… (closes #N)` or a `Closes #N` trailer).
- Close the issue when the work is done and verified; if parts remain, keep it open with
  checkboxes tracking the remainder.
- Small mechanical fixes (typos, lint) don't need an issue.

This applies retroactively going forward: release history before issue #1 (v0.3.1 and
earlier) predates the rule and is documented by git history and `docs/design/` alone.
