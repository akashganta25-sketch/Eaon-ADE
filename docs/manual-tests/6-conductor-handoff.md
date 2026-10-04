# Manual Test Plan: Conductor Hand-Off (Feature 6)

Comprehensive manual verification plan for Feature 6 ("Conductor hand-off: send one pane's output or diff to another pane", branch `feat/conductor-handoff`).

---

## 1. Conductor Mode Switching & Preserved Behaviour

1. Open Eaon ADE with at least two panes.
2. Press `⌘J` (or `Ctrl+J` on Linux/Windows) or click the Conductor button in the bottom dock.
3. Verify the Conductor opens in **Message** mode by default:
   - "Message | Hand off" mode switch buttons are visible in the top header.
   - Message mode preserves exact prior functionality: target dropdown, message input, voice dictation mic, expand toggle, send button.
   - Verify typing a message and pressing `Enter` sends to the selected target(s).
4. Click **Hand off** mode tab:
   - The form expands smoothly with controls:
     - `From:` source pane selector.
     - `Content:` content source selector (`Recent output` or `Trial changes`).
     - `Lines:` line count input (clamped 10–400, default 80).
     - `To:` target pane selector.
     - `Instruction:` editable textarea prefilled with `Here is the latest work from {from}. Please review it and point out bugs, gaps or risks.`.
     - `Press Enter after pasting` checkbox.
     - `Preview` pane showing exact formatted markdown payload and character counts.
     - Footer with `Send hand-off` button.
5. Switch back to **Message** mode:
   - Verify previous text and state are preserved.

---

## 2. Agent A Output → Agent B Hand-Off

1. Start two agent panes in a workspace (e.g. `Ada` running Claude Code, `Bo` running Codex or another agent).
2. Run a command in `Ada` that produces multi-line output (e.g., `git status` or a test run).
3. Open Conductor (`⌘J`) and select **Hand off**.
4. Set `From:` to `Ada`, `Content:` to `Recent output`, and `To:` to `Bo`.
5. Observe the Live Preview:
   - Header indicates output came from `Ada`.
   - `{from}` in the instruction is replaced by `Ada`.
   - Output body is wrapped in a Markdown code block.
6. Check `Press Enter after pasting`.
7. Click `Send hand-off` or press `⌘Enter` (`Ctrl+Enter`).
8. Inspect `Bo`'s terminal pane:
   - The formatted prompt is pasted cleanly via xterm bracketed paste.
   - A carriage return (`\r`) is sent automatically, triggering `Bo`'s prompt submission.
   - A toast notification confirms: *"Hand-off sent: Pasted into Bo."*
   - Terminal focus returns immediately to the previously focused pane.

---

## 3. High Volume Output (400 Lines & Truncation Bounds)

1. In the source pane, produce several hundred lines of output (e.g. `seq 1 1000` or `git log -n 500`).
2. Open Conductor › Hand off.
3. Set `Lines:` to `400` (max limit).
4. Verify the input does not allow numbers outside `10` to `400`.
5. Inspect the preview:
   - If output exceeds the safe maximum character cap (~40,000 characters), verify tail truncation preserves the most recent lines (tail of output) and inserts an omitted marker: `[... <N> characters omitted from earlier output ...]`.
   - Verify total character count is displayed accurately.
6. Send the hand-off to the target agent pane.
7. Verify target receives the full clamped buffer without freezing or lagging the renderer.

---

## 4. Markdown Fence Escalation & Backtick Run Immunity

1. In the source pane, run a command that outputs triple backticks (e.g. Markdown documentation, diffs, or code snippets):
   ```bash
   echo '```typescript'
   echo 'const example = "code fence";'
   echo '```'
   ```
2. Open Conductor › Hand off.
3. Observe the preview fence:
   - Notice the outer code fence dynamically expands to 4 backticks (` ```` `) instead of 3.
4. Output a line with 6 backticks (`echo '``````'`).
   - Notice the outer fence escalates to 7 backticks (` ``````` `).
