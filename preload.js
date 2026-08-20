/**
 * The only bridge between the renderer and Node.
 *
 * Deliberately a fixed list of verbs rather than anything that forwards an
 * arbitrary channel name: the renderer runs a SIP stack against a remote
 * server, so it is the part of this app most worth keeping on a short leash.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dialtone', {
  /** True only when main was started with --dev. Gates debug-only hooks. */
  dev: process.argv.includes('--dialtone-dev'),
  store: {
    load: () => ipcRenderer.invoke('store:load'),
    saveSettings: (settings) => ipcRenderer.invoke('store:saveSettings', settings),
    saveContacts: (contacts) => ipcRenderer.invoke('store:saveContacts', contacts),
    saveHistory: (history) => ipcRenderer.invoke('store:saveHistory', history),
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onState: (fn) => ipcRenderer.on('window:state', (_e, state) => fn(state)),
    attention: () => ipcRenderer.invoke('window:attention'),
    stopAttention: () => ipcRenderer.invoke('window:stopAttention'),
  },
  config: {
    export: (opts) => ipcRenderer.invoke('config:export', opts || {}),
    import: () => ipcRenderer.invoke('config:import'),
  },
  startup: {
    get: () => ipcRenderer.invoke('startup:get'),
    set: (enabled) => ipcRenderer.invoke('startup:set', enabled),
  },
  tray: {
    registration: (state) => ipcRenderer.invoke('tray:registration', state),
  },
  callToast: {
    /** Report call state; main decides whether the popup is warranted. */
    sync: (call) => ipcRenderer.invoke('toast:sync', call),
    /** The popup's Answer / Decline buttons come back through here. */
    onAnswer: (fn) => ipcRenderer.on('call:answer', () => fn()),
    onHangup: (fn) => ipcRenderer.on('call:hangup', () => fn()),
  },
  power: {
    keepAwake: (on) => ipcRenderer.invoke('power:keepAwake', on),
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  },
  certs: {
    trust: (info) => ipcRenderer.invoke('cert:trust', info),
    list: () => ipcRenderer.invoke('cert:list'),
    forget: (host) => ipcRenderer.invoke('cert:forget', host),
    onUntrusted: (fn) => ipcRenderer.on('cert:untrusted', (_e, info) => fn(info)),
  },
});
