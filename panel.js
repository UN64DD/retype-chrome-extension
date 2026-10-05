// Retype side panel logic: validates input, picks the right typing engine,
// mirrors status.
//
// This runs as a side panel rather than a toolbar popup: popups close as soon
// as they lose focus, so clicking into a text field on the page dismissed the
// whole UI. The side panel survives that click, on every site.
//
// Two engines exist:
//   dom      - content.js writes straight into the field. Works on ordinary
//              pages, needs no debugger, cheapest option.
//   keyboard - the service worker produces trusted keystrokes over the DevTools
//              protocol. Required for canvas-based editors (Google Docs), which
//              ignore synthetic events entirely.

const els = {
  text: document.getElementById('text'),
  speedPreset: document.getElementById('speedPreset'),
  speedCustom: document.getElementById('speedCustom'),
  startBtn: document.getElementById('startBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  stopBtn: document.getElementById('stopBtn'),
  clearBtn: document.getElementById('clearBtn'),
  message: document.getElementById('message'),
  statusBadge: document.getElementById('statusBadge'),
  statusText: document.getElementById('statusText'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
  keyboardMode: document.getElementById('keyboardMode'),
  engineText: document.getElementById('engineText'),
};

const STATUS_LABELS = {
  ready: 'Ready',
  typing: 'Typing...',
  paused: 'Paused',
  completed: 'Completed',
  stopped: 'Stopped',
  error: 'Error',
};

// The panel's local view of the typing session. The content script is the
// source of truth; this keeps the UI responsive between its updates.
let status = 'ready';
let current = 0;
let total = 0;

// Which engine the panel expects to talk to on the next command. Follows the
// Real keyboard mode checkbox, including auto-detection.
let engine = 'dom';

// Which engine owns the session that is actually running. Deliberately separate
// from `engine`: ticking or unticking the checkbox must not redirect Pause, Stop
// or Clear away from a session that is still typing.
let sessionEngine = null;

// ---------------------------------------------------------------- UI helpers

function render() {
  const typing = status === 'typing';
  const paused = status === 'paused';

  els.statusBadge.textContent = STATUS_LABELS[status] || status;
  els.statusBadge.className = 'badge badge-' + status;
  els.statusText.textContent = STATUS_LABELS[status] || status;

  els.startBtn.disabled = typing || paused;
  els.pauseBtn.disabled = !typing && !paused;
  els.stopBtn.disabled = !typing && !paused;
  els.clearBtn.disabled = typing || paused;
  els.pauseBtn.textContent = paused ? 'Resume' : 'Pause';

  els.progressText.textContent = current + ' / ' + total + ' characters';
  els.progressBar.style.width = total > 0 ? Math.round((current / total) * 100) + '%' : '0%';

  if (els.engineText) {
    els.engineText.textContent = engine === 'keyboard' ? 'Real keyboard' : 'Direct';
  }
}

function showMessage(text, kind) {
  els.message.textContent = text;
  els.message.classList.toggle('message-info', kind === 'info');
  els.message.hidden = false;
}

function clearMessage() {
  els.message.hidden = true;
  els.message.textContent = '';
  els.message.classList.remove('message-info');
}

function applyStatus(payload) {
  if (payload.engine) engine = payload.engine;
  if (payload.status) status = payload.status;
  if (typeof payload.current === 'number') current = payload.current;
  if (typeof payload.total === 'number') total = payload.total;
  if (payload.message) showMessage(payload.message, status === 'error' ? 'error' : 'info');
  if (status === 'error' && !payload.message) showMessage('Typing failed. See the page for details.');
  render();
}

// ---------------------------------------------------------- Engine selection

// Canvas-based editors draw their text on a canvas and own the text model in
// JavaScript, so a page script cannot type into them no matter how the DOM is
// poked. Those sites need real keystrokes instead.
const CANVAS_EDITORS = /^(docs|sheets|slides)\.google\.com$/;

function needsKeyboardEngine(url) {
  if (!url) return false;
  try {
    return CANVAS_EDITORS.test(new URL(url).hostname);
  } catch (err) {
    return false;
  }
}

// Ticks the checkbox automatically on sites that need it, without fighting the
// user: once they touch it, their choice sticks.
let keyboardModeTouched = false;

function autoDetectEngine() {
  if (keyboardModeTouched || !els.keyboardMode) return;
  activeTab()
    .then((tab) => {
      if (!els.keyboardMode) return;
      els.keyboardMode.checked = needsKeyboardEngine(tab && tab.url);
      // Keep `engine` in step with the checkbox so the indicator and any command
      // issued before the first Start already target the right engine.
      engine = els.keyboardMode.checked ? 'keyboard' : 'dom';
      render();
    })
    .catch(() => {});
}

// ------------------------------------------------------------- Speed control

els.speedPreset.addEventListener('change', () => {
  const isCustom = els.speedPreset.value === 'custom';
  els.speedCustom.hidden = !isCustom;
  if (isCustom) els.speedCustom.focus();
});

// Returns the delay in ms, or null when the value is invalid.
// Rejects empty, non-numeric and negative values so bad delays never run.
function readSpeed() {
  if (els.speedPreset.value === 'custom') {
    const raw = els.speedCustom.value.trim();
    if (!/^\d+$/.test(raw)) return null;
    return parseInt(raw, 10);
  }
  return parseInt(els.speedPreset.value, 10);
}

// ----------------------------------------------------- Content script bridge

// The page we type into: the active tab of the window that hosts this side
// panel. `chrome.tabs.getCurrent()` returns this panel's own tab id when the
// panel is open as a full tab (it is null inside a real side panel), and such a
// chrome-extension:// page can never host a content script - so skip it.
async function activeTab() {
  const self = await chrome.tabs.getCurrent().catch(() => null);

  let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab = tabs && tabs.find((t) => !self || t.id !== self.id);
  if (tab) return tab;

  // The panel itself is the only candidate (e.g. it was opened as a tab). Fall
  // back to the most recently used web tab in the window.
  tabs = await chrome.tabs.query({ currentWindow: true });
  const usable = (tabs || []).filter((t) => t.url && !/^(chrome|chrome-extension|edge|about|devtools):/.test(t.url));
  usable.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return usable[0] || null;
}

// Injects the content script into the tab (all frames, so editors that live in
// an iframe such as Google Docs are covered) and retries. This is what makes
// Start work on a page that was already open when the extension was installed
// or reloaded, instead of demanding a manual reload.
async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content.js'],
  });
}

