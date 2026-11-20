# 临场面试提示器

Windows 桌面首版。面试前填写简历、目标岗位和想法；面试时采集系统声音与可选麦克风，结合对话生成回答要点和口述稿。可以选择定时分析会议画面。

## 使用

打开 `dist/InterviewHelper-0.1.0-x64.exe`，无需安装 Node.js。首次启动自解压需要一些时间。当前便携版没有数字签名。

1. 在“面试准备”粘贴简历、岗位要求和个人想法。支持导入 TXT、Markdown；PDF、Word 请复制文字后粘贴。保存准备内容。
2. 在“API 设置”配置回答模型与语音转写。分别填写 Base URL、模型名和 API Key；两项可以来自不同服务商。
3. 如需分析画面，配置支持图片输入的模型，或沿用支持图片的回答模型。保存后可点击各自的测试按钮。测试会实际调用 API，可能产生费用。
4. 在工作台输入一个问题，先验证回答提示。也可以点击“体验本地示例”，该入口不调用 API、不修改个人资料。
5. 点击“开始面试”，选择会议窗口或屏幕。麦克风默认开启，画面分析默认关闭。按需勾选后点击画面来源开始采集。
6. 阅读回答要点，需要时展开口述稿。可以置顶、进入小窗，或手动补充问题。小窗保留开始、停止采集按钮。
7. 结束时点击“停止采集”。需要保留对话时点击“导出”；关闭程序后，未导出的对话不会恢复。

提示只供参考。模型被要求仅使用已提供的真实经历，资料缺失时标注待补充，仍需自行核实输出内容。

## API 接口要求

| 能力 | 接口 | 请求与响应 |
| --- | --- | --- |
| 回答 | `POST {Base URL}/chat/completions` | `model`、`messages`、`stream`、`max_tokens`；支持 SSE `choices[].delta.content`，也兼容 JSON `choices[].message.content` |
| 转写 | `POST {Base URL}/audio/transcriptions` | multipart：`file` 为单声道 PCM16 WAV，`model`、`response_format=json`；响应须含 `text` |
| 视觉 | `POST {Base URL}/chat/completions` | 多模态 `messages`，含 `image_url` 的 JPEG data URL，`detail=low`；模型须支持图片 |

Base URL 示例：`https://api.openai.com/v1`，不要在后面追加 `chat/completions`。远端 API 必须使用 HTTPS；本机 `localhost`、`127.0.0.1`、`[::1]` 可以使用 HTTP 和空 Key。接口地址不接受 URL 内嵌密码、查询参数或片段，不跟随重定向。

默认填写的 `gpt-4o-mini`、`whisper-1` 是示例配置，需按服务商实际支持的模型修改。程序不会把只有文本能力的接口自动转换成语音或视觉接口；不支持仅提供 Responses API、专有 WebSocket 转写协议等服务。

保存后 Key 不会回填到界面。同一 Base URL 下留空表示继续使用已有 Key；改动地址后须重填，避免将原服务的 Key 自动发送到新地址。清除按钮可移除全部本机准备内容和 API 配置。

## 采集、延迟与数据

- 系统声音使用 Windows loopback，包含电脑整体播放声音，不局限于所选会议窗口。来源标签表示采集通道，不提供说话人识别；建议使用耳机，减少麦克风收到扬声器声音。
- 约每六秒上传一个有声音的 WAV 分块，静音分块不上传。延迟为分块等待、语音服务和回答服务耗时之和。固定边界可能截断句子，可手动补充识别不完整的问题。停止时立即停止设备、取消进行中的请求并丢弃未完成分块，不再补传尾段。
- 两路转写独立串行，按采集时间排列记录。会议声音触发自动回答，麦克风转写仅补充候选人已说的内容。提示使用最近 50 段上下文；完整对话仅保留在内存中供导出。
- 请求超时为 45 秒。转写连续失败三次或积压超过三段时停止采集并通知；视觉失败会暂停截图上传，音频继续。重新开始面试可重试。
- 画面开启后立即尝试一帧，此后每 20 秒一帧，宽度不超过 960 像素。仅发送所选画面，不另开摄像头。最小化窗口可能导致画面冻结；单帧不代表完整动作变化，也无法可靠判断真实心情、人格、健康或意图。超过一分钟的观察不用于新回答。
- 简历、想法和最近转写会发送到回答 API；音频发往转写 API；开启视觉后截图发往视觉 API。请求已发出后，停止或取消无法撤回服务商已接收的数据，也不能保证免除已发生的计费。请核对服务商的数据政策和会议的辅助工具约定。
- 应用不默认保存音频或截图。选择“保存到本机”时，准备内容和 API Key 使用 Electron safeStorage 加密保存在 `%APPDATA%/interview-helper/settings.enc`。这不隔离同一 Windows 用户权限下的所有程序。取消保存会删除已保存的配置，仅保留本次运行的内存配置。
- 导出文件包含对话和最近一次提示，为普通明文 TXT。程序和系统的缓存、崩溃转储不属于安全擦除保证；清除配置不会删除用户已导出的文件或服务商数据。

## 开发与检查

需要 Windows 10/11 x64、Node.js 22.12 或更新版本。

```powershell
npm ci
npx --no-install install-electron --no
npm start
```

```powershell
npm test
npm run test:ui
npm run dist
```

`npm test` 验证 WAV、静音门限、API 路径和配置、转写上传、SSE 边界、错误处理及视觉请求。桌面测试通过 Playwright 启动真实 Electron，使用合成音画和本机模拟 API，验证界面、加密保存和重启恢复、双通道采集、画面请求、停止设备与网络取消、配置清除和旧回答隔离，不采集真实会议、不使用收费 Key。

桌面测试数据在 `.test-data/`，界面截图在 `outputs/`，均已加入忽略文件。测试不会自动验证腾讯会议、Teams、Zoom 等真实会议软件的设备兼容性，也不能代表真实模型的准确率和延迟。

应用使用隔离渲染进程、沙盒、CSP、限定 IPC 和文本渲染；Key 与网络请求在主进程处理。没有账号、业务服务器、云同步、后台自动录制或上传分析统计。

实现参考：[Electron 系统声音采集接口](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts)、[加密存储接口](https://www.electronjs.org/docs/latest/api/safe-storage)、[语音转写接口格式](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)。
