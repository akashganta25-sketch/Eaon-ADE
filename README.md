# Eaon ADE

An agentic development environment, by Eaon.

Run a dozen CLI coding agents side by side, see who is working and who is stuck,
and drive them all from one place.

Eaon ADE is a real terminal — every pane is a genuine pseudo-terminal running your
login shell. It just happens to know that the thing inside the shell is usually
an agent.

The identity is the grid-A mark, coral `#F17455` on ink `#0F0F0F`, set in
Instrument Serif, Inter and JetBrains Mono. `npm run icon` regenerates the app
icon straight from the mark.

## Run it

```bash
npm install
npm run dev      # hot-reloading development window
```

Other scripts:

```bash
npm run build     # typecheck + bundle main, preload and renderer into out/
npm start         # run the built app
npm run typecheck # types only
npm run dist:mac  # unpacked .app in dist/
```

Requirements: Node 20+. On macOS, Xcode Command Line Tools (node-pty compiles
against them); on Linux, a compiler and Python (`build-essential` and `python3`
on Debian, Ubuntu and Raspberry Pi OS) for the same reason; on Windows, nothing
beyond Node — node-pty ships a prebuilt binary there. If the Electron binary
fails to download during install, run `node node_modules/electron/install.js`.

## What is in it

**Grid** — up to twelve panes, each its own shell with its own agent. Panes carry
a short handle (Ada, Bo, Cleo…) so you can talk about them, a title lifted from
whatever the program reports, a git branch chip, and a context meter read out of
the agent's own status line.

**Status that means something** — one colour means an agent is working, another
means *you* are the bottleneck: it rang the terminal bell or printed a
confirmation prompt. Every theme picks two colours that cannot be confused, and
the second one is used nowhere else, so it always means the same thing.

**16 themes** (`⌘,` → Appearance) — nine original, seven drawn from the usual
suspects: Dracula, Gruvbox, Nord, Tokyo Night, Catppuccin, One Dark, Rosé Pine.
Dark and light. Picking one repaints the chrome, the panels, the editor and
every open terminal at once — no restart, no reconnect. Themes are plain data in
`src/shared/themes.ts`: a background, a tint, a foreground, three status colours
and the sixteen ANSI colours. Adding your own is about twenty lines.

**Eaon Brain** — what the project knows, kept as plain markdown in
`.eaonbrain/` beside the code. Notes reference each other with `[[wiki links]]`,
so the folder is a graph rather than a pile of files, and the app draws it.

The point is the MCP server. Starting an agent in a folder registers
`eaon-brain` in that project's `.mcp.json`, so every agent you run there —
Claude Code, Codex, anything speaking MCP — gets six tools for reading and
writing the same memory: `brain_search`, `brain_list`, `brain_read`,
`brain_write`, `brain_link`, `brain_related`. A fresh session searches the brain
instead of re-reading the source tree to rebuild context it had yesterday. What
one agent learns, the next one starts with. Commit it like code.

Tools alone are not enough — an agent has to decide to use them, and by default
it does not. So the same step installs a skill at
`.claude/skills/eaon-brain/SKILL.md`: search the brain before exploring the
source, record what was learned before finishing, and title, tag and link the
note so it can be found again. It is ordinary markdown, committed with the repo,
and meant to be edited — a copy you have changed is never overwritten. The
difference is not subtle: given the same question, a session without it answers
from the prompt and writes nothing down, while a session with it reads what past
sessions worked out and leaves its own findings behind.

Claude Code asks you to approve a project-scoped MCP server the first time it
sees one; that is a one-off per workspace.

**Conductor** (`⌘J`) — type once, send to the pane you are in, to every pane, or
to one you name.

**Hand off between panes** (Conductor › Hand off) — package one pane's recent terminal output or trial git diff into a safe, fenced markdown prompt and paste it directly into another agent for review or follow-up. Output is automatically sanitized against ANSI escape code and bracketed-paste exit injection, identical consecutive line repetitions are collapsed, and backtick fences expand dynamically to prevent Markdown fence collisions. Plain shell targets are guarded with an inline confirmation and never auto-executed.


