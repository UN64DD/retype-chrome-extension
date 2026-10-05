# Retype

**Retype** is a Chrome extension (Manifest V3) that types text for you. Paste or type
text into the extension side panel, click into a text field on any web page, press
**Start**, and Retype types the text into that field one character at a time - at a
speed you choose.

Normal web pages are typed through the DOM. Canvas-based editors such as Google
Docs are typed with real keyboard events instead, because they ignore synthetic
ones. Microsoft Word for the web is not included yet (see Roadmap).

## Current features

- Side panel (not a popup) with a large paste textarea, typing-speed control, and
  Start / Pause / Stop / Clear buttons. It stays open while you click and type on the
  page, so it never disappears mid-task
- Live status indicator: `Ready`, `Typing...`, `Paused`, `Completed`, `Stopped`, `Error`
- Character progress indicator (`120 / 500 characters`) with a progress bar
- Character-by-character typing engine (`async/await` + timer-based delays) that
  never blocks the browser UI thread
- Supports `<textarea>`, text-like `<input>` fields, and `contenteditable` elements
- Typing happens at the caret and fires real `input` events - no clipboard paste tricks
- Spaces and newlines are supported
- Pause / Resume from the exact character; Stop halts immediately; a new Start
  always begins from the beginning
- Configurable typing delay: 10 / 25 / 50 (default) / 75 / 100 / 250 / 500 ms presets
  plus a validated custom value
- Clear, friendly errors for every failure case (no focused field, unsupported
  page, empty text, invalid speed, page changed while typing, ...)
- Works on any page without a manual reload: the content script is injected on demand
  when the tab predates the extension being installed or reloaded
- Two typing engines, chosen automatically per page:
  - **DOM engine** for ordinary inputs and `contenteditable`
  - **Real-keyboard engine** for canvas editors (Google Docs, Sheets, Slides), which
    dispatches trusted key events via `chrome.debugger`. While it runs, Chrome shows a
    yellow "Retype is debugging this browser" infobar, and DevTools must be closed for
    that tab
- Types into the field inside `<iframe>` editors: Retype probes every frame, remembers
  the field you last clicked, and addresses that frame directly
- Permissions: `sidePanel`, `scripting`, `debugger`, and host access to `http/https/file`.
  Host access is what lets Retype read the tab URL (for accurate errors) and inject itself
  on demand. `scripting` and host permissions are both required - Chrome refuses
  injection without them. `debugger` is used only for the real-keyboard engine and is
  detached as soon as typing finishes

## Project structure

```text
retype-extension/
├── manifest.json    # Manifest V3, minimal permissions, side panel + content scripts
├── background.js    # Service worker: side panel setup + real-keyboard (CDP) engine
├── panel.html       # Side panel markup
├── panel.css        # Side panel styles (fluid, full height)
├── panel.js         # Panel controls, validation, engine routing, frame targeting
├── content.js       # Editable detection + DOM typing engine + message handlers
├── test.html        # Local testing page (textarea, input, contenteditable)
├── README.md
└── icons/           # icon16/32/48/128.png
```

## How to install locally in Chrome

1. Open Chrome and go to:

   ```text
   chrome://extensions/
   ```

2. Enable **Developer mode** using the toggle in the top-right corner.

3. Click **Load unpacked**.

4. Select the `retype-extension` project folder (the one containing `manifest.json`).

5. Pin the Retype icon to the toolbar for easy access (puzzle-piece icon → pin).

That's it - no build step, no dependencies.

## How to test it

### Local test page

From the project root:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/test.html
```

(Opening `test.html` directly as a `file:///...` URL also works if you enable
**Allow access to file URLs** on the extension's details page. Chrome blocks
extensions from local files by default, which is why the local HTTP server is
the recommended route.)

### Test procedure

1. Click the Retype toolbar icon to open the side panel.
2. Paste or type text, choose a typing delay.
3. Click inside the textarea, the text input, or the contenteditable box on the
   test page so the field is focused (the panel stays open).
4. Press **Start** in the panel; watch the text appear one character at a time.
   Status and progress update live.

The order of steps 3 and 4 does not matter as long as the field is focused before
**Start**: Retype injects itself into the tab on demand, so a page that was already
open when the extension was loaded works without a manual reload.

### Suggested test cases

| # | Test | Expected result |
|---|------|-----------------|
| 1 | Type `Hello world!` | `H → He → Hel → ... → Hello world!` |
| 2 | Type multiple lines | Newlines preserved in the textarea/Docs |
| 3 | Pause mid-typing, then Resume | Continues from the exact character |
| 4 | Stop mid-typing | Typing halts completely; next Start begins from the start |
| 5 | Start with no focused field | "No editable field detected. Click inside a text field first." |
| 6 | Textarea | Text typed correctly, `input` events fire |
| 7 | Text input | Text typed at the caret, `input` events fire |
| 8 | Contenteditable | Text and line breaks inserted correctly |
| 9 | Google Docs, real-keyboard mode | Text appears in the document; yellow debugging infobar shown, gone when done |

