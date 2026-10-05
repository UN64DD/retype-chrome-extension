// Retype content script: editable-element detection, the typing engine, and
// message handling for the popup.
//
// Runs in the page (top frame). The popup sends commands here; progress is
// pushed back with STATUS_UPDATE messages.

(() => {
  'use strict';

  // ------------------------------------------------------------ Session state

  const state = {
    status: 'ready', // ready | typing | paused | completed | stopped | error
    text: '',
    total: 0,
    index: 0,
    delay: 50,
    target: null,
    // Incremented to cancel a running typing loop (on stop/clear/new start).
    // Each loop captures the value it was started with and exits as soon as it
    // no longer matches, so old loops can never keep typing.
    runId: 0,
  };

  // -------------------------------------------------- Editable element checks

  const INPUT_TYPES_OK = ['text', 'search', 'url', 'tel', 'email', 'password', ''];

  function isEditable(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toUpperCase();
    if (tag === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      return INPUT_TYPES_OK.includes(type) && !el.disabled && !el.readOnly;
    }
    // isContentEditable also covers contenteditable="" and inherited values.
    return el.isContentEditable === true;
  }

  // Returns the element the user should type into, or null.
  function getActiveEditableElement() {
    let el = document.activeElement;
    if (isEditable(el)) return el;
    if (isGoogleDocs()) {
      // Google Docs often uses a contenteditable element with role="textbox"
      // as the main editing surface. Try to find one.
      el = document.querySelector('[contenteditable="true"], [role="textbox"], .docs-texteventtarget-iframe');
      if (isEditable(el)) return el;
      // Sometimes it's in an iframe; but we have all_frames - try common selectors in document
      const candidates = document.querySelectorAll('[contenteditable="true"], [role="textbox"]');
      for (let i = 0; i < candidates.length; i++) {
        if (isEditable(candidates[i])) return candidates[i];
      }
    }
    return null;
  }

  // ------------------------------------------------------- Page detection

  function isGoogleDocs() {
    try {
      return /docs\.google\.com/.test(location.hostname);
    } catch (err) {
      return false;
    }
  }

  // ------------------------------------------------------- Character insert

  // For <textarea>/<input> we set .value through the *native* setter and then
  // dispatch an InputEvent. Using the native setter means any page framework
  // listening for real user input (and simple pages listening for "input")
  // sees the change, and the field behaves as if the user typed it.
  function setNativeValue(el, nextValue) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, nextValue);
    } else {
      el.value = nextValue;
    }
  }

  // Reads the caret, tolerating input types (number, email, ...) where the
  // selection API throws or returns null. Falls back to the end of the value.
  function getCaret(el) {
    try {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (typeof start === 'number' && typeof end === 'number') {
        return { start, end };
      }
    } catch (err) {
      // Some input types do not support the selection API.
    }
    const length = el.value.length;
    return { start: length, end: length };
  }

  function insertIntoValue(el, char) {
    const caret = getCaret(el);
    const next = el.value.slice(0, caret.start) + char + el.value.slice(caret.end);
    setNativeValue(el, next);

    const newCaret = caret.start + char.length;
    try {
      el.setSelectionRange(newCaret, newCaret);
    } catch (err) {
      // Same as above: not all input types allow setting the caret.
    }

    // inputType/data describe the edit, mirroring real keyboard input.
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char }));
  }

  // Puts the selection inside the contenteditable element (at its end if the
  // caret is elsewhere), so insertText/insertLineBreak target the right place.
  function ensureCaretIn(el) {
    const sel = window.getSelection();
    if (!sel) return;
    if (sel.rangeCount && el.contains(sel.anchorNode)) return;

    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // collapse to the end
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function insertManually(el, node) {
    const sel = window.getSelection();
    const range = document.createRange();
    if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
      range.setStart(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
    } else {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  }

  function insertIntoContenteditable(el, char) {
    ensureCaretIn(el);

    if (char === '\n') {
      // execCommand is deprecated but still the most faithful way to simulate
      // typing: it keeps native undo/redo. Whether it fires an input event
      // itself varies, so watch for one during the synchronous call and only
      // dispatch our own if it didn't - exactly one input event per character.
      let inputFired = false;
      const markInput = () => { inputFired = true; };
      el.addEventListener('input', markInput);
      let ok = false;
      try {
        ok = document.execCommand('insertLineBreak');
      } finally {
        el.removeEventListener('input', markInput);
      }
      if (ok) {
        if (!inputFired) {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }));
        }
        return;
      }
      insertManually(el, document.createElement('br'));
      return;
    }

    if (document.execCommand('insertText', false, char)) {
      return; // fires the input event for us
    }

    if (char === ' ') {
      insertManually(el, document.createTextNode('\u00a0'));
    } else {
      insertManually(el, document.createTextNode(char));
    }
  }

  // Google Docs captures typed characters via synthetic keyboard events sent to
  // its internal document view (often in a contenteditable iframe or a canvas-
  // backed surface). Dispatching keydown/keypress/keyup with the correct
  // KeyboardEventInit allows Docs to process the character as if the user typed it.
  // This does *not* modify the DOM directly; Docs owns its own text model.
  function insertIntoGoogleDocs(el, char) {
    if (char === '\n') {
      const enterInit = {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        charCode: 13,
        composed: true,
      };
      el.dispatchEvent(new KeyboardEvent('keydown', enterInit));
      el.dispatchEvent(new KeyboardEvent('keypress', enterInit));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak', composed: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', enterInit));
      return;
    }

    const isSpace = char === ' ';
    const upper = char.toUpperCase();
    const code = isSpace ? 'Space' : (/^[A-Z]$/.test(upper) ? 'Key' + upper : '');
    const eventInit = {
      bubbles: true,
      cancelable: true,
      key: isSpace ? ' ' : char,
      code: code,
      charCode: char.charCodeAt(0),
      keyCode: char.charCodeAt(0),
      which: char.charCodeAt(0),
      composed: true,
    };

    // Some Docs surfaces expect keydown/keypress/keyup in order.
    el.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    if (char.length === 1) {
      el.dispatchEvent(new KeyboardEvent('keypress', eventInit));
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char, composed: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', eventInit));
  }

  function insertChar(el, char) {
    if (isGoogleDocs()) {
      insertIntoGoogleDocs(el, char);
      return;
    }
    const tag = el.tagName.toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      insertIntoValue(el, char);
    } else if (el.isContentEditable) {
      insertIntoContenteditable(el, char);
    } else {
      throw new Error('The focused field no longer supports typing.');
    }
  }

  // ---------------------------------------------------------- Progress report

  function report(extra) {
    const payload = Object.assign(
      {
        type: 'STATUS_UPDATE',
        current: state.index,
        total: state.total,
        status: state.status,
      },
      extra || {}
    );
    try {
      // Resolves as a promise in MV3; it rejects when the popup is closed,
      // which is normal, so swallow it.
      const sent = chrome.runtime.sendMessage(payload);
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch (err) {
      // Extension context invalidated (e.g. extension reloaded) - ignore.
    }
  }

  function fail(message) {
    state.status = 'error';
    state.runId += 1; // cancel any running loop
    report({ message });
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ----------------------------------------------------------- Typing engine

  async function run() {
    const myRun = ++state.runId;

    while (state.index < state.total) {
      if (state.runId !== myRun) return; // stopped, cleared, or restarted

      // Hold position while paused; check often so Stop stays responsive.
      while (state.status === 'paused' && state.runId === myRun) {
        await wait(50);
      }
      if (state.runId !== myRun || state.status !== 'typing') return;

      // The page may have navigated (SPA) or removed the field.
      if (!state.target || !document.contains(state.target)) {
        fail('The text field was removed from the page.\nClick into a text field and press Start.');
        return;
      }

      try {
        let ch = state.text[state.index];
        if (ch === '\r') ch = '\n';
        insertChar(state.target, ch);
      } catch (err) {
        fail('Typing failed: ' + err.message);
        return;
      }

      state.index += 1;
      report();

      // Delay between characters. If Stop/Pause arrives during this wait the
      // loop re-checks its flags before ever typing the next character.
      await wait(state.delay);
    }

    if (state.runId === myRun) {
      state.status = 'completed';
      report();
    }
  }

  // --------------------------------------------------------- Message handlers

  function handleStart(message) {
    const text = typeof message.text === 'string' ? message.text : '';
    const delay = message.delay;

    if (!text) {
      return { ok: false, error: 'Nothing to type. Paste or type some text first.' };
    }
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) {
      return { ok: false, error: 'Invalid typing speed. Use 0 or higher.' };
    }

    const target = getActiveEditableElement();
    if (!target) {
      return { ok: false, error: 'No editable field detected.\nClick inside a text field first.' };
    }

    // Cancel any previous loop before starting the new one.
    state.runId += 1;
    state.text = text;
    state.total = text.length;
    state.index = 0;
    state.delay = delay;
    state.target = target;
    state.status = 'typing';

    // The popup holds browser focus, but the page keeps its activeElement;
    // focus it again so the caret/selection are where we type.
    try {
      if (document.activeElement !== target) {
        try { target.focus(); } catch (e) {}
      }
      if (target.isContentEditable) {
        try { ensureCaretIn(target); } catch (e) {}
      }
      if (isGoogleDocs()) {
        // Ensure Docs receives focus on the editing surface
        try { target.click(); } catch (e) {}
      }
    } catch (err) {
      // Focus can fail on exotic elements; insertion still tries its best.
    }

    report();
    run(); // fire and forget; updates arrive via STATUS_UPDATE
    return { ok: true };
  }

  function handlePause() {
    if (state.status !== 'typing') {
      return { ok: false, error: 'Nothing is typing right now.' };
    }
    state.status = 'paused';
    report();
    return { ok: true };
  }

  function handleResume() {
    if (state.status !== 'paused') {
      return { ok: false, error: 'Typing is not paused.' };
    }
    state.status = 'typing';
    report();
    return { ok: true };
  }

  function handleStop() {
    if (state.status !== 'typing' && state.status !== 'paused') {
      return { ok: false, error: 'Nothing is typing right now.' };
    }
    state.runId += 1; // cancel the loop immediately
    state.status = 'stopped';
    report();
    return { ok: true, current: state.index, total: state.total };
  }

  function handleClear() {
    state.runId += 1;
    state.status = 'ready';
    state.text = '';
    state.total = 0;
    state.index = 0;
    state.target = null;
    report();
    return { ok: true };
  }

  function handleGetStatus() {
    return { ok: true, current: state.index, total: state.total, status: state.status };
  }

  const HANDLERS = {
    RETYPE_START: handleStart,
    RETYPE_PAUSE: handlePause,
    RETYPE_RESUME: handleResume,
    RETYPE_STOP: handleStop,
    RETYPE_CLEAR: handleClear,
    GET_STATUS: handleGetStatus,
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = HANDLERS[message && message.type];
    if (!handler) return undefined;
    const response = handler(message);
    sendResponse(response);
    return undefined; // synchronous response, no keep-alive needed
  });
})();