**Voice dictation** (hold `Right ⌘`) — talk to your agents instead of typing at
them. Hold the key, speak, let go, and the words go wherever you were already
typing: the focused pane's prompt, the Conductor, a Vault note. A readout at the
bottom of the window shows what it can hear, which pane the words are bound for,
and the transcript as it lands. Speech is transcribed by a Whisper model
running on your own CPU — pick one in Settings › Voice and it downloads once,
from 42 MB (Tiny, roughly 6× real time) up to 727 MB (Large v3 Turbo, the most
accurate and the slowest). English-only and 99-language models both available.
No account, no API key, and no audio leaves the machine — the transcriber runs
with remote model loading switched off, so it *cannot* reach the network even if
something tried. Long dictation is cut at natural pauses and transcribed a phrase
at a time, so text lands while you are still talking.

**Dictation types; it does not send.** Your words arrive on the prompt exactly as
you said them — nothing reworded, no filler stripped, no punctuation invented —
and they stay there until you press Return yourself. A misheard word is trivial
to fix while it is sitting on the prompt and impossible to fix once an agent has
acted on it, so there is no auto-send setting to turn on by accident. The
transcript's whitespace is flattened for the same reason: a newline inside a
pasted phrase would submit the line before you could read it.

**Spoken alerts** — when an agent stops working, its pane says so out loud:
"Ada has finished." Worth having when eight of them are running and watching the
grid is not what you want to be doing. Off until you turn it on in Settings ›
Spoken alerts, where you also pick the voice, the speed and the volume. The
synthesiser is macOS's own — nothing is downloaded, nothing is sent anywhere,
and an announcement costs one short-lived process rather than a speech model
sitting in memory. Only panes running an agent are announced, a run has to have
lasted a few seconds after the last thing you typed, and the same pane will not
be announced twice inside twenty seconds. If your Mac only has Apple's basic
voices, the panel says so and takes you to where the natural-sounding ones are
downloaded.

**Swarm** — hand the same opening prompt to every pane in a new workspace and
compare what comes back.

**Your sessions come back on their own.** Close the app with a dozen agents
running, open it again, and each pane returns to the conversation it was having
— no picker, no `--resume` typed by hand.

It works by naming the conversation before the agent has run once: a pane is
given a UUID at birth and started with `claude --session-id <uuid>`, so pane and
conversation are bound from the first moment. On every later launch the main
process looks for that transcript on disk and starts `claude --resume <uuid>`
instead. Deciding at spawn time, from what is actually on disk, is what makes it
self-correcting — an agent you started but never spoke to leaves no transcript,
so that pane simply opens fresh rather than failing to reopen nothing.

The alternative — matching panes to the most recent transcripts in a folder — is
a coin toss the moment two panes share one, and a pane silently adopting
somebody else's conversation is worse than starting clean.

**Resume** (`⌘/`) — still there for reaching *other* conversations: it reads the
transcripts Claude Code and Codex leave on disk and offers them back as real
`--resume` commands. Resume one into the current workspace or open a dozen at
once in a new one.

**Plan usage** — a pill in the title bar showing how full your five-hour and
weekly windows are, and when each next eases. It opens onto the detail: each
window against its limit, and where the week went by model.

The numbers come from the transcripts Claude Code already writes, so the token
counts are exact and nothing leaves the machine. What is *not* on disk anywhere
is the plan's ceiling — Anthropic reports that per request — so the percentage
is measured against a limit you can set in Settings › Plan usage, and the
honest figure (tokens spent, and the countdown) is the one shown first. Half a
gigabyte of transcripts is read once at about two seconds; after that a refresh
parses only the bytes appended since, which takes single-digit milliseconds.

If you want Anthropic's own percentages instead, there is a switch for it. It is
off by default because turning it on lets the app read Claude Code's sign-in
token and make a request as you.

**Board** — a queue for work you have not started. Hand a card to a pane and the
card text becomes the prompt.

**Vault** — prompts and context you keep re-typing, one click from any session.

