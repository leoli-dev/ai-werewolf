# 雾镇狼人夜 · AI Werewolf

![雾镇狼人夜：第一夜，狼人在雨中的广场密谋](docs/hero.jpg)

网页版单人狼人杀：你和 11 个由大模型扮演的镇民同桌，打一局 12 人狼人杀（4 狼 / 4 民 / 预言家·女巫·猎人·守卫）：狼人数多于好人即狼胜，狼人全部出局即好人胜。
2.5D 像素风（2D 角色 billboard + 3D 场景），中世纪破败小镇，白天乌云、夜晚雷雨，HD-2D 式移轴景深与泛光。

**在线试玩：<https://leoli-dev.github.io/ai-werewolf/>**

## 特点

- **每个 AI 都是独立的玩家**：共享一本公开发言记录，另有各自的私密信息（查验结果、女巫用药、狼队频道），轮流发言、投票、夜间行动。
- **纯代码裁判**：夜晚顺序、发言 / 投票 / 平票 / 遗言、胜负判定都由规则引擎执行，模型只负责说话和做决定。
- **任意 OpenAI 兼容模型**：内置 OpenAI、DeepSeek 预设，也可以连本地推理服务（MTPLX、Ollama、LM Studio、vLLM……）。
- **离线规则 AI**：不接模型也能完整走一局，方便体验流程。
- **存档**：随时暂停，下次从标题页继续。

<img src="docs/title.jpg" alt="标题页" width="720" />

## 在线版怎么玩

1. 打开 <https://leoli-dev.github.io/ai-werewolf/>，进入「配置 → AI 引擎」。
2. 选服务商并填入自己的 API Key。Key 用你设的口令加密后只存在本机浏览器里，请求由浏览器直接发往该服务商的官方地址，不会经过任何第三方服务器。
3. 回到标题页，「新游戏」。

想先看看流程，可以把引擎切到「离线规则 AI」，不需要任何 Key。

> 在线版是纯静态网页，没有开发服务器代理。要连**本地模型**，本地服务需要允许跨域（例如 Ollama 设 `OLLAMA_ORIGINS=*`，LM Studio 打开 CORS），或者按下面的方法在本地运行。

## 本地运行

需要 Node.js 20.19+ 或 22.12+。

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 引擎规则 + prompt 解析测试
npm run typecheck
npm run build      # 静态产物输出到 dist/
```

本地开发时浏览器经 Vite 开发服务器转发请求（`/__llm`），本地推理服务不支持跨域也能用。

### 本地 LLM 配置（`.env`）

「本地 LLM」这一项的默认值放在项目根目录的 `.env`，游戏、开发服务器代理、`tools/llm_selfplay.ts`、`tools/mtplx_round_bench.py` 都从这里读取。
`.env` 不进 git；首次 `npm run dev` 时若没有 `.env` 会自动从 `.env.example` 复制一份。OpenAI / DeepSeek 的 Key 在游戏里设置，不放这里。

| 变量 | 说明 |
|---|---|
| `LLM_BASE_URL` | OpenAI 兼容地址，默认本地 MTPLX `http://127.0.0.1:8001/v1` |
| `LLM_MODEL` | 模型 id（`GET /v1/models` 列出的名字） |
| `LLM_API_KEY` | 可选；只留在开发服务器，由代理加到请求头，不会打包进浏览器代码 |
| `LLM_REASONING` / `LLM_DECISION_REASONING` | 发言 / 投票·夜间技能·狼队沟通的推理强度：none·low·medium·high |
| `LLM_USE_PROXY` | 浏览器经 Vite 开发服务器转发（本地服务拒绝跨域时需要；静态构建里无效） |
| `LLM_TIMEOUT_MS` | 单次请求超时 |

改完 `.env` 后 Vite 会自动重启，刷新页面生效。

## 部署到 GitHub Pages

仓库自带 `.github/workflows/pages.yml`：推送到 `main` 后自动跑测试、构建并发布。
首次使用需在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
构建使用相对路径（`base: './'`），fork 后仓库改名也能直接部署。

## 结构

```
src/game/     纯代码 GM 引擎（夜晚顺序、白天发言/投票/平票/遗言、胜负、可见性）
src/ai/       OpenAI 兼容 provider + 串行队列、服务商/模型目录、prompt（共享发言记录本 + 角色私本）、LLM/规则 agent
src/render/   Three.js 场景：程序生成像素贴图、环形小镇、教堂墓地、动物、天气、后期
src/audio/    Web Audio 程序生成的配乐、环境声与音效（无音频文件）
src/ui/       标题页、配置、设置页、HUD（身份牌 + 玩家列表）、发言记录、行动面板、暂停、规则说明
tools/        LLM 自对局脚本、MTPLX 延迟测速脚本
```

## 规则口径

- 狼队投票：得票过半即击杀；未过半时在被投的目标中随机选一个。狼人可以刀队友，不能空刀。
- 守卫可以空守；女巫金水一次救一人，仅在有人死亡时询问；银水目标不含自己与当晚已死者。
- 猎人夜间轮次若未被刀可主动开枪；出局（夜死 / 放逐）时若未开过枪会被询问一次。
- 白天投票可以弃票；全员弃票则当天无人出局。
- AI 输出无法解析或调用失败时重试一次，然后回退到规则 AI，并在界面提示。

## License

[MIT](LICENSE) © 2026 Leo Li
