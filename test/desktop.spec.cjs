const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const answer = '【回答要点】\n先说明项目目标，再讲你的具体贡献。\n【口述稿】\n我在课程项目中负责数据处理，先排查输入，再验证结果。\n【需确认】\n项目结果需要补充真实数据。';
let server, base, records, responseStatus, slow, desktop, page, dataDir;

test.beforeEach(async () => {
  records = []; responseStatus = 200; slow = false;
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const record = { path: req.url, type: req.headers['content-type'], raw };
    if (record.type?.includes('application/json')) record.body = JSON.parse(raw);
    records.push(record);
    if (responseStatus !== 200) { res.writeHead(responseStatus); res.end('private-demo-key should never be shown'); return; }
    if (req.url.endsWith('/audio/transcriptions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: '请介绍一个你亲自参与的项目。' })); return;
    }
    const vision = Array.isArray(record.body.messages.at(-1).content);
    const newer = !vision && record.body.messages.at(-1).content.includes('第二个问题');
    const result = vision ? '可见一个测试画面，无法判断人物身份或真实心情。' : newer ? answer.replace('具体贡献', '新问题专用回答') : answer;
    if (slow && !vision) await new Promise(resolve => setTimeout(resolve, newer ? 50 : 1500));
    if (res.destroyed) return;
    if (record.body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const content of result.match(/.{1,10}/gs)) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      res.end('data: [DONE]\n\n');
    } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: result } }] })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/v1`;
  await fs.mkdir(path.join(root, '.test-data'), { recursive: true });
  dataDir = await fs.mkdtemp(path.join(root, '.test-data', 'desktop-'));
  await launch();
});
async function launch() {
  const env = { ...process.env, INTERVIEW_HELPER_DATA_DIR: dataDir, INTERVIEW_HELPER_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.INTERVIEW_HELPER_EXECUTABLE;
  desktop = await electron.launch({ executablePath, args: executablePath ? [] : [root], cwd: root, env });
  page = await desktop.firstWindow();
  await expect(page.locator('#resume')).toHaveValue('');
}
test.afterEach(async () => {
  await desktop?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
async function configure() {
  await page.getByRole('button', { name: '面试准备', exact: true }).click();
  await page.locator('#resume').fill('同济大学，课程项目负责数据处理。');
  await page.locator('#role').fill('机器人软件实习');
  await page.locator('#ideas').fill('希望清楚说明个人贡献。');
  await page.getByRole('button', { name: 'API 设置', exact: true }).click();
  for (const name of ['chat', 'asr']) {
    await page.locator(`#${name}-base`).fill(base);
    await page.locator(`#${name}-model`).fill(`test-${name}`);
    await page.locator(`#${name}-key`).fill('private-demo-key');
  }
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.locator('#notification-text')).toHaveText('已加密保存到本机');
}

test('本地示例、小窗和不同窗口宽度可用，无运行时错误', async () => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '体验本地示例' }).click();
  await expect(page.locator('#hint-state')).toHaveText('本地示例，不调用 API');
  await expect(page.locator('#points')).toContainText('你亲自做的两件事');
  expect(records).toHaveLength(0);
  await page.getByRole('button', { name: '进入小窗' }).click();
  await expect(page.locator('body')).toHaveClass('compact');
  await expect(page.locator('#suggestion-title')).toBeVisible();
  await expect(page.locator('#start')).toBeVisible();
  await page.getByRole('button', { name: '返回工作台' }).click();
  await fs.mkdir(path.join(root, 'outputs'), { recursive: true });
  for (const width of [1280, 768, 440]) {
    await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 850), width);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const screenshot = await desktop.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      return image.toPNG().toString('base64');
    });
    await fs.writeFile(path.join(root, 'outputs', `workspace-${width}.png`), Buffer.from(screenshot, 'base64'));
  }
  expect(await page.evaluate(() => typeof require)).toBe('undefined');
  expect(errors).toEqual([]);
});

test('准备资料、加密持久化、流式提示及重启恢复完整跑通', async () => {
  await configure();
  const encrypted = await fs.readFile(path.join(dataDir, 'settings.enc'));
  expect(encrypted.includes(Buffer.from('private-demo-key'))).toBe(false);
  expect(encrypted.includes(Buffer.from('同济大学'))).toBe(false);
  await page.getByRole('button', { name: '面试工作台', exact: true }).click();
  await page.locator('#question').fill('介绍一下你的课程项目？');
  await page.getByRole('button', { name: '生成提示', exact: true }).click();
  await expect(page.locator('#hint-state')).toContainText('已更新');
  await expect(page.locator('#points')).toContainText('具体贡献');
  await page.locator('#draft-details summary').click();
  await expect(page.locator('#draft')).toContainText('负责数据处理');
  expect(JSON.parse(records[0].body.messages[1].content).resume).toContain('同济大学');
  await desktop.close();
  const env = { ...process.env, INTERVIEW_HELPER_DATA_DIR: dataDir, INTERVIEW_HELPER_HEADLESS: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ args: [root], cwd: root, env }); page = await desktop.firstWindow();
  await expect(page.locator('#resume')).toHaveValue('同济大学，课程项目负责数据处理。');
  await expect(page.locator('#chat-key')).toHaveValue('');
  await expect(page.locator('#chat-key')).toHaveAttribute('placeholder', '已保存，留空继续使用');
  await page.getByRole('button', { name: 'API 设置', exact: true }).click();
  await page.getByRole('button', { name: '测试语音转写', exact: true }).click();
  await expect(page.locator('#notification-text')).toHaveText('接口测试通过');
  expect(records.some(record => record.path.endsWith('/audio/transcriptions'))).toBe(true);
});