**Board, Vault and Brain open as workspaces.** They join the rail beside your
terminal workspaces rather than taking over the screen, so looking something up
is switching to it and switching back — your shells keep running and you never
have to close a panel to reach them. Each one is a single entry that follows the
folder you opened it from and wears that project's colour; opening it again
brings it forward instead of stacking up duplicates.

**The rail is yours to arrange.** Right-click any workspace to rename it in
place, file it away, stop its sessions, or close it. Rename is a field in the
row itself, not a dialog — Return keeps it, Escape puts the old name back.

**Folders in the rail.** Make one with the folder button beside `+`, then drag
workspaces into it; drag one back onto the open space below to take it out
again, or use the same right-click menu. Folders fold shut, remember that they
were shut, and a shut one still tells you something inside it is running.
Deleting a folder only deletes the grouping — everything inside returns to the
top level and nothing stops.

**Closing lives in the menu.** There is no × on the rows. It used to sit under
the pointer on the way to every workspace you were only trying to switch to, and
one slip ended however many agents were inside. The menu also has **Stop the
sessions**, which ends the shells but keeps the workspace and its panes, so you
get the machine back with the transcripts still in front of you.

**A workspace tells you when it is working.** While something is actually
running in it, its icon becomes a small grid of squares with a light travelling
round them — Eaon's own mark in motion, since the mark is a letter A on a grid
with one cell lit. It wears the same colour as the live dot on a pane header, so
a rail of eight can be read at a glance without opening any of them. Turn on
Reduce motion and the light stops travelling and breathes in place instead.

"Actually running" is narrower than "bytes arrived", and deliberately. A CLI
agent redraws its whole prompt box on every keystroke, and repaints itself every
few seconds while sitting at rest — so anything keyed off raw output flickers
while you type and blinks at you when you are doing nothing. Two things have to
be true instead: the output has to have kept coming for a moment after the last
thing *you* sent, and it has to be a run of output rather than one isolated
burst. Measured against a real agent, that separates cleanly — while answering
it emitted every 110ms and never paused longer than 445ms, while at rest it
emitted once every ten seconds. Once it is lit, typing a follow-up does not put
it out; only the output stopping does.

**Drag a file onto a pane** — and its path is typed onto the prompt, escaped,
exactly as dragging onto any terminal does. That is how you hand an agent a
screenshot: drop it on the pane, say what to do with it, then send. An image
dragged straight out of a web page has no file of its own, so it is written to
a temporary one first and that path is used instead. Nothing is ever sent for
you, and a file dropped anywhere else in the window is refused rather than
opened — a stray drop used to replace the whole interface.

**A terminal that behaves like one** — right-click for copy, paste, select all,
find and clear. `⌘=` / `⌘-` / `⌘0` change the font size and re-fit every pane,
and the grid size flashes in the corner while it changes, so you can always see
how many columns a CLI is being given.

**Updates itself** — every launch and every few hours it asks GitHub Releases
whether there is something newer. A new build downloads quietly in the
background; nothing interrupts a running agent. When it is staged, one card
appears in the corner offering a restart, and the gear keeps a lit dot until you
take it. Settings › About shows the current version and checks on demand. A feed
that is unreachable, empty, or 404 reads as "up to date" rather than an error —
that is the normal state before the first release exists.

**Side panel** (`⌘⇧B`) — a file editor with syntax highlighting and autosave, a
git panel with staging, diffs and commits, and a tools panel that runs commands
in the focused pane and lists the scripts in the repo's `package.json`.

The editor's syntax colours come from the active theme's own terminal palette —
sixteen colours already chosen to be legible against exactly that background —
so highlighting belongs to whichever theme you picked and agrees with the
terminal running beside it. Six hues carry meaning (keywords, strings, numbers,
calls, types, markup) and two greys recede (comments, punctuation); anything
else keeps the plain foreground, so colour marks only what is worth marking.

**Preview browser** — the window onto whatever your agents are building, next to
the terminal that is building it. It probes the usual dev-server ports and shows
the ones actually serving pages as one-click chips, so you never have to
remember whether this project came up on 5173 or 3000. The address bar takes a
bare port (`5173`), a host (`localhost:8080`), or a full URL. There is no search
box on purpose: typing into one would quietly post your keystrokes to a search
engine, in an app that otherwise talks to nobody. The page keeps its scroll,
its forms and its route when you switch tabs away and back.

