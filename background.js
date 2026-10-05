// Retype background service worker.
//
// The toolbar button opens the side panel instead of a popup, because a popup
// closes the moment it loses focus - which meant it vanished as soon as you
// clicked into a text field on the page. The side panel stays open while you
// click and type anywhere on the page, on every site.

function enableSidePanel() {
  if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) return;
  // Requires Chrome/Edge 114+; guarded above so older browsers load fine.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(enableSidePanel);
chrome.runtime.onStartup.addListener(enableSidePanel);

enableSidePanel();