#!/usr/bin/env python3
"""queueing latency probe: simulate one day-round of 12 AI players speaking
sequentially (serial, as designed: GM asks one at a time), plus 4 briefer
GM-query calls. Measures per-call latency and throughput against an
OpenAI-compatible endpoint. Usage: python3 mtplx_round_bench.py [n_rounds]"""
import json, time, sys, urllib.request

BASE = "http://127.0.0.1:8001/v1/chat/completions"
MODEL = "mtplx-flash-next-optimized-speed"

ROLES = ["预言家", "女巫", "猎人", "守卫", "狼人", "狼人", "狼人", "狼人",
         "村民", "村民", "村民", "村民"]

def make_messages(i, role, transcript_len):
    # simulate accumulated shared transcript (all players' day speeches so far)
    filler = "3号发言可疑，一直在避重就轻；昨夜刀口在5号，女巫未救，可能是无解药或认5号是狼。"
    transcript = (filler * (transcript_len // 40 + 1))[:transcript_len]
    system = (f"你在玩12人狼人杀（4狼4民4神屠边局）。你的角色：{role}。"
              "白天讨论阶段，请根据当前发言记录给出你的分析与投票倾向，"
              "120字以内，不要暴露真实身份。")
    user = f"【共享发言记录（截断）】{transcript}\n\n轮到第{i+1}个玩家（你）发言。"
    return [{"role": "system", "content": system},
            {"role": "user", "content": user}]

def call(i, role, tlen, max_tokens):
    body = json.dumps({
        "model": MODEL, "messages": make_messages(i, role, tlen),
        "max_tokens": max_tokens, "temperature": 1.0,
        "reasoning_effort": "medium", "stream": False,
    }).encode()
    req = urllib.request.Request(BASE, data=body,
        headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=600) as r:
        data = json.loads(r.read())
    dt = time.time() - t0
    u = data.get("usage", {})
    return dt, u.get("prompt_tokens", 0), u.get("completion_tokens", 0)

def main():
    n_rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    print(f"# round = 12 serial speeches + 4 short GM queries; {n_rounds} round(s)")
    # warmup (excluded from stats)
    call(0, "村民", 1200, 120)
    for rnd in range(1, n_rounds + 1):
        rows, total = [], 0.0
        # long transcript for mid-game speech phase
        for i, role in enumerate(ROLES):
            dt, pt, ct = call(i, role, 1800, 120)
            rows.append((f"S{i+1:02d} {role}", dt, pt, ct)); total += dt
        # brief GM queries (night-style prompts)
        for j in range(4):
            dt, pt, ct = call(j, ROLES[j], 300, 40)
            rows.append((f"Q{j} query", dt, pt, ct)); total += dt
        for name, dt, pt, ct in rows:
            tps = ct / dt if dt else 0
            print(f"{name:14s} {dt:7.2f}s  in={pt:5d} out={ct:4d}  {tps:5.1f} tok/s")
        print(f"ROUND {rnd}: total {total:.1f}s for {len(rows)} serial calls "
              f"(mean {total/len(rows):.2f}s/call)\n")

if __name__ == "__main__":
    main()
