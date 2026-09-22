# Active goal: Python Workers on celld

Implement and locally qualify the Python Workers support described in
`docs/python-workers-plan.md`. The active Codex goal was created at Kyle's explicit
request on September 21, 2026, without a token budget. Work resumes immediately
under that goal; the existing four-hour heartbeat remains a continuation mechanism.

## Finish line

- Pinned, reproducible runtime and dependency packaging; native Python deployment
  and development paths with clear rejection of unsupported inputs.
- Workers SDK entrypoints, async HTTP, context/background work, and supported
  bindings verified against pinned workerd fixtures using equivalent Python source.
- Python Durable Objects preserving celld's existing SQL, alarms, transactions,
  ownership, acknowledged-write durability, eviction, and restart semantics.
- Explicit tests for concurrency, cancellation/CPU termination, memory growth and
  pressure, proxy cleanup, and post-failure lifecycle behavior.
- Broader RPC, streaming, WebSockets, and Dynamic Workers qualification according
  to the plan, with a clearly bounded compatibility matrix and retained failures.

Successful hello-world tests do not satisfy the goal. Do not weaken comparisons
to conceal differences. Record tested versions, source, raw results, normalization,
and any unsupported behavior. A verifier failure determines the next diagnosis
step, not a reason to declare completion.

## Boundaries

Worktree: `/Users/kylekelley/.codex/worktrees/celld-python-workers/celld`.
Branch: `quod/python-workers`. Baseline: celld v0.5.1 `42269c1`.
Initial spike: `5873ca8`. Current evidence and next steps live in
`PYTHON_WORKERS_PROGRESS.md`.

Authorized development period ends October 5, 2026 at 19:22 America/Los_Angeles.
Report remaining work honestly if the deadline arrives first; do not mark an
incomplete goal complete. Use isolated local services and coherent local commits.
No live-fleet changes, merges, releases, public PRs, or upstream outreach. Monty
is a separate project. Subagents are not authorized by this goal alone.
