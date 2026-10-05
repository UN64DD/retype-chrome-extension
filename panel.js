// Retype side panel logic: validates input, talks to the content script,
// mirrors status.
//
// This runs as a side panel rather than a toolbar popup: popups close as soon
// as they lose focus, so clicking into a text field on the page dismissed the
// whole UI. The side panel survives that click, on every site.

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
  if (payload.status) status = payload.status;
  if (typeof payload.current === 'number') current = payload.current;
  if (typeof payload.total === 'number') total = payload.total;
  if (payload.message) showMessage(payload.message, status === 'error' ? 'error' : 'info');
  if (status === 'error' && !payload.message) showMessage('Typing failed. See the page for details.');
  render();
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

// Runs in every frame and reports which ones currently have the caret inside an
// editable element. Injected as a one-off function, so it adds no listeners.
// Used to pick the right frame on editors that host their text surface in an
// iframe (Google Docs), where a broadcast message would be answered by a frame
// that cannot see the caret.
function detectEditableFrame() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return !el.disabled && !el.readOnly;
  if (tag === 'INPUT') {
    const type = (el.type || 'text').toLowerCase();
    return ['text', 'search', 'url', 'tel', 'email', 'password', ''].includes(type) && !el.disabled && !el.readOnly;
  }
  return el.isContentEditable === true;
}

async function frameWithEditable(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: detectEditableFrame,
  });
  const frames = (results || []).filter((r) => r.result === true);
  return frames.length ? frames[frames.length - 1].frameId : null;
}

async function sendToContent(message) {
  const tab = await activeTab();
  if (!tab) {
    throw new Error('No web page tab found. Open a webpage tab (not chrome://) and try again.');
  }

  let response = null;
  let firstError = null;

  try {
    response = await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    firstError = err;
  }

  if (firstError) {
    // No listener: the tab predates this extension being installed or reloaded.
    // Inject (all frames, so iframe-based editors are covered) and try again.
    // This is why Start no longer demands a manual page reload.
    try {
      await injectContentScript(tab.id);
      response = await chrome.tabs.sendMessage(tab.id, message);
    } catch (err) {
      const reason = /Receiving end does not exist|Could not establish connection/i.test(err.message || '')
        ? (firstError.message || err.message)
        : err.message;
      throw new Error(explainFailure(tab, reason));
    }
  }

  // The broadcast was answered by a frame with no focused field while another
  // frame does have the caret (the normal Google Docs layout). Retry against the
  // frame that actually holds an editable element.
  if (response && !response.ok && /No editable field/i.test(response.error || '') && message.frameId === undefined) {
    try {
      const frameId = await frameWithEditable(tab.id);
      if (frameId !== null && frameId !== 0) {
        response = await chrome.tabs.sendMessage(tab.id, Object.assign({}, message, { frameId }));
      }
    } catch (err) {
      // Detection is best-effort; keep the original response.
    }
  }

  return response;
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

  let response;
  try {
    response = await sendToContent({ type: 'RETYPE_START', text, delay });
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

  status = 'typing';
  current = 0;
  total = text.length;
  render();
}

async function pauseOrResume() {
  clearMessage();
  const type = status === 'paused' ? 'RETYPE_RESUME' : 'RETYPE_PAUSE';
  try {
    const response = await sendToContent({ type });
    if (response && response.ok) {
      status = type === 'RETYPE_PAUSE' ? 'paused' : 'typing';
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
    const response = await sendToContent({ type: 'RETYPE_STOP' });
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
    const response = await sendToContent({ type: 'RETYPE_CLEAR' });
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

// Progress updates pushed by the content script.
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'STATUS_UPDATE') {
    applyStatus(message);
  }
});

// Sync with the content script when the panel opens, in case a session is
// already running (e.g. the panel was closed and reopened mid-typing).
async function syncStatus() {
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
