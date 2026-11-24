# wd queue panel for Herdr

A panel for the [Herdr](https://herdr.dev) app that shows wd's queue across every caller:

- what waits for a host, and why, host by host (queued threads and follow-ups);
- each host's running threads with their latest step, and its CPU in use or promised, free memory and disk;
- threads that are idle with their worktree kept.

Clicking a row opens more: a running thread's recent steps (`wd tail`), a host's eligibility for each repo, a
follow-up's waiting text, a queued prompt, an idle thread's last result.

It runs `wd queue --json` every 5 seconds (and `wd tail` for opened threads), so `wd` must be on the PATH Herdr sees and
`~/.config/wd/client.json` must point at your coordinator, as for any other `wd` command.

## Install
1. Copy the mod: `cp -R contrib/herdr/wd-queue ~/.config/herdr-app/mods/`, then `herdr-app check ~/.config/herdr-app/mods/wd-queue`.
2. Show it. The simplest way is a split beside the current pane:
   ```sh
   herdr-app do pane.split --direction right --mod wd-queue
   ```
3. Or open it from a button next to Files and Changes, like they do. Herdr's own layout and tab bar are read-only, so
   make personal copies:
   ```sh
   herdr-app do layout.clone '{"name":"main","as":"main-wd"}'   # switches to the copy
   herdr-app do mod.clone '{"name":"tabs","as":"tabs-wd"}'
   ```
   - In `~/.config/herdr-app/layouts/main-wd.json`, set the `tabs` block's content to `{ "mod": "tabs-wd" }`, and add
     `{ "id": "wd", "type": "block", "content": { "mod": "wd-queue" } }` to the children of the `panel-body` stack.
   - In `~/.config/herdr-app/mods/tabs-wd/main.js`, add `"wd"` to the `enabled` panel list and a button after the
     Changes one:
     ```js
     const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "wd"];
     // ...
     .child(panelButton("wd", "wd", "mods/wd-queue/queue.svg"))
     ```
   - Check with `herdr-app check ~/.config/herdr-app/mods/tabs-wd` and `herdr-app status`.

`ctrl-shift-l` switches back to Herdr's own layout.
