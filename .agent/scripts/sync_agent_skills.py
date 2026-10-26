#!/usr/bin/env python3
"""產生或驗證各 agent 的薄 skill 入口（AgentPacks agent-env）。

canonical：.agent/capabilities/skills/<name>/SKILL.md（唯一可修改來源）
入口：依 .agent/agent-env.json 的 agents 產生
  claude   → .claude/skills/<name>/SKILL.md
  codex    → .agents/skills/<name>/SKILL.md
  opencode → .opencode/skills/<name>/SKILL.md（只在沒勾 claude / codex 時；opencode 相容讀前兩者）

只動「自動產生」的入口：同名但不是入口的 skill 目錄（專案自有）不覆蓋、不刪除，只回報。
入口格式必須與 launcher installer.js 的 entryText() 逐字一致。

用法：
  python .agent/scripts/sync_agent_skills.py           # 同步
  python .agent/scripts/sync_agent_skills.py --check   # 只檢查，有漂移時 exit 1
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / ".agent" / "capabilities" / "skills"
AGENT_ENV = ROOT / ".agent" / "agent-env.json"
AGENT_DIRS = {"claude": ".claude/skills", "codex": ".agents/skills", "opencode": ".opencode/skills"}
MARKER = "# 共用 Skill 入口（自動產生）"


def read_agents() -> list[str]:
    """讀 agent-env.json 的 agents；檔案不存在或格式錯誤回傳空清單。"""
    try:
        data = json.loads(AGENT_ENV.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"讀取 {AGENT_ENV.relative_to(ROOT).as_posix()} 失敗：{error}", file=sys.stderr)
        return []
    agents = data.get("agents") if isinstance(data, dict) else None
    return [a for a in agents or [] if a in AGENT_DIRS]


def entry_dirs(agents: list[str]) -> list[str]:
    """agents → 要產生入口的目錄（規則同 installer.js entryDirs）。"""
    dirs = [AGENT_DIRS[a] for a in ("claude", "codex") if a in agents]
    if "opencode" in agents and not dirs:
        dirs.append(AGENT_DIRS["opencode"])
    return dirs


def entry_text(source: Path) -> str:
    """保留 canonical metadata，入口本身只負責導向 canonical。"""
    text = (source / "SKILL.md").read_text(encoding="utf-8").replace("\r\n", "\n")
    if not text.startswith("---\n"):
        raise ValueError(f"{source} 的 SKILL.md 缺少 YAML frontmatter")
    end = text.find("\n---\n", 4)
    if end < 0:
        raise ValueError(f"{source} 的 SKILL.md frontmatter 未結束")
    relative = source.relative_to(ROOT).as_posix()
    return (
        text[: end + 5]
        + f"\n{MARKER}\n\n"
        + f"完整閱讀並依 `{relative}/SKILL.md` 執行。"
        + "該 canonical 檔及其 scripts / references 是唯一可修改來源；本入口不得手改。\n"
    )


def is_generated(target: Path) -> bool:
    """目錄是否為自動產生的入口（只有 SKILL.md 且含入口標記）。"""
    skill = target / "SKILL.md"
    files = [p for p in target.rglob("*") if p.is_file()]
    return files == [skill] and MARKER in skill.read_text(encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="只檢查入口是否與 canonical 一致")
    args = parser.parse_args()

    agents = read_agents()
    active = entry_dirs(agents)
    sources = sorted(p for p in SOURCE.iterdir() if (p / "SKILL.md").is_file()) if SOURCE.is_dir() else []
    names = {p.name for p in sources}
    drift: list[str] = []
    skipped: list[str] = []

    # 1) 啟用中的目錄：建立 / 更新入口
    for rel_dir in active:
        for source in sources:
            target = ROOT / rel_dir / source.name
            label = f"{rel_dir}/{source.name}"
            if target.exists() and not is_generated(target):
                skipped.append(label)
                continue
            try:
                expected = entry_text(source)
            except ValueError as error:
                print(error, file=sys.stderr)
                return 2
            skill = target / "SKILL.md"
            if skill.is_file() and skill.read_text(encoding="utf-8") == expected:
                continue
            drift.append(f"更新 {label}")
            if not args.check:
                if target.exists():
                    shutil.rmtree(target)
                target.mkdir(parents=True)
                skill.write_text(expected, encoding="utf-8", newline="\n")

    # 2) 所有已知目錄：移除停用 agent 的入口、canonical 已不存在的入口
    for rel_dir in AGENT_DIRS.values():
        base = ROOT / rel_dir
        if not base.is_dir():
            continue
        for target in sorted(p for p in base.iterdir() if p.is_dir()):
            if (rel_dir in active and target.name in names) or not is_generated(target):
                continue
            drift.append(f"移除 {rel_dir}/{target.name}")
            if not args.check:
                shutil.rmtree(target)

    for label in skipped:
        print(f"略過 {label}：已存在且不是自動產生的入口（專案自有 skill）", file=sys.stderr)
    if not agents:
        print("agent-env.json 沒有啟用任何 agent", file=sys.stderr)
    if args.check:
        if drift:
            print("skill 入口與 canonical 不一致：\n  " + "\n  ".join(drift), file=sys.stderr)
            return 1
        print(f"skill 入口一致（{len(sources)} 個 skill → {', '.join(active) or '無'}）。")
        return 0
    print("\n".join(drift) if drift else "skill 入口已是最新。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
