/**
 * Bridge for the call popup only.
 *
 * A much smaller surface than the main preload: this window shows a name and
 * two buttons, so it gets exactly the verbs for that and nothing else. It
 * cannot read settings, touch the store, or reach the SIP stack.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dialtoneToast', {
  onCall: (fn) => ipcRenderer.on('toast:call', (_e, call) => fn(call)),
  onTheme: (fn) => ipcRenderer.on('toast:theme', (_e, theme) => fn(theme)),
  onDismiss: (fn) => ipcRenderer.on('toast:dismiss', () => fn()),

  answer: () => ipcRenderer.send('toast:answer'),
  decline: () => ipcRenderer.send('toast:decline'),
  hangup: () => ipcRenderer.send('toast:decline'),
  open: () => ipcRenderer.send('toast:open'),
  /** Sent once the slide-out has finished, so main hides the window then. */
  dismissed: () => ipcRenderer.send('toast:dismissed'),
});