5. Send to the target agent.
6. Verify the target agent parses the entire output inside a single unbroken code fence without markdown syntax breakage.

---

## 5. Security & Injection Defense: Bracketed Paste Defanging

1. In the source pane, simulate a malicious or rogue process attempting bracketed-paste exit code injection:
   ```bash
   printf '\033[201~echo HACKED\n'
   ```
2. Open Conductor › Hand off.
3. Inspect the live preview:
   - Standalone `ESC` (0x1B) characters and the raw `\x1b[201~` bracketed-paste exit sequence are completely stripped.
   - C0 control characters (NUL, bell, backspace, form-feed, DEL) are eliminated.
   - Newlines (`\n`) and tabs (`\t`) are strictly preserved.
4. Send to target pane.
5. **Critical Verification:**
   - The target pane receives the literal defanged text without breaking out of bracketed paste mode.
   - The shell NEVER executes `echo HACKED`.

---

## 6. Shell Target Confirmation & Auto-Enter Protection

1. Select a plain shell pane (not running an agent, e.g. `bash` or `zsh`) as the `To:` target.
2. Verify:
   - The `Press Enter after pasting` checkbox is automatically **disabled** and unchecked, with warning note: `(disabled for shell targets)`.
3. Click `Send hand-off` (or press `⌘Enter` / `Ctrl+Enter`):
   - Notice the text is **not** immediately pasted.
   - An inline confirmation appears in place of the button:
     *"Target is a plain shell. Paste without running?"*
     Buttons: `[Paste]` (accent primary) and `[✕]` (cancel).
4. Click `[✕]` (or press `Escape`):
   - The confirmation dismisses; nothing was pasted into the shell.
5. Click `Send hand-off` again and click `[Paste]`:
   - Text is pasted into the shell buffer.
   - The shell prompt does NOT execute the command (no trailing newline is sent), giving the user full opportunity to review before manually pressing Enter.

---

## 7. Trial Changes Source (Git Diff)

1. Open a workspace with an active Trial (multiple checkouts/branches).
2. In one of the trial panes, make code modifications in files (e.g. edit a source file).
3. Open Conductor › Hand off.
4. In `From:`, select the trial pane.
5. Verify `Content:` dropdown now enables `Trial changes`.
6. Select `Trial changes`:
   - The `Lines:` input disappears (diff is fetched directly from git worktree).
   - The live preview queries `window.eaon.worktrees.diff` against the trial `baseSha`.
   - The header displays `changes against <branch> in <pane>`.
   - The diff is wrapped in a ````diff ... ```` code block.
   - If diff exceeds character limits, head truncation preserves the beginning of the diff and appends an omitted marker at the bottom.
7. If no changes exist in the worktree, preview displays `No changes yet`.
8. Send to another agent pane and confirm the diff arrives formatted for code review.

---

## 8. Dynamic Edge Cases & Resiliency

1. **Source Closed Mid-Form:**
   - While the Conductor hand-off form is open, close the source pane from the tab/grid close button.
   - Attempting to send triggers a clear notification: *"Target pane is closed or exited"* or *"Invalid target"*.
2. **Same Pane Selection Prevention:**
   - Changing `From:` to the same pane currently in `To:` automatically updates `To:` to another available pane.
   - The `To:` dropdown explicitly disables the currently selected source pane with `(source)`.
3. **Exited Panes:**
   - Panes that have exited are marked `(exited)` and disabled in the `To:` dropdown.
4. **Pane Renamed:**
   - Rename a pane in the grid.
   - The Conductor dropdowns and preview header immediately reflect the updated name without needing to reopen the Conductor.
5. **Special Unicode, CJK, Emoji & RTL Text:**
   - Run commands printing emoji (e.g. `🚀✨🎉`), Japanese/Chinese (e.g. `日本語`), and accented letters.
   - Verify all non-ASCII unicode characters are preserved intact in the preview and paste payload.