function explainFailure(tab, reason) {
  const url = (tab && tab.url) || '';
  const detail = 'Details: ' + reason;

  if (/Cannot access a chrome:\/\/ URL|Cannot access contents of the page|the extensions gallery cannot be scripted|chrome:\/\//i.test(reason)) {
    return 'This is a browser or extension page, where extensions cannot run.\nOpen a normal http(s) web page.';
  }
  if (/Missing host permission/i.test(reason)) {
    return 'Retype does not have permission for this site.\nEnable "Site access" for Retype on the extension\'s details page, or set it to "On all sites".';
  }
  if (url.startsWith('file://')) {
    return 'Local files need "Allow access to file URLs" enabled for Retype,\nor serve the folder over HTTP (python3 -m http.server 8000).';
  }
  if (url) {
    return 'Retype could not reach ' + url + '.\nReload the tab, then press Start again.';
  }
  return 'Retype could not reach the content script in this tab.\nReload the tab (Ctrl+R / Cmd+R), then press Start again.\n' + detail;
}

// Runs once in every frame and reports what that frame can see. Injected as a
// one-off function, so it registers no listeners and cannot interfere with the
// page. Used to pick the right frame on editors that host their text surface in
// an iframe (Google Docs), where a broadcast message is answered by the outer
// frame that cannot see the caret.
//
// `busy` tells us the frame is already typing, which happens when the broadcast
// reached it before we got a chance to target it explicitly.
function detectFrameState() {
  const el = document.activeElement;
  let editable = false;
  if (el) {
    const tag = el.tagName.toUpperCase();
    if (tag === 'TEXTAREA') editable = !el.disabled && !el.readOnly;
    else if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      editable = ['text', 'search', 'url', 'tel', 'email', 'password', ''].includes(type) && !el.disabled && !el.readOnly;
    } else editable = el.isContentEditable === true;
  }

  const injected = !!window.__retypeInjected;

  // The content script remembers the last focused field, because activeElement
  // reverts to <body> the moment focus leaves the page. Ask it rather than
  // second-guessing it, so this probe and handleStart always agree.
  if (injected && typeof window.__retypeHasEditable === 'function') {
    editable = !!window.__retypeHasEditable();
  }

  return { editable: editable, busy: !!(injected && window.__retypeBusy) };
}