**Preview → agent (screenshot & console errors)** — hand visual state and runtime failures straight to your agents:
- **Screenshot to agent** (camera icon) — captures the active preview webview, downscales it cleanly (≤1600px width/height) to preserve aspect ratio, stores it safely in temporary app storage, and types the escaped file path directly into the active terminal's prompt without pressing Enter so you can review or append instructions. Works with both shells and agents.
- **Console errors badge & popover** — intercepts page runtime console errors (and optional warnings) and highlights an active error badge in the toolbar. Click the badge to open the inspector with full verbatim preview, deduplicated error groups with count `(×N)`, timestamp ordering, and dynamic Markdown fence sizing. Click **Send to agent** to paste the sanitized, bracketed-paste-safe error report directly into your active agent's prompt without auto-execution. Guarded against plain shell targets.

## Keyboard

| | |
|---|---|
| `⌘K` | Commands |
| `⌘T` | New workspace |
| `⌘D` | Add a pane |
| `⌘W` | Close the focused pane |
| `⌘E` | Fill the grid with the focused pane |
| `⌘1`–`⌘9` | Jump to a pane |
| `⌘J` | Conductor |
| `⌘B` | Workspaces sidebar |
| `⌘⇧B` | Side panel |
| `⌘/` | Resume a session |
| `⌘,` | Settings |
| Hold `Right ⌘` | Dictate while held; let go and the words land |
| `⌘⇧D` | Dictate, starting and stopping by hand |
| `Esc` | Discard what you are dictating |

Inside a pane:

| | |
|---|---|
| `⇧Return` | New line without sending — sends `ESC CR`, which is what CLI agents read as "newline, do not submit" |
| `⌥Return` | The same thing, via Option-as-Meta |
| `⌘←` / `⌘→` | Start / end of line |
| `⌘⌫` / `⌘⌦` | Delete to the start / end of the line |
| `⌥←` / `⌥→` | Back / forward one word |
| `⌥⌫` / `⌥⌦` | Delete the word behind / ahead |
| `⌘C` / `⌘V` / `⌘A` | Copy, paste, select all |
| `⌘F` | Find in this pane's output |
| **every `⌃` combo** | **Goes straight to the shell** — `^C`, `^D`, `^A`, `^E`, `^K`, `^U`, `^W`, `^R`, `^Z` and the rest |

Control is the shell's, always. Command is the app's, apart from the handful
above that a terminal is expected to own.

The macOS editing keys are sent as readline control codes (`^A`, `^E`, `^U`) and
meta-letters (`ESC b`, `ESC f`) rather than the modified-arrow escapes xterm
emits by default, because those are the ones bound everywhere — in bash,
`ESC[1;3D` is not merely ignored, the tail of it lands on the line as text.

`⇧Return` is the binding Claude Code's `/terminal-setup` installs by hand in
iTerm2 and VS Code. Eaon ADE sends it natively, so there is nothing to set up —
but note that it means `⇧Return` no longer submits at a bare shell prompt, where
`Return` still does.

## Windows

Eaon ADE runs on Windows 10 and 11, x64 and arm64. Panes are real
pseudo-terminals there too — ConPTY rather than a Unix pty — and open in
PowerShell 7 if it is installed, otherwise Windows PowerShell. `COMSPEC` is
used only if neither is present: cmd.exe is a poor host for a CLI agent, and
picking it by default would be picking it by accident.

**The shortcuts are not the same, and they cannot be.** macOS has two
modifiers, so ⌘ can belong to the app and Control to the shell without either
noticing the other. Windows has one, and every bare Control chord already means
something to the program you are talking to — `Ctrl+D` ends input, `Ctrl+W`
deletes a word, `Ctrl+K` kills a line. An app that took those would leave you
with an agent you could not exit.

