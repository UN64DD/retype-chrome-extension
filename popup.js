// Retype popup logic: validates input, talks to the content script, mirrors status.

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

// The popup's local view of the typing session. The content script is the
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

async function sendToContent(message) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab) {
    throw new Error('No active tab found. Open a webpage tab and try again.');
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    // The content script is missing: chrome:// pages, the web store, a page
    // that has not reloaded since installation, or a local file without
    // "Allow access to file URLs" enabled.
    throw new Error(
      'Content script unavailable on this page.\n' +
      'Open a normal web page (not a browser page) and try again.'
    );
  }
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

// Sync with the content script when the popup opens, in case a session is
// already running (e.g. the popup was closed and reopened mid-typing).
async function syncStatus() {
  try {
    const response = await sendToContent({ type: 'GET_STATUS' });
    if (response && response.ok) {
      applyStatus(response);
      clearMessage();
    }
  } catch (err) {
    // Not an error: the popup opens on every page, including ones where the
    // content script cannot run. Just tell the user why Start will not work.
    showMessage(err.message, 'info');
  }
}

render();
syncStatus();