### Google Docs test procedure

1. Open a document in Google Docs and click at the point where you want the text.
2. Open the side panel. **Real keyboard mode** should already be ticked, since the panel
   detects Docs from the tab URL.
3. Paste text and press **Start**.
4. Expect a yellow "debugging this browser" infobar while typing, and text appearing in
   the document. Close DevTools for that tab first, otherwise attaching fails with
   "Another debugger is already attached".

## How it works

- The **side panel** validates the text and delay, then sends commands to the page's
  content script with `chrome.tabs.sendMessage`:
  `RETYPE_START`, `RETYPE_PAUSE`, `RETYPE_RESUME`, `RETYPE_STOP`,
  `RETYPE_CLEAR`, `GET_STATUS`.
- The panel picks an engine from the page URL. Google Docs / Sheets / Slides select the
  **real-keyboard engine**, which is routed to the service worker with `runtime.sendMessage`
  (`RT_KEYBOARD_START`, `RT_KEYBOARD_PAUSE`, `RT_KEYBOARD_RESUME`, `RT_KEYBOARD_STOP`,
  `RT_KEYBOARD_CLEAR`, `RT_KEYBOARD_STATUS`) because it lives in the background.
- The real-keyboard engine attaches `chrome.debugger`, focuses the editing surface via
  `Runtime.evaluate`, and types each character with `Input.dispatchKeyEvent` - a text
  `keyDown` plus a `keyUp`, and real key codes for Enter. The session stays in the service
  worker so it survives long pauses, and the debugger detaches on completion, Stop, or
  Clear.
- The **content script** (`content.js`) finds the editable element with
  `getActiveEditableElement()`, runs the async typing loop, and pushes
  `STATUS_UPDATE` messages (`{ current, total, status, message? }`) back to the panel.
- Because the side panel takes focus away from the page, `document.activeElement` can
  revert to `<body>` between your click and **Start**. The content script records the last
  focused field on `focusin` and exposes `window.__retypeHasEditable()`, so the panel's
  frame probe and the typing script always agree on which frame holds the field.
- Frame routing: the panel probes all frames with `chrome.scripting.executeScript`, then
  sends to one frame using the `frameId` **options** argument to `chrome.tabs.sendMessage`.
  (A `frameId` inside the message body is ignored, which broadcasts to every frame and lets
  an unrelated frame's error win.)
- For `<textarea>` / `<input>` it writes through the **native value setter** and
  dispatches an `InputEvent('input')`, so pages see normal typing behavior.
- For `contenteditable` it uses `document.execCommand('insertText' /
  'insertLineBreak')` (with a manual DOM fallback), which keeps the native undo
  stack and fires input events.

## Known limitations

- Google Docs / Sheets / Slides work through the real-keyboard engine, which needs
  `chrome.debugger`. Consequences: Chrome shows a yellow debugging infobar while typing,
  **DevTools must be closed** for that tab, and only one tab can be debugged at a time.
- Microsoft Word for the web and other canvas-based editors are not supported yet: they
  are not on the real-keyboard auto-detect list, and the DOM engine cannot see them. They
  may work if you tick **Real keyboard mode** manually.
- The DOM engine types into the frame holding the last field you clicked. Cross-origin
  iframes are handled the same way, but a frame that never received a `focusin` event
  cannot be targeted - click inside the field before pressing **Start**.
- Works on normal `http(s)` pages. Chrome-internal pages (`chrome://`, the Web
  Store) and PDFs cannot run content scripts.
- Local `file://` pages require **Allow access to file URLs** (or use the local
  HTTP server above).
- Single-line `<input>` fields do not display newline characters; use a textarea
  for multi-line text.
- `contenteditable` insertion relies on `document.execCommand`, which is
  deprecated (though still supported by all current browsers); a manual fallback
  is included if it returns `false`.
- The side panel can be closed while typing; that does not stop typing, and the
  progress display resumes the next time the panel is opened (`GET_STATUS`).
- Requires Chrome/Edge 114 or newer for the Side Panel API. A toolbar *popup* cannot
  be used here: popups close the instant they lose focus, which is exactly what
  happens when you click a text field on the page.

## Future roadmap

**Next phase: real-keyboard integration (improvements)**

1. Exercise the real-keyboard engine against large real documents, since automated tests
   can only approximate canvas editors locally.
2. Offer a keyboard-mode preference (auto / always / never) instead of the current
   auto-detect plus the manual **Real keyboard mode** checkbox.
3. Extend the auto-detect list to Microsoft Word for the web and other canvas editors,
   which use a similar but non-identical model.

Later ideas: configurable typing jitter (human-like speed), per-field start
position, keyboard shortcut to start/stop, and an options page.