So on Windows the app takes **Ctrl+Shift** and bare Control always reaches the
shell. `Ctrl+Shift+K` for commands, `Ctrl+Shift+T` for a workspace,
`Ctrl+Shift+D` for a pane, and so on for everything ⌘ does on a Mac. Two
bindings that are ⌘⇧ on macOS need their own letters, since Shift is already
spent: the side panel is `Ctrl+Shift+O` and hold-free dictation is
`Ctrl+Shift+M`. Font size stays on plain `Ctrl+=` / `Ctrl+-` / `Ctrl+0`, where
every Windows terminal puts it. Hold **Right Ctrl** to dictate.

The clipboard follows Windows Terminal: `Ctrl+Shift+C` and `Ctrl+Shift+V`
always work, and bare `Ctrl+C` copies when text is selected and interrupts when
it is not. Settings lists the full keymap for whichever platform you are on.

### Which installer

Releases carry an installer per architecture, named the way Electron names
them rather than the way a CPU is usually advertised:

| File | CPU | Who |
|---|---|---|
| `…-x64-setup.exe` | x86-64, also called AMD64 or "64-bit" | almost everyone, Intel or AMD |
| `…-arm64-setup.exe` | ARM64 | Windows on ARM, Snapdragon |
| `…-ia32-setup.exe` | x86, 32-bit | old Windows 10 x86 installs |
| `…-setup.exe` | all three in one | if you would rather not choose |

If you have an Intel or AMD desktop or laptop, **`x64` is the one** — `x64`,
`x86-64` and `AMD64` are three names for the same architecture. Windows 11 has
no 32-bit edition at all, so `ia32` is only for old machines.

One thing is missing from the 32-bit build and cannot be added: **voice
dictation does not work there.** ONNX Runtime, which runs the speech model,
publishes no 32-bit Windows binary. The speech engine lives in its own process,
so nothing else is affected — terminals, panes, the Brain, Stats and the
preview browser all work as they do everywhere else.

### Building it

On Windows, `npm run dist:mac`'s counterpart is:

```bash
npm run dist:win        # NSIS installer and a zip, x64 and arm64
```

The same command cross-builds from macOS, for x64 and arm64. It skips ia32
there and says so: node-pty publishes no 32-bit Windows prebuild and node-gyp
cannot compile one for another platform, so a 32-bit build made on a Mac would
install, open a window, and fail to start a single pane. The workflow builds
that one on Windows, where it is compiled properly, and tests it. Two of the three native dependencies
ship every platform's binaries in one package, so they need no help; sharp does
not, and `npm run deps:win` fetches its Windows binaries first — `dist:win`
runs it for you. The cross-build skips the native rebuild step, because
node-gyp cannot compile for another platform and node-pty's prebuilt binary is
N-API, so it does not need recompiling.

Prefer the real thing for anything you intend to ship: `.github/workflows/windows.yml`
builds on a Windows runner, where node-pty is compiled against this exact
Electron version rather than trusted to have shipped the right prebuild.

Installers are **not code-signed**. Windows SmartScreen will warn on first run
until they are signed with an Authenticode certificate, which is a separate
purchase from the Apple Developer membership the macOS build uses.

## Linux

Eaon ADE runs on x86-64 and arm64 Linux, which includes a **Raspberry Pi 4 or 5
running 64-bit Raspberry Pi OS**. Panes are real pseudo-terminals, as on macOS,
and open in your login shell.

### Which download

| File | For |
| --- | --- |
| `eaon-ade_<version>_<arch>.deb` | **Debian, Ubuntu, Raspberry Pi OS** |
| `eaon-ade-<version>-<arch>.rpm` | Fedora, openSUSE, RHEL |
| `eaon-ade-<version>-x86_64.AppImage` | any other distribution, x86-64 only — nothing is installed, mark it executable and run it |
| `eaon-ade-<version>-<arch>.tar.gz` | unpack it wherever you like |

Pick `arm64` on a Raspberry Pi, `x64`/`x86_64` on a normal PC.

```bash
# Debian, Ubuntu, Raspberry Pi OS
sudo apt install ./eaon-ade_1.1.5_arm64.deb
eaon-ade            # or find it in the applications menu

# AppImage, x86-64
chmod +x eaon-ade-1.1.5-x86_64.AppImage
./eaon-ade-1.1.5-x86_64.AppImage
```

