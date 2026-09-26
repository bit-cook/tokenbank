# Token Bank 宣传视频

`tokenbank-promo.mp4`：67 秒 · 1920×1080 · 30fps · H.264 + AAC，配乐为代码合成（无版权素材）。

## 分镜

| 时间 | 段落 | 画面 | 声音 |
|---|---|---|---|
| 0–5s | 痛点开场 | 「订阅越来越多 / 账单越来越长 / 额度月底清零 / **Token 都去哪了？**」快切，背景滚动调用日志，账单数字飙升，最后收缩成一个金点 | 低频 drone + 时钟滴答，每句重击，升调 riser |
| 5–9.5s | Logo 揭幕 | 金币 Logo 3D 翻转入场，P2P 网格连线逐条绘出，高光扫过；「Token Bank · 你的个人 AI 中枢」 | 爆点 impact + 钟琴琶音 |
| 9.5–16s | 01 一键纳管 | Claude Code / Codex / Cursor / WorkBuddy / Kimi Code / OpenClaw 依次开关点亮，光流汇入本地网关 `localhost:11430/v1` | 120 BPM 节拍进入，开关音阶上行 |
| 16–22.5s | 02 用的明白 | 用量仪表盘：Token 计数、按小时柱状图、实时 Trace 流 | 轻微数据滴答 |
| 22.5–30s | 03 用的节省 | 三个请求经智能路由分发到本地模型 / 免费额度 / 社区算力，模型名不变、协议自动转换、花费 ¥0 | 路由“嗖”声 + 命中铃音 |
| 30–36s | 04 越用越懂你 | 工作画像雷达图生长，MCP / Skill / Prompt / Agent 个性化推荐一键添加 | 添加提示音 |
| 36–42.5s | 05 资源投射 | Skill / MCP / Prompt / Agent 经「投射门控」投射到已纳管且已安装的 Claude Code / Codex / Cursor / Kimi Code，未安装的 Trae 被跳过 | 汇聚 whoosh + 门控铃音 + 逐个命中 |
| 42.5–49s | 06 游乐场 · 智能体编排 | 一句话任务（含截图）交给主 Agent，经 `tb_dispatch_agent` 并行派发给 Codex、Kimi Code 与远端执行的社区智能体，结果回流合并 | 打字声 + 派发 zap + 完成铃音 |
| 49–55s | 07 闲置赚钱 | P2P 网络由“你”向外点亮，积分实时增长 | 金币音 + riser |
| 55–60s | 五条主线 | 用的明白 · 用的节省 · 用的简单 · 越用越懂你 · 闲置赚钱（中英双语，每秒一击） | 每词一次重击 |
| 60–67s | 结尾 | Logo + Slogan + 平台 + `github.com/wink-run/tokenbank` | 终章 impact，淡出 |

画面中的用量、积分等数字均为演示用示意数据。

## 重新生成

整条片子是一个确定性的 HTML 时间轴（`video.html` 中的 `renderFrame(t)`），逐帧截图后用 ffmpeg 编码。

```bash
cd promo
npm install                      # 字体：Inter / Noto Sans SC / JetBrains Mono
pip install numpy scipy          # 配乐合成
python3 soundtrack.py            # -> out/soundtrack.wav
node render.mjs --stills         # 可选：导出关键帧预览 -> out/stills/
FFMPEG=/path/to/ffmpeg node render.mjs   # -> out/tokenbank-promo.mp4（需 libx264）
```

- 浏览器实时预览：用本地静态服务器打开 `video.html?play`。
- 需要 Playwright（Chromium）；ffmpeg 需带 libx264，可用 `pip install imageio-ffmpeg` 获取。
- 修改文案 / 时长：编辑 `video.html` 中对应场景的 DOM 与 `renderFrame` 分段；配乐的 cue 点在 `soundtrack.py` 中与之对齐。
