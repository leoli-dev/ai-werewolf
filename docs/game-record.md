# 对局记录格式（game record）

游戏中随时可以导出（「暂停」菜单 → 导出记录；终局结算面板 → 导出记录）。
文件是一份 UTF-8 JSON，名字形如 `ai-werewolf-2026-10-09-2130-day3.json`（进行中）或 `ai-werewolf-2026-10-09-2130-wolf-wins.json`（已结束）。

记录是**上帝视角**：包含所有人的身份、私密信息和夜间行动。类型定义见 [`src/game/record.ts`](../src/game/record.ts)。

## 约定

- `format` 固定为 `"ai-werewolf/game-record"`，`version` 目前为 `1`；不兼容的改动会升版本号。
- 所有玩家编号都是 **0 起的 id**（`seat = id + 1` 是游戏里显示的号码）。
- 目标选择中 `null` 表示放弃 / 弃票 / 空刀，`-1` 表示自爆。

## 顶层结构

| 字段 | 说明 |
| --- | --- |
| `format`, `version` | 格式标识与版本 |
| `exportedAt` | 导出时间（ISO 8601） |
| `status` | `"inProgress"` 或 `"ended"` |
| `game` | 板子（`board`）、人类座位 `humanSeat`、`autoPlay`、引擎 `engine`（`llm` / `offline`）、模型 `llm: {provider, model}`（不含地址和密钥）、狼队沟通轮数、用时 `elapsedMs` |
| `players[]` | `id`、`seat`、`name`、`role`、`roleName`、`team`、`isHuman`、`playstyle`（AI 打法风格）、`alive`、`death: {cause, day, phase, atEvent}`、`notes`（LLM AI 自己记下的决策理由） |
| `timeline[]` | 按发生顺序合并的**事件**与**决策**，见下 |
| `state` | 导出时的局面：天数、阶段、警长、女巫药水、猎人/狼王是否已开枪、上次守护、预言家查验、存活名单 |
| `result` | 结束后：`{winner, days, survivors}`；进行中为 `null` |
| `ceremony` | 颁奖典礼的感言、投票明细与结果（`speaker` 为 `null` 时是 GM 播报）；未开始为 `null` |
| `replay` | `setupSeed`、`gameSeed`、`options`（名字、人类座位、所选身份 `humanRole`、AI 代打、狼队沟通轮数——都会影响发牌和流程）、`journal`：`new Game({ ...options, seed: gameSeed, replay: journal })` 可逐步重建整局 |

死亡原因 `cause`：`wolf` 狼刀、`poison` 毒、`hunter` 猎人枪、`wolfKing` 狼王枪、`vote` 放逐、`explode` 自爆、`gm` 其他（GM 判定）。

## timeline

每一项带 `kind`：

### `kind: "event"` —— 发生的事、讲过的话、得到的结果

即引擎发出的 `GameEvent`：

```json
{ "kind": "event", "seq": 42, "day": 1, "phase": "discussion", "type": "speech",
  "speaker": 3, "speechKind": "discussion", "text": "……",
  "visibility": { "kind": "public" } }
```

- `type`：`gm` 播报、`speech` 白天发言、`wolfChat` 狼队频道、`vote` 票型、`death` 出局、`private` 私密信息（查验结果、女巫用药、守护…）、`system` 引擎诊断
- `visibility`：`public`，或 `{kind: "private", to: [id…]}` 表示只有这些人看得到
- `speechKind`：`discussion` / `summary`（警长归票）/ `lastWords` / `defense`（PK）/ `campaign` / `campaignPk`
- `data`：结构化结果，如 `{votes, action}`、`{check, result}`、`{nightDeaths}`、`{id, cause}`

### `kind: "decision"` —— 做的决定

GM 向某个玩家提出的每一个问题与回答，放在它引出的事件之前：

```json
{ "kind": "decision", "seq": 58, "atEvent": 62, "day": 1, "phase": "vote",
  "actor": 3, "label": "大家投票中",
  "request": { "kind": "target", "action": "vote", "candidates": [0, 1, 2], "allowSkip": true, "prompt": "…" },
  "choice": 2, "resolved": 2, "reason": "发言前后矛盾" }
```

- `request`：原样的问题。`kind` 为 `speech`（含 `purpose`、发言顺序）、`wolfChat`（第几轮）或 `target`（`action`：`vote` `revote` `seer` `guard` `wolfKill` `witchSave` `witchPoison` `hunterShot` `wolfKingShot` `runForSheriff` `withdraw` `sheriffVote` `sheriffRevote` `badge` `speakOrder`，以及候选和提示）
- 发言类：`text` 为原话，`explode: true` 表示发言后自爆
- 选择类：`choice` 是给出的答案，`resolved` 是规则处理后的结果（非法目标会被替换）；`reason` 是 LLM AI 给出的理由（有则记录）
- `fallback: true`：模型失败，由规则 AI 代为决定
- `discarded: true`：同一轮里有人自爆，这个答案已给出但没有生效
- `atEvent`：做出决定时已有的事件数，即它位于 `seq == atEvent` 的事件之前