The app installs to `/opt/eaon-ade` and puts `eaon-ade` on your `PATH`.

If you use the **tar.gz** rather than a package, and your distribution has
unprivileged user namespaces switched off (Ubuntu 24.04 and hardened Debian do),
Chromium will want its setuid sandbox helper and refuse to start without it. The
`.deb` and `.rpm` set that up when they install; unpacking a tarball does not, so
do it once by hand:

```bash
sudo chown root:root eaon-ade-*/chrome-sandbox
sudo chmod 4755 eaon-ade-*/chrome-sandbox
```

**There is no arm64 AppImage, deliberately.** The AppImage runtime
electron-builder bundles for arm64 links against the unversioned `libz.so`,
which ships in `zlib1g-dev` and on no ordinary desktop, so the image exits with
`error while loading shared libraries: libz.so` before the app is reached. The
x86-64 runtime links `libz.so.1` and is fine. On a Raspberry Pi install the
`.deb`, which suits Raspberry Pi OS better anyway.

The AppImage needs FUSE 2, which several distributions no longer install by
default. Either `sudo apt install libfuse2` once, or run the image with
`--appimage-extract-and-run` and skip FUSE entirely.

### What is different here

**Spoken alerts do not work.** They use macOS's own speech synthesiser, and
Settings says so rather than offering a control that does nothing. Dictation —
which runs a model on your own CPU — works normally.

**Updates depend on how you installed it.** An AppImage replaces itself the way
the macOS and Windows builds do. A `.deb` or `.rpm` belongs to your package
manager, so the app does not reach in and swap its own files; Settings tells you
to use `apt` or `dnf` instead.

