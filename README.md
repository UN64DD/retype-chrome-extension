# Retype

**Retype** is a Chrome extension (Manifest V3) that types text for you. Paste or type
text into the extension popup, click into a text field on any web page, press
**Start**, and Retype types the text into that field one character at a time - at a
speed you choose.

Phase 1 focuses on the core typing engine for normal web pages.
Google Docs and Microsoft Word integration are intentionally **not** included yet
(see Roadmap).

## Current features

- Popup with a large paste textarea, typing-speed control, and Start / Pause /
  Stop / Clear buttons
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
- **No special permissions requested** - not even `tabs`

## Project structure

```text
retype-extension/
├── manifest.json    # Manifest V3, minimal permissions, content script registration
├── popup.html       # Popup markup
├── popup.css        # Popup styles (375px wide)
├── popup.js         # Popup controls, validation, messaging, status display
├── content.js       # Editable detection + typing engine + message handlers
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

1. Click inside the textarea, the text input, or the contenteditable box on the
   test page so the field is focused.
2. Click the Retype toolbar icon.
3. Paste or type text, choose a typing delay, press **Start**.
4. Watch the text appear one character at a time; status and progress update live.

### Suggested test cases

| # | Test | Expected result |
|---|------|-----------------|
| 1 | Type `Hello world!` | `H → He → Hel → ... → Hello world!` |
| 2 | Type multiple lines | Newlines preserved in the textarea |
| 3 | Pause mid-typing, then Resume | Continues from the exact character |
| 4 | Stop mid-typing | Typing halts completely; next Start begins from the start |
| 5 | Start with no focused field | "No editable field detected. Click inside a text field first." |
| 6 | Textarea | Text typed correctly, `input` events fire |
| 7 | Text input | Text typed at the caret, `input` events fire |
| 8 | Contenteditable | Text and line breaks inserted correctly |

## How it works

- The **popup** validates the text and delay, then sends commands to the page's
  content script with `chrome.tabs.sendMessage`:
  `RETYPE_START`, `RETYPE_PAUSE`, `RETYPE_RESUME`, `RETYPE_STOP`,
  `RETYPE_CLEAR`, `GET_STATUS`.
- The **content script** (`content.js`) finds the focused editable element with
  `getActiveEditableElement()`, runs the async typing loop, and pushes
  `STATUS_UPDATE` messages (`{ current, total, status, message? }`) back to the popup.
- For `<textarea>` / `<input>` it writes through the **native value setter** and
  dispatches an `InputEvent('input')`, so pages see normal typing behavior.
- For `contenteditable` it uses `document.execCommand('insertText' /
  'insertLineBreak')` (with a manual DOM fallback), which keeps the native undo
  stack and fires input events.

## Known limitations

- **Google Docs / Microsoft Word / other canvas-based editors are not supported**
  (by design, this phase). They do not use normal DOM inputs.
- Only the top frame is typed into; content inside `<iframe>`s is not reached.
- Works on normal `http(s)` pages. Chrome-internal pages (`chrome://`, the Web
  Store) and PDFs cannot run content scripts.
- Local `file://` pages require **Allow access to file URLs** (or use the local
  HTTP server above).
- Single-line `<input>` fields do not display newline characters; use a textarea
  for multi-line text.
- `contenteditable` insertion relies on `document.execCommand`, which is
  deprecated (though still supported by all current browsers); a manual fallback
  is included if it returns `false`.
- The popup must remain open while typing; closing it does not stop typing, but
  the progress display resumes on the next popup open (`GET_STATUS`).

## Future roadmap

**Next phase: Google Docs integration**

1. Study how Google Docs represents text: a canvas-based renderer where typing
   must be dispatched as synthetic keyboard events (`keydown` / `keypress` /
   `keyup`) against its hidden input/iframe, not as DOM value changes.
2. Add a Docs-specific inserter behind the same `typeText` interface, selected by
   page detection, keeping the popup and engine untouched.
3. Handle Docs' line-break model and caret tracking (Docs owns its own caret
   instead of the browser selection).
4. Validate against a large sample document, then repeat the approach for
   Microsoft Word for the web, which uses a similar but non-identical model.

Later ideas: configurable typing jitter (human-like speed), per-field start
position, keyboard shortcut to start/stop, and an options page.
# retype-chrome-extension
# retype-chrome-extension
