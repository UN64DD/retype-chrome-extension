// Retype background service worker.
//
// Two jobs:
//
// 1. Open the side panel on toolbar click. A toolbar *popup* could never work
//    for Retype: popups close the moment they lose focus, which is exactly what
//    happens when you click a text field on the page. The side panel stays put.
//
// 2. Run the "real keyboard" typing engine for canvas-based editors such as
//    Google Docs. Those editors draw their text on a canvas and own the text in
//    JavaScript, so a page script cannot insert into them - synthetic key
//    events are ignored outright. The only thing they accept is genuine,
//    trusted keyboard input, which we produce through the DevTools protocol
//    (chrome.debugger -> Input.dispatchKeyEvent). That API is only available
//    here in the service worker, which is why this loop does not live in the
//    content script.

function enableSidePanel() {
  if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) return;
  // Requires Chrome/Edge 114+; guarded above so older browsers load fine.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(enableSidePanel);
chrome.runtime.onStartup.addListener(enableSidePanel);

enableSidePanel();

// ------------------------------------------------ Real keyboard session state

const session = {
  tabId: null,
  text: '',
  total: 0,
  index: 0,
  delay: 50,
  status: 'ready', // ready | typing | paused | completed | stopped | error
  runId: 0, // bumped to cancel a running loop
  attached: false,
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sleeps in short slices instead of one long timer. An MV3 service worker is
// torn down after ~30s of silence, so a 60s typing delay would kill the engine
// mid-word; waking every 20s keeps it alive and lets Stop stay responsive.
async function waitWhileAlive(totalMs, myRun) {
  let left = Math.max(0, totalMs);
  while (left > 0) {
    if (session.runId !== myRun) return;
    const slice = Math.min(20000, left);
    await wait(slice);
    left -= slice;
  }
}

function report(extra) {
  const payload = Object.assign(
    {
      type: 'STATUS_UPDATE',
      engine: 'keyboard',
      current: session.index,
      total: session.total,
      status: session.status,
    },
    extra || {}
  );
  try {
    const sent = chrome.runtime.sendMessage(payload);
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch (err) {
    // No panel open, or the extension context went away. Nothing to do.
  }
}

function command(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// ------------------------------------------------------- Keystroke generation

// Maps a character to the fields Input.dispatchKeyEvent understands. The
// character itself travels in `text`, which is what makes the editor insert
// exactly this character regardless of the user's keyboard layout.
function keyDescriptor(ch) {
  const upper = ch.toUpperCase();
  const isLetter = /^[A-Za-z]$/.test(ch);
  const isDigit = /^[0-9]$/.test(ch);

  let code = '';
  if (ch === ' ') code = 'Space';
  else if (isLetter) code = 'Key' + upper;
  else if (isDigit) code = 'Digit' + ch;

  const keyCode = isLetter || isDigit ? upper.charCodeAt(0) : ch === ' ' ? 32 : 0;

  return {
    key: ch,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  };
}

// One character, as a real key press: keyDown carries the text (the browser
// derives keypress/input from it) and keyUp closes the press. Sending a
// separate 'char' event as well would insert the character twice.
async function dispatchChar(tabId, ch) {
  if (ch === '\n') {
    const enter = {
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    };
    await command(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, enter));
    await command(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, enter));
    return;
  }

  const desc = keyDescriptor(ch);
  await command(
    tabId,
    'Input.dispatchKeyEvent',
    Object.assign({ type: 'keyDown', text: ch, unmodifiedText: ch }, desc)
  );
  await command(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, desc));
}

// ------------------------------------------------------------ Attach / detach

async function attach(tabId) {
  if (session.attached && session.tabId === tabId) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  session.attached = true;
  session.tabId = tabId;
  // Give the page focus so the editor accepts input, and hand the caret back to
  // the document if the panel had taken it.
  try {
    await command(tabId, 'Page.bringToFront');
    await command(tabId, 'Runtime.evaluate', {
      expression:
        'if (document.activeElement && document.activeElement.blur) { var a = document.activeElement; a.blur(); if (a.contentWindow) { try { a.contentWindow.focus(); } catch (e) {} } }',
    });
  } catch (err) {
    // Focus tricks are best-effort; the keystrokes still reach the focused field.
  }
}