**On a locked-down kernel it still starts.** Some distributions switch off
unprivileged user namespaces, and Chromium then needs its setuid sandbox
helper instead. Two things had to be true for that to work and neither was:
electron-builder's own post-install script decides whether the helper is needed
by trying to create a namespace *as root*, which always succeeds and so never
sets it up; and the helper's path may not contain a space, which `/opt/Eaon
ADE/` did — Chromium splits it and fails with `failed to execvp: /opt/Eaon`.
Linux packages therefore install to `/opt/eaon-ade`, and ship a corrected
post-install script. Tested on Debian 12 with
`kernel.unprivileged_userns_clone=0`.

**32-bit is not built.** Older Pis running 32-bit Raspberry Pi OS are out of
scope for the published artifacts: ONNX Runtime publishes no 32-bit build, so
dictation could not work, and there is no 32-bit CI runner to compile node-pty
on. Everything else would run, and building it on the Pi itself still works —
see below.

### Building it

Linux packages have to be built **on Linux**, and on a machine of the target
architecture:

```bash
npm run dist:linux      # AppImage, deb, rpm and tar.gz for this machine's arch
```

Running it anywhere else stops with an explanation rather than producing
something broken. The reason is node-pty: unlike Windows, where it ships
prebuilt binaries that a Mac can simply copy in, it publishes **no Linux
prebuild at all** and is compiled at install time. A Linux package built on
macOS therefore contains no pty binary — it would install, open a window, and
then fail to start a single pane. That is the same judgement `dist:win` makes
about 32-bit Windows.

This also means arm64 cannot be built on an x86-64 machine, so
`.github/workflows/linux.yml` uses one runner per architecture, builds on each,
and then launches the result under Xvfb and checks that the window mounts, the
preload bridge is wired and a pseudo-terminal actually opens. On a Raspberry Pi
the same command works directly — `npm install` there compiles node-pty for the
Pi and fetches the Pi's own sharp binary.

`npm run check:linux` exercises the Linux-specific code paths and the packaging
config from any machine, including this one.

The arm64 packages were built and driven on a real Debian 12 arm64 machine:
installed with `apt`, launched under Xvfb, and checked for a window, a live
preload bridge, a pseudo-terminal that spawns and echoes, and the Ctrl+Shift
keymap — on both a stock kernel and one with unprivileged user namespaces
switched off. The x86-64 packages are built and driven the same way by
`.github/workflows/linux.yml`.

Packages are **not signed**. Nothing on Linux requires it, but `apt` will note
that the `.deb` is unsigned when you install it by path.

## Cutting a release

```bash
npm version patch          # or minor / major
npm run dist:mac:release   # build, sign, notarise, staple, verify
npm run release:github     # upload to GitHub and verify the result
```

`latest-mac.yml` is the update manifest and **must** be uploaded alongside the
artifacts — it is the file the running app reads to learn a new version exists.

Two details the release script handles that are easy to get wrong by hand:

- **Hashes are recomputed after stapling.** electron-builder writes
  `latest-mac.yml` before notarisation, and stapling changes the bytes. Left
  alone, every update fails its checksum. `scripts/notarize-mac.mjs` rewrites the
  manifest from the final artifacts.
- **Asset names must be hyphenated before upload.** The files on disk contain a
  space, and GitHub rewrites spaces in asset names to *dots* — `Eaon ADE-1.0.0…`
  arrives as `Eaon.ADE-1.0.0…`. The manifest refers to the hyphenated form, so a
  hand-uploaded release resolves its manifest and then 404s on the download.
  `npm run release:github` renames the copies first, then re-fetches the
  published asset and compares its checksum against the manifest.

Block maps are deleted on purpose — they describe the pre-staple bytes, so
differential downloads would rebuild a file that fails its own checksum. Updates
fetch whole files.

### Testing updates without publishing

`Updater.supported()` also accepts a `dev-app-update.yml` in the project root, so
the whole check → download → install path can be exercised against a local feed:

```bash
# serve a newer build's artifacts plus latest-mac.yml
cd /tmp/feed && python3 -m http.server 8099
```

```yaml
# dev-app-update.yml (gitignored)
provider: generic
url: http://127.0.0.1:8099
```

Note that the final swap only works in a packaged build — in development the
running bundle is Electron's own, and Squirrel cannot find a bundle whose
identifier matches.

## How it is put together

```
src/
  main/        Electron main — PTYs, persistence, filesystem, git, session discovery
    stt/models.ts      Speech model catalogue on disk: download, verify, delete
    stt/host.ts        Owns the transcriber process and keeps one model warm
    stt/child.ts       The transcriber itself, in its own process
    speech.ts          Spoken alerts: reads the system voices, queues what is said
  preload/     The one typed bridge the renderer is allowed to use
  shared/      Types both sides agree on
    stt.ts             Model catalogue and the exact file manifest behind it
    speech.ts          Voice quality, ranking, and the line a finished pane says
  renderer/    React UI
    lib/terminals.ts   Owns every xterm instance; terminals outlive their components
    lib/dictation.ts   Microphone capture and voice-activity segmentation
    lib/speech.ts      Decides whether a finished run is worth announcing
    lib/insert.ts      Decides where dictated text lands
    store/useStore.ts  Application state, persisted to disk on a debounce
    components/        Screens and panels
