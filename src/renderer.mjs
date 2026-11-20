import { AudioCapture, splitHint } from './audio.mjs';

const $ = id => document.getElementById(id);
const bridge = window.helper;
const labels = { system: '会议声音', mic: '我的麦克风', manual: '手动问题' };
let settings, transcript = [], hintText = '', visual = '', visualAt = 0;
let active = false, starting = false, epoch = 0, hintId = 0, hintBusy = false, demoMode = false;
let streams = [], capture, startedAt = 0, tick, visualTimer, hintTimer, visualBusy = false;
let queues = { system: [], mic: [] }, workers = { system: false, mic: false }, failures = { system: 0, mic: 0 };
let notificationTimer, sourceLoading = false, saving = false;

function notify(message, error = false) {
  clearTimeout(notificationTimer);
  $('notification-text').textContent = message;
  $('notification').classList.toggle('error', error);
  $('notification').hidden = false;
  if (!error) notificationTimer = setTimeout(() => $('notification').hidden = true, 6000);
}
function on(id, event, action) {
  $(id).addEventListener(event, async event => {
    try { await action(event); } catch (error) { notify(error.message || '操作未完成', true); }
  });
}
function tab(name) {
  document.querySelectorAll('.page').forEach(page => page.hidden = page.id !== name);
  document.querySelectorAll('[data-tab]').forEach(button => {
    button.classList.toggle('active', button.dataset.tab === name);
    if (button.dataset.tab === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

for (const [name, title, description] of [
  ['chat', '回答模型', '生成回答要点和口述稿'],
  ['asr', '语音转写', '把会议声音转换为文字'],
  ['vision', '画面分析', '可选，需要支持图片输入']
]) {
  const section = document.createElement('section');
  section.className = 'provider panel';
  section.innerHTML = `<h2>${title}</h2><p class="caption">${description}</p>${name === 'vision' ? '<label class="check-label"><input id="visionUsesChat" type="checkbox" checked>沿用回答模型的配置</label>' : ''}<div id="${name}-fields"><label for="${name}-base">Base URL</label><input id="${name}-base" type="url" spellcheck="false" placeholder="https://api.example.com/v1" maxlength="2048"><label for="${name}-model">模型名</label><input id="${name}-model" spellcheck="false" placeholder="服务商提供的模型 ID" maxlength="200"><label for="${name}-key">API Key</label><input id="${name}-key" type="password" autocomplete="off" spellcheck="false" placeholder="填写 API Key" maxlength="8192"></div><button id="test-${name}" class="secondary test-api">测试${title}</button>`;
  $('providers').append(section);
  on(`test-${name}`, 'click', async () => {
    if (active || starting) throw new Error('请先停止采集，再测试 API');
    const button = $(`test-${name}`);
    button.disabled = true; button.textContent = '正在测试…';
    try { await persist(); notify(await bridge.test(name)); }
    finally { button.disabled = false; button.textContent = `测试${title}`; }
  });
}

function fillSettings(value) {
  settings = value;
  for (const field of ['resume', 'role', 'ideas', 'language']) $(field).value = value.profile[field];
  for (const name of ['chat', 'asr', 'vision']) {
    $(`${name}-base`).value = value[name].baseUrl;
    $(`${name}-model`).value = value[name].model;
    $(`${name}-key`).value = '';
    $(`${name}-key`).placeholder = value[name].hasKey ? '已保存，留空继续使用' : '填写 API Key（本机服务可留空）';
  }
  $('remember').checked = value.remember;
  $('visionUsesChat').checked = value.visionUsesChat;
  $('vision-fields').hidden = value.visionUsesChat;
}
function formSettings() {
  const result = { profile: {}, remember: $('remember').checked, visionUsesChat: $('visionUsesChat').checked };
  for (const field of ['resume', 'role', 'ideas', 'language']) result.profile[field] = $(field).value;
  for (const name of ['chat', 'asr', 'vision']) result[name] = { baseUrl: $(`${name}-base`).value, model: $(`${name}-model`).value, apiKey: $(`${name}-key`).value };
  return result;
}
async function persist() {
  if (saving) throw new Error('配置正在保存，请稍候');
  saving = true;
  try { fillSettings(await bridge.saveSettings(formSettings())); }
  finally { saving = false; }
}
async function save() {
  if (active || starting) throw new Error('请先停止采集，再修改配置或准备内容');
  await persist(); notify($('remember').checked ? '已加密保存到本机' : '已应用，仅本次运行有效');
}

function renderHint(value) {
  const parts = splitHint(value);
  $('points').textContent = parts.points || '正在组织回答要点…';
  $('draft').textContent = parts.draft || '口述稿正在生成…';
  $('check').textContent = parts.check;
  $('check-wrap').hidden = !parts.check;
}
function renderTranscript() {
  const container = $('transcript');
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 70;
  container.replaceChildren();
  for (const item of transcript) {
    const row = document.createElement('div'); row.className = `transcript-entry ${item.source}`;
    const meta = document.createElement('div'); meta.className = 'entry-meta';
    const label = document.createElement('strong'); label.textContent = labels[item.source];
    const time = document.createElement('span'); time.textContent = item.time;
    const content = document.createElement('p'); content.textContent = item.text;
    meta.append(label, time); row.append(meta, content); container.append(row);
  }
  if (nearBottom) container.scrollTop = container.scrollHeight;
  $('regenerate').disabled = !transcript.length;
}
function appendTranscript(source, text, time = new Date().toLocaleTimeString('zh-CN', { hour12: false }), at = Date.now()) {
  if (!text.trim()) return;
  transcript.push({ source, text: text.trim(), time, at });
  transcript.sort((a, b) => a.at - b.at);
  renderTranscript();
}
function discardDemo() {
  if (!demoMode) return;
  demoMode = false; transcript = []; hintText = ''; visual = ''; visualAt = 0;
  renderTranscript(); $('hint-state').textContent = '等待问题';
  $('points').textContent = '先听清问题，再把重点说具体。';
  $('draft').textContent = '生成提示后，这里会出现可供参考的完整表达。';
  $('check-wrap').hidden = true;
}
async function generate(manual = false) {
  if (!transcript.length) return;
  if (demoMode) { notify('这是本地示例。输入自己的问题或开始采集后，会调用你配置的 API。'); return; }
  if (manual && !active) await persist();
  const id = ++hintId;
  hintBusy = true; hintText = '';
  $('hint-state').textContent = '正在生成…';
  $('points').textContent = '正在结合你的经历组织回答…';
  $('draft').textContent = '口述稿正在生成…'; $('check-wrap').hidden = true;
  try {
    const freshVisual = visualAt && Date.now() - visualAt < 60000 ? visual : '';
    const result = await bridge.generate(id, transcript.slice(-50), freshVisual);
    if (id !== hintId) return;
    hintText = result; renderHint(result);
    $('hint-state').textContent = `已更新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  } catch (error) {
    if (id !== hintId) return;
    $('hint-state').textContent = '生成失败';
    if (!hintText) $('points').textContent = '暂未生成提示。检查 API 配置后可重新生成。';
    else $('hint-state').textContent = '生成中断，内容不完整';
    notify(error.message, true);
  } finally { if (id === hintId) hintBusy = false; }
}
bridge.onHint(({ id, chunk }) => { if (id === hintId && hintBusy) { hintText += chunk; renderHint(hintText); } });

function setCaptureUI() {
  const busy = active || starting;
  $('start').disabled = busy; $('stop').disabled = !busy;
  $('session-state').classList.toggle('is-live', active);
  $('session-state').replaceChildren();
  const dot = document.createElement('span'); dot.className = 'status-dot';
  $('session-state').append(dot, document.createTextNode(starting ? '正在连接采集…' : active ? '采集中' : '采集已停止'));
  document.querySelectorAll('.form-page input,.form-page textarea,.form-page select,.form-page button').forEach(input => input.disabled = busy);
}
function updatePending() { $('pending-state').textContent = active ? `待转写 ${queues.system.length + queues.mic.length + Number(workers.system) + Number(workers.mic)} 段` : ''; }
async function processQueue(channel, currentEpoch) {
  if (workers[channel]) return;
  workers[channel] = true; updatePending();
  try {
    while (active && epoch === currentEpoch && queues[channel].length) {
      const item = queues[channel].shift(); updatePending();
      try {
        const content = await bridge.transcribe(item.audio, channel);
        if (!active || epoch !== currentEpoch) return;
        failures[channel] = 0;
        appendTranscript(channel, content, item.time, item.at);
        if (content.trim() && channel === 'system') {
          clearTimeout(hintTimer);
          hintTimer = setTimeout(() => { if (active && epoch === currentEpoch) void generate(); }, 900);
        }
      } catch (error) {
        if (!active || epoch !== currentEpoch) return;
        if (++failures[channel] >= 3) { await stop(); notify(`连续转写失败，已停止采集：${error.message}`, true); return; }
        notify(`${labels[channel]}转写失败，本段未保存：${error.message}`, true);
      }
    }
  } finally { if (epoch === currentEpoch) { workers[channel] = false; updatePending(); } }
}
function enqueue(channel, audio, currentEpoch) {
  if (!active || epoch !== currentEpoch) return;
  if (queues[channel].length >= 3) {
    void stop().then(() => notify('转写接口速度跟不上采集，已停止采集以避免持续积压。可更换更快的转写服务。', true)); return;
  }
  queues[channel].push({ audio, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), at: Date.now() });
  void processQueue(channel, currentEpoch);
}

async function analyzeFrame(currentEpoch) {
  if (!active || visualBusy || epoch !== currentEpoch || !$('use-video').checked) return;
  const video = $('preview');
  if (!video.videoWidth || video.readyState < 2) return;
  visualBusy = true;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(960, video.videoWidth); canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const result = await bridge.observe(canvas.toDataURL('image/jpeg', .65));
    if (!active || epoch !== currentEpoch) return;
    visual = result; visualAt = Date.now();
    $('visual').textContent = result; $('visual-time').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    $('video-state').textContent = '画面分析开启';
  } catch (error) {
    if (active && epoch === currentEpoch) {
      clearInterval(visualTimer); visual = ''; visualAt = 0;
      $('video-state').textContent = '画面分析暂停'; $('visual').textContent = `画面分析失败，音频采集继续：${error.message}`;
      notify('画面分析失败，已暂停截图上传。音频采集继续。', true);
    }
  } finally { if (epoch === currentEpoch) visualBusy = false; }
}

async function start(id) {
  if (active || starting) return;
  starting = true; const currentEpoch = ++epoch; setCaptureUI();
  $('source-dialog').close();
  try {
    await persist();
    if (epoch !== currentEpoch) return;
    discardDemo();
    await bridge.selectSource(id);
    if (epoch !== currentEpoch) { await bridge.stop(); return; }
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, systemAudio: 'include' });
    if (epoch !== currentEpoch) { display.getTracks().forEach(track => track.stop()); return; }
    streams.push(display);
    if (!display.getAudioTracks().length) throw new Error('系统没有提供声音轨道，请检查音频设备与 Windows 权限');
    const inputs = [{ stream: new MediaStream(display.getAudioTracks()), source: 'system' }];
    if ($('use-mic').checked) {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (epoch !== currentEpoch) { mic.getTracks().forEach(track => track.stop()); return; }
      streams.push(mic); inputs.push({ stream: mic, source: 'mic' });
      mic.getAudioTracks()[0].addEventListener('ended', () => { if (active && epoch === currentEpoch) void stop().then(() => notify('麦克风已断开，采集已停止。', true)); });
    }
    display.getVideoTracks()[0].addEventListener('ended', () => { if (active && epoch === currentEpoch) void stop().then(() => notify('会议画面来源已结束，采集已停止。')); });
    active = true; starting = false; startedAt = Date.now();
    visual = ''; visualAt = 0; visualBusy = false;
    $('visual-time').textContent = '';
    $('visual').textContent = $('use-video').checked ? '等待第一帧观察。仅描述可见行为，不推断真实情绪。' : '未开启画面分析，不上传截图。';
    $('preview').srcObject = display; $('preview').hidden = !$('use-video').checked;
    await $('preview').play();
    if (epoch !== currentEpoch) return;
    capture = new AudioCapture((channel, audio) => enqueue(channel, audio, currentEpoch), (channel, level) => {
      if (epoch === currentEpoch) $(`${channel}-level`).value = level;
    });
    await capture.start(inputs);
    if (epoch !== currentEpoch) return;
    $('video-state').textContent = $('use-video').checked ? '画面分析开启' : '画面分析关闭';
    tick = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      $('clock').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }, 1000);
    if ($('use-video').checked) {
      void analyzeFrame(currentEpoch);
      visualTimer = setInterval(() => void analyzeFrame(currentEpoch), 20000);
    }
    setCaptureUI();
    notify('已开始采集；有声音的分块约每六秒转写一次。停止时未满六秒的尾段会丢弃。');
  } catch (error) {
    if (epoch === currentEpoch) { await stop(); notify(`无法开始采集：${error.message}`, true); }
  }
}
async function stop() {
  ++epoch; ++hintId; active = false; starting = false; hintBusy = false;
  clearInterval(tick); clearInterval(visualTimer); clearTimeout(hintTimer);
  for (const stream of streams) stream.getTracks().forEach(track => track.stop());
  streams = []; $('preview').pause(); $('preview').srcObject = null; $('preview').hidden = true;
  await capture?.stop(); capture = null;
  queues = { system: [], mic: [] }; workers = { system: false, mic: false }; failures = { system: 0, mic: 0 }; visualBusy = false;
  await bridge.stop();
  $('system-level').value = 0; $('mic-level').value = 0; $('video-state').textContent = '画面采集已停止';
  if ($('hint-state').textContent === '正在生成…') $('hint-state').textContent = '已停止更新';
  setCaptureUI(); updatePending();
}

on('start', 'click', async () => {
  if (sourceLoading) return;
  await persist();
  if (!settings.chat.baseUrl || !settings.chat.model || !settings.asr.baseUrl || !settings.asr.model) { tab('settings'); throw new Error('请先配置回答和语音转写 API'); }
  sourceLoading = true;
  $('source-list').textContent = '正在查找窗口和屏幕…'; $('source-dialog').showModal();
  try {
    const sources = await bridge.sources(); $('source-list').replaceChildren();
    if (!sources.length) $('source-list').textContent = '没有可用的画面来源，请打开会议窗口后重试。';
    for (const source of sources) {
      const button = document.createElement('button'); button.className = 'source-option';
      const image = document.createElement('img'); image.src = source.thumbnail; image.alt = '';
      const name = document.createElement('span'); name.textContent = source.name;
      button.append(image, name); button.addEventListener('click', () => void start(source.id)); $('source-list').append(button);
    }
  } finally { sourceLoading = false; }
});
on('stop', 'click', stop);
on('close-source', 'click', () => $('source-dialog').close());
on('save-profile', 'click', save); on('save-settings', 'click', save);
on('visionUsesChat', 'change', () => $('vision-fields').hidden = $('visionUsesChat').checked);
on('resume-file', 'change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (!/\.(txt|md)$/i.test(file.name) || file.size > 1024 * 1024) throw new Error('请导入 1 MB 以内的 TXT 或 Markdown 文件');
  const content = await file.text();
  if (content.length > 40000 || content.includes('\0')) throw new Error('文本过长或文件不是纯文本');
  const combined = $('resume').value.trim() ? `${$('resume').value}\n\n${content}` : content;
  if (combined.length > 40000) throw new Error('合并后的简历超过 40000 字符，请精简后导入');
  $('resume').value = combined;
  event.target.value = ''; notify('已导入，点击“保存准备内容”后生效');
});
on('question-form', 'submit', async event => {
  event.preventDefault();
  const text = $('question').value.trim();
  if (!text) { $('question').focus(); throw new Error('请先输入面试问题'); }
  discardDemo(); appendTranscript('manual', text); $('question').value = '';
  clearTimeout(hintTimer); await generate(true);
});
on('regenerate', 'click', () => generate(true));
on('export', 'click', async () => {
  if (!transcript.length) throw new Error('还没有可导出的对话记录');
  const output = `${demoMode ? '本地演示数据\n\n' : ''}${transcript.map(item => `[${item.time}] ${labels[item.source]}\n${item.text}`).join('\n\n')}\n\n最近一次回答提示（仅供参考）\n${hintText}`;
  if (await bridge.exportTranscript(output)) notify('转写与最近一次提示已导出');
});
on('pin', 'click', async () => { const pinned = await bridge.pin($('pin').getAttribute('aria-pressed') !== 'true'); $('pin').setAttribute('aria-pressed', String(pinned)); $('pin').textContent = pinned ? '已置顶' : '置顶'; });
on('compact', 'click', async () => { const compact = await bridge.compact(); document.body.classList.toggle('compact', compact); $('compact').textContent = compact ? '返回工作台' : '进入小窗'; if (compact) tab('workspace'); });
on('dismiss-notification', 'click', () => $('notification').hidden = true);
on('clear-settings', 'click', () => $('clear-dialog').showModal());
on('cancel-clear', 'click', () => $('clear-dialog').close());
on('confirm-clear', 'click', async () => {
  await stop(); fillSettings(await bridge.clearSettings());
  transcript = []; hintText = ''; demoMode = false; visual = ''; visualAt = 0;
  renderTranscript(); $('points').textContent = '先听清问题，再把重点说具体。'; $('draft').textContent = '生成提示后，这里会出现可供参考的完整表达。';
  $('visual').textContent = '未开启画面分析。'; $('visual-time').textContent = ''; $('check-wrap').hidden = true;
  $('hint-state').textContent = '等待问题'; $('clear-dialog').close(); notify('本机准备内容与 API 配置已清除');
});
on('demo', 'click', () => {
  demoMode = true; transcript = [];
  appendTranscript('system', '能讲一个你在团队项目中解决问题的例子吗？', '示例');
  appendTranscript('mic', '我想用课程项目举例，讲清楚自己负责的部分。', '示例');
  hintText = '【回答要点】\n1. 用一句话交代项目目标与遇到的困难。\n2. 讲清你亲自做的两件事，以及判断依据。\n3. 用真实结果收尾，补充一次复盘。\n【口述稿】\n“我想用［项目名称］举例。当时我们要完成［目标］，但遇到了［具体问题］。我负责［个人职责］。我先［排查动作］，发现［原因］，随后通过［具体措施］推动解决。最终［可验证结果］。这段经历让我学到［复盘收获］。”\n【需确认】\n这是本地示例，没有调用 API。方括号是需要补充的真实事实，不代表你的经历。';
  renderHint(hintText); $('hint-state').textContent = '本地示例，不调用 API';
});
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => tab(button.dataset.tab)));
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); tab('workspace'); });
window.addEventListener('beforeunload', () => { for (const stream of streams) stream.getTracks().forEach(track => track.stop()); });
try {
  const loaded = await bridge.loadSettings(); fillSettings(loaded.settings);
  if (loaded.warning) notify(loaded.warning, true);
} catch (error) { notify(`配置加载失败：${error.message}`, true); }
