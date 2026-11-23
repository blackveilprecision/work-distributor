---
name: wd
description: Run Claude Code threads on other hosts through wd (work distributor). Use when work should run in the background on another host, or when a wd report arrives.
---

# wd: submit and move on

wd queues a thread (repo, ref, prompt), runs it on a host that has room, and pushes a report back to you.

## Submitting
- Call `wd_submit` with `repo` (a registered repo id) and a self-contained `prompt`. The worker sees nothing of this conversation.
- It returns `{id, position}` at once. Then go back to your own work.
- Do not poll, loop or wait. There is no waiting tool, and `wd_status` is not needed to get a result.
- Set `tag` to your own label so you can match reports to tasks. Set `requires` only when a host label is really needed.

## Reports
- When a turn ends or a thread reaches a final state, a report arrives by itself as a `<channel source="wd">` event
  (meta: report, thread, state, kind, tag). It carries the result text, branch, head SHA, cost, and the reason for failures.
- If the channel is not active, the same reports are added to your context on your next prompt (hook) or via `wd_inbox`.
- After acting on a channel report or one read through `wd_inbox`, call `wd_ack` with its report id. Reports shown by the hook are already acknowledged. An unacknowledged report is shown again on your next prompt.

## Thread states
- `idle`: a turn finished; the worktree is kept. Continue with `wd_send`, or free it with `wd_release`.
- `done`, `cancelled`: finished.
- `lost`, `failed`, `stalled`: wd never retries. Read the reason, then decide whether to submit again. That is your call.
- `wd_cancel` stops a thread. Release threads you no longer need; the branch stays pushed.

## Limits
- wd does not open PRs, merge or review. It pushes the work branch to origin; what happens next is yours.