```

Four decisions worth knowing about:

**Terminals outlive React.** Each xterm instance lives in a detached wrapper
element that gets re-parented as you move between workspaces, so a background
agent keeps streaming while you are somewhere else. `terminals.ts` owns them;
components only borrow them.

**Output is coalesced in main.** Twelve agents streaming at once would flood the
IPC channel one write at a time, so `PtyManager` batches each pane's output on a
12 ms timer before it crosses the boundary.

**Speech runs in its own process.** Whisper holds a core for as long as it takes
to decode a phrase. In the main process that would stall every keystroke in every
terminal behind it, so the model lives in a `utilityProcess` and talks over a
message port. It is loaded on first use, kept warm while you are dictating, and
dropped after five idle minutes — a large model is real memory. Only two things
cross the boundary: a `Float32Array` of samples going out, and a string coming
back. Downloaded models are plain files under `speech-models/`, laid out exactly
as transformers.js expects a local model path, which is why the transcriber can
run with remote loading disabled entirely.

**Panes get a clean environment, not Eaon's.** A shell opened from Finder never
inherits the variables of whatever launched the app, so neither do ours.
`PtyManager.buildEnv` drops the launcher's fingerprints — `npm_*` (which is what
makes nvm complain about `npm_config_prefix`), `ELECTRON_*`, `NODE_ENV`,
`NODE_OPTIONS`, editor and agent session markers — then sets `TERM`,
`COLORTERM`, `TERM_PROGRAM=Eaon` and a UTF-8 `LANG` if the system did not supply
one. This matters more than it sounds: start Eaon from inside another agent's
session and, without this, every CLI you open thinks it is a nested child of
that session and quietly turns off transcript saving. Because panes run a login
shell, anything you genuinely set in your own profile comes straight back.

## Honest limits

- The **context meter** shows what the agent prints. If your agent does not print
  a context percentage, the pill does not appear. Eaon ADE does not estimate it.
- **Attention** is inferred from the terminal bell plus a handful of "waiting for
  you" phrasings. It is a good signal, not a guarantee.
- **Panes do not survive a restart.** Their processes died with the app. The
  workspace, its layout and its agent choices come back; use Resume to pick a
  conversation back up.
- **The preview browser is a preview, not a browser.** One page at a time, no
  tabs, no history, no bookmarks, no search. It is aimed at the thing you are
  building; `⌘⇧B` then the arrow icon hands the current address to your real
  browser when you want the full article.
- **Dev-server chips can only report what is listening.** A port serving pages
  shows up whether or not it is yours. macOS's AirPlay Receiver squats port 5000
  on every Mac, so that one is filtered by its `Server` header; anything else
  answering HTTP is taken at face value.
- **Dictation runs on the CPU.** Tiny, Base and Small are comfortably faster than
  real time; Large v3 Turbo is not, and you will wait after you stop speaking.
  Moving inference to the GPU is the obvious next step and would mainly change
  the arithmetic on the larger models.
- **Speech models are a download, not a bundle.** Dictation does nothing until
  you have chosen one — the first press sends you to Settings rather than
  guessing on your behalf and spending 42 MB of someone's tethered connection.
- **The working indicator reads output, so a silent command is invisible to
  it.** `sleep 30` and a build that prints nothing until it finishes are running
  by any sensible definition and show nothing in the rail, because from outside
  the pane they are indistinguishable from an empty prompt. Everything that
  prints as it goes — every agent in the picker, and near enough every build
  tool — shows up.
- **Spoken alerts sound as good as your Mac's voices, and no better.** The
  synthesiser is the operating system's, which is what keeps the feature to one
  short-lived process instead of a neural model resident in memory — but a stock
  Mac ships only Apple's compact voices, and they sound synthetic. The natural
  ones are free, and Apple offers them through System Settings alone; the panel
  detects when you have none and links straight there. Bundling a voice would
  cost a several-hundred-megabyte download and a second inference engine, for
  three words.
- **A finished run is inferred from timing, not from the agent.** Nothing tells
  Eaon ADE that a turn is over, so it measures how long a pane kept printing
  after you stopped typing. Agents that animate a status line — which is all of
  the ones in the picker — are read accurately. One that thinks in complete
  silence and then prints a single line would not be announced.
- **The Fn / 🌐 key cannot be the push-to-talk key.** macOS never delivers it to
  an application: Chromium's macOS event conversion translates `flagsChanged`
  only for Shift, Control, Option, Command and Caps Lock, so no key event is
  ever raised for Fn. Apps that bind it install a system-wide `CGEventTap` and
  ask for Input Monitoring. Right ⌘ is the default here instead — same corner of
  the keyboard, no permission prompt, and nothing else in ADE binds it alone.

## Privacy

No telemetry, no accounts, no update pings. The only outbound request Eaon ever
makes is downloading a speech model you explicitly picked, and dictation itself
is offline by construction — the transcriber loads models `local_files_only`
with remote loading switched off, so it cannot reach the network. Audio is held
in memory, transcribed locally, and dropped; it is never written to disk. The
microphone is open only while you are dictating.

Spoken alerts are local for the same reason in the other direction: the line is
rendered by macOS's own synthesiser on this machine. No text is sent to a speech
service, and nothing about which pane finished, or when, leaves the computer.
Made with ❤️ in California

