const { app, BrowserWindow, ipcMain, desktopCapturer, session, safeStorage, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const api = require('./api.cjs');

if (process.env.INTERVIEW_HELPER_DATA_DIR) app.setPath('userData', path.resolve(process.env.INTERVIEW_HELPER_DATA_DIR));
let window, selectedSource, mediaAllowed = false, compact = false, normalBounds;
const jobs = new Map();
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
const defaults = () => api.normalizeSettings({
  chat: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  asr: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  vision: {}, remember: true
});
let config = defaults();
let storageWarning = '';
const settingsPath = () => path.join(app.getPath('userData'), 'settings.enc');

async function loadSettings() {
  try {
    const encrypted = await fs.readFile(settingsPath());
    const decrypted = await safeStorage.decryptStringAsync(encrypted);
    config = api.normalizeSettings(JSON.parse(decrypted.result));
  } catch (error) {
    if (error.code !== 'ENOENT') storageWarning = '本地配置未能解密或读取，请重新配置；原文件尚未改动。';
  }
}

async function saveSettings(value) {
  const next = api.normalizeSettings(value, config);
  if (next.remember) {
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('系统加密存储不可用，请取消“保存到本机”，仅在本次运行使用');
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(next));
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    const temporary = `${settingsPath()}.tmp`;
    await fs.writeFile(temporary, encrypted);
    await fs.rename(temporary, settingsPath());
  } else {
    await fs.rm(settingsPath(), { force: true });
  }
  config = next;
  storageWarning = '';
  return api.publicSettings(config);
}

function cancelAll() { for (const controller of jobs.values()) controller.abort(); jobs.clear(); }

async function job(id, action) {
  jobs.get(id)?.abort();
  const controller = new AbortController();
  jobs.set(id, controller);
  const timeout = setTimeout(() => controller.abort(new Error('请求超时，请检查网络或模型服务')), 45000);
  try { return await action(controller.signal); }
  finally { clearTimeout(timeout); if (jobs.get(id) === controller) jobs.delete(id); }
}

function handle(name, action) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) return { ok: false, error: '拒绝非应用页面请求' };
    try { return { ok: true, value: await action(...args) }; }
    catch (error) {
      const message = error.name === 'AbortError' ? '请求已取消' : error instanceof SyntaxError ? 'API 返回内容格式无效，请检查接口兼容性' : error instanceof TypeError ? '网络请求失败，请检查 API 地址、网络和代理设置' : error.message;
      return { ok: false, error: message };
    }
  });
}

app.whenReady().then(async () => {
  await loadSettings();
  window = new BrowserWindow({
    width: 1280, height: 850, minWidth: 420, minHeight: 520, show: process.env.INTERVIEW_HELPER_HEADLESS !== '1',
    title: '临场面试提示器', backgroundColor: '#f5f6f8', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  const trusted = contents => contents === window.webContents && contents.getURL() === page;
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(trusted(contents) && mediaAllowed && permission === 'media' && details.mediaTypes?.every(type => type === 'audio'));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
    return trusted(contents) && mediaAllowed && permission === 'media' && details.mediaType === 'audio';
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const chosen = selectedSource;
    selectedSource = null;
    if (request.frame !== window.webContents.mainFrame || !chosen || Date.now() - chosen.time > 30000) { callback(null); return; }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(item => item.id === chosen.id);
      callback(source ? { video: source, ...(request.audioRequested ? { audio: 'loopback' } : {}) } : null);
    } catch { callback(null); }
  });

  handle('settings:load', () => ({ settings: api.publicSettings(config), warning: storageWarning }));
  handle('settings:save', value => {
    if (mediaAllowed) throw new Error('请先停止采集，再修改配置');
    return saveSettings(value);
  });
  handle('settings:clear', async () => {
    cancelAll(); mediaAllowed = false; selectedSource = null;
    await fs.rm(settingsPath(), { force: true });
    await fs.rm(`${settingsPath()}.tmp`, { force: true });
    config = defaults(); return api.publicSettings(config);
  });
  handle('capture:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 300, height: 170 } });
    return sources.filter(source => source.name !== window.getTitle()).map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() }));
  });
  handle('capture:select', async id => {
    if (typeof id !== 'string' || id.length > 200) throw new Error('画面来源无效');
    api.requireProvider(config.chat); api.requireProvider(config.asr);
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    if (!sources.some(source => source.id === id)) throw new Error('所选窗口已关闭，请重新选择');
    selectedSource = { id, time: Date.now() }; mediaAllowed = true;
  });
  handle('session:stop', () => { selectedSource = null; mediaAllowed = false; cancelAll(); });
  handle('audio:transcribe', (audio, channel) => {
    if (!mediaAllowed || !['system', 'mic'].includes(channel)) throw new Error('尚未开始音频采集');
    if (jobs.has(`asr-${channel}`)) throw new Error('上一个音频分块仍在转写');
    return job(`asr-${channel}`, signal => api.transcribe(config.asr, audio, signal));
  });
  handle('hint:generate', (id, transcript, visual) => {
    if (!Number.isSafeInteger(id)) throw new Error('请求编号无效');
    const messages = api.messagesFor(config, transcript, visual);
    return job('hint', signal => api.chat(config.chat, messages, signal, chunk => {
      if (!signal.aborted && !window.isDestroyed()) window.webContents.send('hint:chunk', { id, chunk });
    }));
  });
  handle('vision:observe', image => {
    if (!mediaAllowed) throw new Error('尚未开始画面采集');
    return job('vision', signal => api.observe(config.visionUsesChat ? config.chat : config.vision, image, signal));
  });
  handle('api:test', name => {
    if (!['chat', 'asr', 'vision'].includes(name)) throw new Error('API 类型无效');
    const provider = name === 'vision' && config.visionUsesChat ? config.chat : config[name];
    return job(`test-${name}`, async signal => {
      if (name === 'asr') {
        const { encodeWav } = await import('./audio.mjs');
        await api.transcribe(provider, encodeWav(new Float32Array(16000), 16000), signal);
      } else if (name === 'vision') {
        // 真实测试图像输入，避免只验证文本却声称视觉可用。
        const { nativeImage } = require('electron');
        const image = nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 255), { width: 32, height: 32 }).toJPEG(70);
        await api.observe(provider, `data:image/jpeg;base64,${image.toString('base64')}`, signal);
      } else await api.chat(provider, [{ role: 'user', content: '请只回复 OK' }], signal);
      return '接口测试通过';
    });
  });
  handle('window:pin', value => { window.setAlwaysOnTop(Boolean(value)); return window.isAlwaysOnTop(); });
  handle('window:compact', () => {
    compact = !compact;
    if (compact) { normalBounds = window.getBounds(); window.setSize(480, 700); }
    else window.setBounds(normalBounds);
    return compact;
  });
  handle('transcript:export', async value => {
    if (typeof value !== 'string' || value.length > 2000000) throw new Error('导出内容无效或过大');
    const { canceled, filePath } = await dialog.showSaveDialog(window, { defaultPath: `面试转写-${new Date().toISOString().slice(0, 10)}.txt`, filters: [{ name: '文本文件', extensions: ['txt'] }] });
    if (!canceled && filePath) await fs.writeFile(filePath, value, 'utf8');
    return !canceled;
  });
  window.on('closed', () => { cancelAll(); window = null; });
  await window.loadFile(path.join(__dirname, 'index.html'));
}).catch(error => { console.error('应用启动失败:', error.message); app.quit(); });

app.on('window-all-closed', () => app.quit());
