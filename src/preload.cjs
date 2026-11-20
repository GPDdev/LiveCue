const { contextBridge, ipcRenderer } = require('electron');
async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
contextBridge.exposeInMainWorld('helper', {
  loadSettings: () => invoke('settings:load'),
  saveSettings: value => invoke('settings:save', value),
  clearSettings: () => invoke('settings:clear'),
  sources: () => invoke('capture:sources'),
  selectSource: id => invoke('capture:select', id),
  stop: () => invoke('session:stop'),
  transcribe: (audio, channel) => invoke('audio:transcribe', audio, channel),
  generate: (id, transcript, visual) => invoke('hint:generate', id, transcript, visual),
  observe: image => invoke('vision:observe', image),
  test: name => invoke('api:test', name),
  pin: value => invoke('window:pin', value),
  compact: () => invoke('window:compact'),
  exportTranscript: value => invoke('transcript:export', value),
  onHint: listener => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('hint:chunk', handler);
    return () => ipcRenderer.removeListener('hint:chunk', handler);
  }
});
