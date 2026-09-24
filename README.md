# 雾镇狼人夜 · AI Werewolf

网页版单人狼人杀：真人玩家 vs 11 个 AI 操控的镇民，12 人标准屠边局（4 狼 / 4 民 / 预言家·女巫·猎人·守卫）。
2.5D 像素风（2D 角色 billboard + 3D 场景），中世纪破败小镇，白天乌云、夜晚雷雨，HD-2D 式移轴景深与泛光。

## 运行

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 引擎规则 + prompt 解析测试
npm run typecheck
```

启动后先在设置页配置 AI 引擎并点「测试连接」：

| 字段 | 默认 |
|---|---|
| Base URL | `http://127.0.0.1:8001/v1`（本地 MTPLX） |
| 模型 | `mtplx-flash-next-optimized-speed` |
| 推理强度 | `medium`（作为 `reasoning_effort` 传递） |
| 跨域代理 | 开：浏览器请求 `/__llm/*`，由 Vite 开发服务器转发到 Base URL（MTPLX 拒绝浏览器跨域） |

「离线规则 AI」模式无需模型，用于调试 UI / 流程。

## 结构

```
src/game/     纯代码 GM 引擎（夜晚顺序、白天发言/投票/平票/遗言、胜负、可见性）
src/ai/       OpenAI 兼容 provider + 串行队列、prompt（共享发言记录本 + 角色私本）、LLM/规则 agent
src/render/   Three.js 场景：程序生成像素贴图、环形小镇、教堂墓地、动物、天气、后期
src/ui/       设置页、HUD（身份牌 + 玩家列表）、发言记录、行动面板、规则说明
tools/        MTPLX 延迟测速脚本
```

规则口径以 devlog 中的 game design brief 为准（`~/Code/project-devlog/projects/ai-werewolf/`）。

## 实现说明（规则口径）

- 狼队投票：得票过半即击杀；未过半时在被投的目标中随机选一个。狼人可以刀队友，不能空刀。
- 守卫可以空守；女巫金水一次救一人，仅在有人死亡时询问；银水目标不含自己与当晚已死者。
- 猎人夜间轮次若未被刀可主动开枪；出局（夜死 / 放逐）时若未开过枪会被询问一次。
- 白天投票可以弃票；全员弃票则当天无人出局。
- AI 输出无法解析或调用失败时重试一次，然后回退到规则 AI，并在界面提示。