async function frameStatuses(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: detectFrameState,
  });
  return (results || [])
    .map((r) => ({ frameId: r.frameId, editable: !!(r.result && r.result.editable), busy: !!(r.result && r.result.busy) }))
    .sort((a, b) => a.frameId - b.frameId);
}

// Picks the frame a command should be addressed to.
//
// Messages must never be broadcast on multi-frame editors: every frame would
// start typing at once, and whichever frame happened to answer first decided
// what the panel displayed. Here we ask each frame what it sees first, then
// address exactly one frame.
async function resolveTargetFrame(tabId, message) {
  let frames = [];
  try {
    frames = await frameStatuses(tabId);
  } catch (err) {
    return undefined; // detection unavailable; fall back to a broadcast
  }

  // A frame that is already typing owns the session (Pause/Stop/Clear).
  if (message.type !== 'RETYPE_START' && message.type !== 'GET_STATUS') {
    const busy = frames.filter((f) => f.busy);
    if (busy.length) return busy[busy.length - 1].frameId;
  }

  // The frame holding the caret. Deepest wins, which is the inner editor of a
  // Docs-style iframe rather than the outer shell.
  const editable = frames.filter((f) => f.editable);
  if (editable.length) return editable[editable.length - 1].frameId;

  const stillTyping = frames.filter((f) => f.busy);
  if (stillTyping.length) return stillTyping[stillTyping.length - 1].frameId;

  // Nothing focused anywhere: address the top frame so it returns the honest
  // "click inside a text field" error.
  return 0;
}

async function sendToContent(message) {
  const tab = await activeTab();
  if (!tab) {
    throw new Error('No web page tab found. Open a webpage tab (not chrome://) and try again.');
  }

  // frameId must go in the options argument. Left inside the message body it is
  // silently ignored, so every command was broadcast to every frame and the first
  // frame to answer won: on an iframe editor the top frame replied "No editable
  // field" even though the frame holding the field had already typed the text.
  const frameId = await resolveTargetFrame(tab.id, message);
  // undefined means detection itself failed; broadcast rather than guess a frame.
  const options = typeof frameId === 'number' ? { frameId } : undefined;

  try {
    return await chrome.tabs.sendMessage(tab.id, message, options);
  } catch (err) {
    // No listener: the tab predates this extension being installed or reloaded.
    // Inject (all frames, so iframe-based editors are covered) and try again.
    // This is why Start no longer demands a manual page reload.
    try {
      await injectContentScript(tab.id);
      return await chrome.tabs.sendMessage(tab.id, message, options);
    } catch (retryErr) {
      const reason = /Receiving end does not exist|Could not establish connection/i.test(retryErr.message || '')
        ? err.message || retryErr.message
        : retryErr.message;
      throw new Error(explainFailure(tab, reason));
    }
  }
}

// Sends a command to whichever engine is running. The keyboard engine lives in
// the service worker, so it is reached with a runtime message instead; the dom
// engine runs in the page, so it is reached through the tab.
async function sendToEngine(command) {
  // A running session outranks the checkbox: reach whichever engine owns it.
  const target = sessionEngine || engine;
  if (target === 'keyboard') {
    return chrome.runtime.sendMessage({ type: 'RT_KEYBOARD_' + command });
  }
  return sendToContent({ type: 'RETYPE_' + command });
}

