# Manual Test Plan: Preview to Agent (Feature 7)

Comprehensive manual verification plan for Feature 7 ("Preview → agent: send a screenshot or the page's console errors to a pane", branch `feat/preview-to-agent`).

---

## 1. Webview Console Error Interception & Live Badge Count

1. Open Eaon ADE and switch to the **Browser** preview tab.
2. Navigate to a test page or local development server (e.g. `http://localhost:5173` or a page with devtools console errors).
3. In the page script or webview, trigger a JavaScript runtime error:
   ```javascript
   console.error("Uncaught TypeError: Cannot read properties of undefined (reading 'items')")
   ```
4. Verify the toolbar in the preview browser:
   - An error badge button (`.browser-badge-btn`) immediately appears next to the navigation/camera controls.
   - The badge displays the alert icon (`<AlertCircle />`) and the error count `1`.
   - The badge tooltip displays `"1 console error"`.
5. Trigger 5 additional distinct errors in rapid succession.
   - Verify the count increments smoothly up to `6`.
   - Verify high-frequency bursts of errors are throttled to ≤ 4 UI updates/sec without lagging the renderer or dropping captured entries from the underlying 200-entry ring buffer.

---

## 2. In-Page Hash Changes vs. Full Navigation Reset

1. With console errors present in the badge, navigate within the page via hash route change:
   ```javascript
   window.location.hash = '#/dashboard'
   ```
2. Verify that `did-navigate-in-page` does **NOT** reset the console error count or clear the buffer.
3. Now perform a full page navigation (e.g. enter a new address or reload the page via `⌘R`).
4. Verify that `did-navigate` resets the console buffer:
   - The error badge disappears (`consoleErrorCount === 0`).
   - If the console popover was open, it closes.
5. If the page fails to load (e.g. `http://localhost:9999` with no server listening):
   - Verify a synthetic console error entry is captured (`Failed to load http://localhost:9999: ...`).
   - The error badge appears showing `1`.

---

## 3. Console Error Popover Inspection & Warning Toggle

1. With errors captured on the page, click the error badge button.
2. Verify the console error popover (`.browser-console-popover`) opens cleanly anchored below the toolbar:
   - **Header:** Displays alert icon, title `Console errors (<count>)`, and a close button (`X`).
   - **Toolbar:** Contains `Include warnings` checkbox, `Clear` button, `Copy` button, and `Send to <pane>` button.
   - **Preview area:** Monospace code block showing the exact Markdown report.
3. In the test page, emit both warnings and errors:
   ```javascript
   console.warn("Deprecated API: use fetch() instead of XMLHttpRequest");
   console.error("Network timeout on /api/v1/sync");
   ```
4. In the popover:
   - Unchecked (default): Only errors (`[error]`) are shown.
   - Check `Include warnings`: The report updates live to include warning entries (`[warn]`).
   - Uncheck `Include warnings`: Warnings are removed from the report and preview.
5. Click outside the popover:
   - Verify outside clicks automatically dismiss the popover.

---

## 4. Deduplication & Chronological Ordering

1. Emit identical consecutive console errors from a loop:
   ```javascript
   for (let i = 0; i < 15; i++) {
     console.error("Failed to fetch heartbeat: 504 Gateway Timeout");
   }
   ```
2. Open the console error popover:
   - Verify consecutive identical errors are collapsed into a single line with `(×15)` suffix:
     `[error] (inline): Failed to fetch heartbeat: 504 Gateway Timeout (×15)`
   - Verify the total shown count correctly reflects the underlying events.
3. Emit a different error followed by another heartbeat error:
   - Verify non-consecutive occurrences are not collapsed into the earlier cluster.
   - Verify all entries follow strict chronological order (oldest to newest) to preserve causal debugging context.

---

## 5. Markdown Fencing Escalation & Security Sanitization