async function detach() {
  if (!session.attached) return;
  const tabId = session.tabId;
  session.attached = false;
  session.tabId = null;
  try {
    await chrome.debugger.detach({ tabId });
  } catch (err) {
    // Already detached (tab closed, or the user hit "Cancel" on the infobar).
  }
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!session.attached) return;
  session.attached = false;
  session.tabId = null;
  session.runId += 1;
  if (reason === 'target_closed') {
    session.status = 'stopped';
    report({ message: 'The tab was closed.' });
    return;
  }
  if (session.status === 'typing' || session.status === 'paused') {
    session.status = 'stopped';
    report({ message: 'Debugging ended, so typing stopped.' });
  }
});

function fail(message) {
  session.status = 'error';
  session.runId += 1;
  report({ message });
  detach();
}

// -------------------------------------------------------------- Typing engine

async function run() {
  const myRun = ++session.runId;

  while (session.index < session.total) {
    if (session.runId !== myRun) return;

    while (session.status === 'paused' && session.runId === myRun) {
      await wait(50);
    }
    if (session.runId !== myRun || session.status !== 'typing') return;

    if (!session.attached) {
      fail('Lost the connection to the page, so typing stopped.');
      return;
    }

    let ch = session.text[session.index];
    if (ch === '\r') ch = '\n';

    try {
      await dispatchChar(session.tabId, ch);
    } catch (err) {
      fail('Typing failed: ' + (err && err.message ? err.message : String(err)));
      return;
    }

    session.index += 1;
    report();

    await waitWhileAlive(session.delay, myRun);
    if (session.runId !== myRun) return;
  }

  if (session.runId === myRun) {
    session.status = 'completed';
    report();
    await detach();
  }
}

// ---------------------------------------------------------- Message handlers

async function handleStart(message) {
  const text = typeof message.text === 'string' ? message.text : '';
  const delay = message.delay;
  const tabId = message.tabId;

  if (!text) {
    return { ok: false, error: 'Nothing to type. Paste or type some text first.' };
  }
  if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) {
    return { ok: false, error: 'Invalid typing speed. Use 0 or higher.' };
  }
  if (typeof tabId !== 'number') {
    return { ok: false, error: 'No page tab to type into.' };
  }

  try {
    await attach(tabId);
  } catch (err) {
    const reason = (err && err.message) || String(err);
    return {
      ok: false,
      error: /Another debugger is already attached|already attached/i.test(reason)
        ? 'DevTools or another debugger is already attached to this tab.\nClose DevTools for this tab and try again.'
        : 'Could not take control of the page keyboard.\n' + reason,
    };
  }

  session.runId += 1; // cancel any previous loop
  session.text = text;
  session.total = text.length;
  session.index = 0;
  session.delay = delay;
  session.status = 'typing';

  report();
  run(); // fire and forget; progress arrives via STATUS_UPDATE
  return { ok: true };
}

function handleStop() {
  if (session.status !== 'typing' && session.status !== 'paused') {
    return { ok: false, error: 'Nothing is typing right now.' };
  }
  session.runId += 1;
  session.status = 'stopped';
  const payload = { current: session.index, total: session.total };
  report();
  detach();
  return Object.assign({ ok: true }, payload);
}

function handlePause() {
  if (session.status !== 'typing') {
    return { ok: false, error: 'Nothing is typing right now.' };
  }
  session.status = 'paused';
  report();
  return { ok: true };
}

function handleResume() {
  if (session.status !== 'paused') {
    return { ok: false, error: 'Typing is not paused.' };
  }
  session.status = 'typing';
  report();
  return { ok: true };
}

function handleClear() {
  const wasBusy = session.status === 'typing' || session.status === 'paused';
  session.runId += 1;
  session.status = 'ready';
  session.text = '';
  session.total = 0;
  session.index = 0;
  if (!wasBusy) detach();
  report();
  return { ok: true };
}

function statusSnapshot() {
  return {
    ok: true,
    // Declared so a panel reopened mid-session shows the right engine and routes
    // Pause/Stop/Clear back to the worker.
    engine: 'keyboard',
    current: session.index,
    total: session.total,
    status: session.status,
    attached: session.attached,
  };
}

const HANDLERS = {
  RT_KEYBOARD_START: handleStart,
  RT_KEYBOARD_STOP: handleStop,
  RT_KEYBOARD_PAUSE: handlePause,
  RT_KEYBOARD_RESUME: handleResume,
  RT_KEYBOARD_CLEAR: handleClear,
  RT_KEYBOARD_STATUS: statusSnapshot,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = HANDLERS[message && message.type];
  if (!handler) return undefined;

  // Every handler may be async (attaching the debugger takes a moment), so the
  // response channel is kept open for all of them.
  Promise.resolve()
    .then(() => handler(message))
    .then(
      (result) => sendResponse(result),
      (err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) })
    );
  return true;
});