async function start() {
  clearMessage();

  const text = els.text.value;
  if (!text) {
    status = 'ready';
    render();
    showMessage('Please enter some text to type.');
    return;
  }

  const delay = readSpeed();
  if (delay === null) {
    status = 'ready';
    render();
    showMessage('Invalid typing speed. Enter a whole number of 0 or more ms.');
    return;
  }

  const tab = await activeTab();
  if (!tab) {
    status = 'error';
    render();
    showMessage('No web page tab found. Open a webpage tab (not chrome://) and try again.');
    return;
  }

  const useKeyboard = !!(els.keyboardMode && els.keyboardMode.checked) || needsKeyboardEngine(tab.url);

  let response;
  try {
    response = useKeyboard
      ? await chrome.runtime.sendMessage({ type: 'RT_KEYBOARD_START', tabId: tab.id, text, delay })
      : await sendToContent({ type: 'RETYPE_START', text, delay });
  } catch (err) {
    status = 'error';
    render();
    showMessage(err.message);
    return;
  }

  if (!response || !response.ok) {
    status = 'error';
    render();
    showMessage(response && response.error ? response.error : 'Could not start typing.');
    return;
  }

  engine = useKeyboard ? 'keyboard' : 'dom';
  // Pin the session to this engine so later commands ignore checkbox changes.
  sessionEngine = engine;
  status = 'typing';
  current = 0;
  total = text.length;
  render();
}

async function pauseOrResume() {
  clearMessage();
  const paused = status === 'paused';
  try {
    const response = await sendToEngine(paused ? 'RESUME' : 'PAUSE');
    if (response && response.ok) {
      status = paused ? 'typing' : 'paused';
    } else if (response && response.error) {
      showMessage(response.error);
    }
  } catch (err) {
    status = 'error';
    showMessage(err.message);
  }
  render();
}

async function stop() {
  clearMessage();
  try {
    const response = await sendToEngine('STOP');
    if (response && response.ok) {
      status = 'stopped';
      current = response.current;
      total = response.total;
    } else if (response && response.error) {
      showMessage(response.error);
    }
  } catch (err) {
    status = 'error';
    showMessage(err.message);
  }
  render();
}

async function clearAll() {
  clearMessage();
  els.text.value = '';
  try {
    const response = await sendToEngine('CLEAR');
    if (response && response.ok) {
      status = 'ready';
      current = 0;
      total = 0;
    } else if (response && response.error) {
      showMessage(response.error);
    }
  } catch (err) {
    // Clearing the text still worked; only the session reset failed.
    status = 'ready';
    current = 0;
    total = 0;
    showMessage(err.message, 'info');
  }
  render();
}

// ------------------------------------------------------------------ Wiring up

els.startBtn.addEventListener('click', start);
els.pauseBtn.addEventListener('click', pauseOrResume);
els.stopBtn.addEventListener('click', stop);
els.clearBtn.addEventListener('click', clearAll);

if (els.keyboardMode) {
  els.keyboardMode.addEventListener('change', () => {
    keyboardModeTouched = true;
    engine = els.keyboardMode.checked ? 'keyboard' : 'dom';
    render();
  });
}

// Re-detect when the user moves to another tab, so the mode follows the page.
chrome.tabs.onActivated.addListener(() => autoDetectEngine());
chrome.tabs.onUpdated.addListener(() => autoDetectEngine());

// Progress updates pushed by the content script.
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'STATUS_UPDATE') {
    applyStatus(message);
  }
});

// Sync with the content script when the panel opens, in case a session is
// already running (e.g. the panel was closed and reopened mid-typing).
async function syncStatus() {
  // A keyboard session lives in the service worker and is invisible to the
  // content script, so a reopened panel has to ask the worker directly. Without
  // this the panel would report "Ready" while Docs was still being typed into.
  if ((sessionEngine || engine) === 'keyboard') {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'RT_KEYBOARD_STATUS' });
      // Only trust a snapshot that describes a session which actually ran; an
      // untouched worker must not hide a dom session in progress.
      const live = response && response.ok &&
        (response.status === 'typing' || response.status === 'paused' || response.total > 0);
      if (live) {
        applyStatus(response);
        if (response.status === 'typing' || response.status === 'paused') clearMessage();
        return;
      }
    } catch (err) {
      // Worker asleep or never started a session; fall through to the dom probe.
    }
  }

  try {
    const response = await sendToContent({ type: 'GET_STATUS' });
    if (response && response.ok) {
      applyStatus(response);
      clearMessage();
    }
  } catch (err) {
    // Deliberately silent: this is not a failure worth reporting. The content
    // script may simply not be in this page load yet (it is injected on demand
    // when Start is pressed), and pages such as chrome:// never allow it at
    // all. Start reports the real reason if something is actually wrong.
  }
}

render();
syncStatus();
autoDetectEngine();