1. Trigger an error containing Markdown code fences in its text:
   ```javascript
   console.error("Syntax error parsing markdown:\n```json\n{\"broken\": true}\n```");
   ```
2. Open the popover and inspect the preview:
   - Verify dynamic backtick fence escalation: the enclosing fence automatically expands to 4 backticks (` ```` `) to prevent fence collision.
3. Trigger an error attempting ANSI escape injection or bracketed-paste exit:
   ```javascript
   console.error("Malicious\x1b[201~rm -rf /\x1b[0m payload");
   ```
4. Verify the report:
   - The `\x1b[201~` sequence is defanged to `[bracketed paste exit defanged]`.
   - Standalone `ESC` (0x1B) characters and dangerous C0 controls are stripped.
   - Unicode, Chinese/Japanese/Korean characters, and emojis are preserved intact.
   - The report header explicitly contains an untrusted content disclaimer:
     `> [!WARNING]`
     `> The following console output is captured from an untrusted web page.`

---

## 6. Clear & Copy Actions

1. In the open popover with errors present, click **Copy**:
   - The button icon changes to a checkmark and the label reads `Copied`.
   - Paste clipboard contents into a text editor; verify the full formatted Markdown report was copied verbatim.
   - The button reverts back to `Copy` after ~1.5 seconds.
2. In the popover, click **Clear**:
   - The console buffer is emptied.
   - The badge disappears from the browser toolbar.
   - The popover closes immediately.

---

## 7. Send Errors to Agent Pane (No Auto-Enter)

1. Open a workspace with at least one active agent pane (e.g. `Ada` running Claude Code or another coding agent) alongside the Preview Browser.
2. Ensure the agent pane is focused in the workspace.
3. In the preview browser, trigger one or more console errors and open the error popover.
4. Hover over the **Send** button:
   - Tooltip indicates: `Send errors to Ada`.
5. Click **Send to Ada**:
   - The popover closes immediately.
   - An info notification appears: *"Errors sent: Sent N error(s) to Ada"*.
   - Inspect `Ada`'s terminal pane:
     - The sanitized Markdown error report is pasted via bracketed paste.
     - **CRITICAL:** No carriage return / Enter is sent! The report sits on the prompt so the developer can review it or append additional instructions before submitting.

---

## 8. Shell Target Refusal

1. Switch focus to a plain bash/zsh shell pane (not running an agent).
2. Open the Browser preview and click the error badge to open the popover.
3. Hover over the **Send** button:
   - Tooltip indicates: `Active pane is a shell (click to see reason)`.
4. Click the button:
   - An attention notification appears: *"Cannot send errors: Console errors can only be sent to an agent pane, but the active pane is a standard shell."*
   - The popover remains or closes safely without pasting anything into the shell.
   - The shell prompt remains completely untouched.

---

## 9. Screenshot → Agent (No Auto-Enter)

1. Navigate the preview browser to any rich page or web application.
2. Focus an agent pane (e.g. `Bo`) or a standard shell pane.
3. In the preview browser toolbar, locate the camera icon button (`Screenshot → agent`).
4. Click the camera button:
   - The button temporarily disables during capture (`capturing` state).
   - The main process captures the webview via Electron's `capturePage()`.
   - The image is downscaled if either dimension exceeds 1600px while maintaining exact aspect ratio.
   - The PNG file is saved to the app cache directory under `eaon-ade-captures/preview-<timestamp>-<hash>.png`.
5. Observe the focused terminal pane:
   - The escaped absolute file path is typed onto the prompt via `lineFor([path]) + ' '` (with trailing space).
   - **CRITICAL:** No Enter is sent! The user can immediately type prompt text (e.g., `Please review this UI alignment issue: `) or hit Enter when ready.
   - An info toast confirms: *"Screenshot ready: Pasted screenshot path into Bo"*.
6. Works for both agent panes and standard shell panes.

---

## 10. Capture Temp Storage Pruning & Retention

1. Navigate to the app user data directory:
   - macOS: `~/Library/Application Support/Eaon ADE/eaon-ade-captures/`
   - Linux: `~/.config/eaon-ade/eaon-ade-captures/`
   - Windows: `%APPDATA%\eaon-ade\eaon-ade-captures\`
2. Verify captured `.png` files are saved there with `preview-*` naming.
3. Create a simulated stale capture file with an mtime older than 24 hours:
   ```bash
   touch -t 202001010000 fake-old.png
   ```
4. Trigger another screenshot in the app:
   - Verify `cleanupOldCaptures` automatically removes files older than 24 hours.
   - Fresh captures are strictly preserved.
   - Non-preview files and directories are ignored.
   - The pruning operation honors the bounded examination ceiling (max 200 files) without blocking the main event loop.