test('模拟双通道音频和可选画面，停止后不再发送请求', async () => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await configure();
  await desktop.evaluate(({ desktopCapturer, nativeImage }) => {
    desktopCapturer.getSources = async () => [{ id: 'screen:test:0', name: '模拟会议画面', thumbnail: nativeImage.createEmpty() }];
  });
  await page.evaluate(() => {
    window.__testStreams = [];
    const fake = async video => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator(); const gain = context.createGain(); gain.gain.value = .08;
      oscillator.connect(gain).connect(destination); oscillator.start(); await context.resume();
      const stream = destination.stream;
      if (video) {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const drawing = canvas.getContext('2d'); drawing.fillStyle = '#126b60'; drawing.fillRect(0, 0, 640, 360);
        const track = canvas.captureStream(5).getVideoTracks()[0]; stream.addTrack(track);
      }
      window.__testStreams.push(stream); return stream;
    };
    navigator.mediaDevices.getDisplayMedia = () => fake(true);
    navigator.mediaDevices.getUserMedia = () => fake(false);
  });
  await page.getByRole('button', { name: '面试工作台', exact: true }).click();
  await page.getByRole('button', { name: '开始面试', exact: true }).click();
  await page.locator('#use-video').check();
  await page.getByRole('button', { name: '模拟会议画面' }).click();
  await expect(page.locator('#session-state')).toHaveText('采集中');
  await expect(page.locator('#visual')).toContainText('测试画面');
  await expect(page.locator('.transcript-entry.system')).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('.transcript-entry.mic')).toHaveCount(1);
  await expect(page.locator('#hint-state')).toContainText('已更新');
  expect(records.filter(record => record.path.endsWith('/audio/transcriptions'))).toHaveLength(2);
  expect(records.some(record => Array.isArray(record.body?.messages.at(-1).content))).toBe(true);
  await page.getByRole('button', { name: '停止采集', exact: true }).click();
  await expect(page.locator('#session-state')).toHaveText('采集已停止');
  expect(await page.evaluate(() => window.__testStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  const count = records.length;
  await page.waitForTimeout(1000);
  expect(records).toHaveLength(count);
  await page.getByRole('button', { name: '开始面试', exact: true }).click();
  await page.locator('#use-video').uncheck();
  await page.locator('#use-mic').uncheck();
  await page.getByRole('button', { name: '模拟会议画面' }).click();
  await expect(page.locator('#session-state')).toHaveText('采集中');
  await expect.poll(() => records.filter(record => record.path.endsWith('/audio/transcriptions')).length, { timeout: 15000 }).toBe(3);
  await page.getByRole('button', { name: '停止采集', exact: true }).click();
  expect(records.slice(count).some(record => Array.isArray(record.body?.messages.at(-1).content))).toBe(false);
  await expect(page.locator('.transcript-entry.mic')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('API 错误不泄露密钥，关闭持久化会移除磁盘配置', async () => {
  await configure(); responseStatus = 401;
  await page.getByRole('button', { name: '面试工作台', exact: true }).click();
  await page.locator('#question').fill('为什么申请这个岗位？');
  await page.getByRole('button', { name: '生成提示', exact: true }).click();
  await expect(page.locator('#notification-text')).toHaveText('API 401：Key 无效');
  await expect(page.locator('#hint-state')).toHaveText('生成失败');
  await expect(page.locator('body')).not.toContainText('private-demo-key');
  await page.getByRole('button', { name: 'API 设置', exact: true }).click();
  await page.locator('#remember').uncheck();
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.locator('#notification-text')).toHaveText('已应用，仅本次运行有效');
  await expect.poll(async () => { try { await fs.access(path.join(dataDir, 'settings.enc')); return true; } catch { return false; } }).toBe(false);
});

test('本地配置清除需要明确操作，清除后 Key 和资料不再保留', async () => {
  await configure();
  await page.getByRole('button', { name: '清除本机准备内容和 API 配置', exact: true }).click();
  await page.getByRole('button', { name: '保留', exact: true }).click();
  expect((await fs.stat(path.join(dataDir, 'settings.enc'))).size).toBeGreaterThan(0);
  await page.getByRole('button', { name: '清除本机准备内容和 API 配置', exact: true }).click();
  await page.getByRole('button', { name: '确认清除', exact: true }).click();
  await expect(page.locator('#notification-text')).toHaveText('本机准备内容与 API 配置已清除');
  await expect(page.locator('#resume')).toHaveValue('');
  await expect(page.locator('#chat-key')).toHaveAttribute('placeholder', '填写 API Key（本机服务可留空）');
});

test('新问题取消旧生成，迟到的旧回答不会覆盖新提示', async () => {
  await configure(); slow = true;
  await page.getByRole('button', { name: '面试工作台', exact: true }).click();
  await page.locator('#question').fill('第一个问题');
  await page.getByRole('button', { name: '生成提示', exact: true }).click();
  await expect.poll(() => records.length).toBe(1);
  await page.locator('#question').fill('第二个问题');
  await page.getByRole('button', { name: '生成提示', exact: true }).click();
  await expect(page.locator('#points')).toContainText('新问题专用回答');
  await expect(page.locator('#hint-state')).toContainText('已更新');
  await page.waitForTimeout(1700);
  await expect(page.locator('#points')).toContainText('新问题专用回答');
});
