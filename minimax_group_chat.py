from __future__ import annotations

import argparse
import queue
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable

from minimax_client import MiniMaxClient

DEFAULT_ROLES = ["规划师", "编码师", "审查员", "测试员"]

ROLE_SYSTEM_PROMPTS = {
    "规划师": (
        "你是规划师。请把用户任务拆成可执行步骤，明确范围、依赖和先后顺序。"
    ),
    "编码师": (
        "你是编码师。请给出可落地的实现细节和代码级建议，优先可直接执行的方案。"
    ),
    "审查员": (
        "你是审查员。请指出正确性风险、隐含假设和潜在 bug，要求具体且严格。"
    ),
    "测试员": (
        "你是测试员。请给出验证清单、边界场景和最小测试用例，优先高信号测试。"
    ),
}


@dataclass
class AgentResult:
    role: str
    content: str
    error: str | None = None


def _extract_text(message: Any) -> str:
    text = getattr(message, "content", "")
    if isinstance(text, list):
        parts: list[str] = []
        for item in text:
            if isinstance(item, dict):
                maybe_text = item.get("text")
                if maybe_text:
                    parts.append(maybe_text)
        return "\n".join(parts)
    if isinstance(text, str):
        return text
    return str(text)


def _strip_think_blocks(text: str) -> str:
    return re.sub(r"<think>[\s\S]*?</think>\s*", "", text, flags=re.IGNORECASE).strip()


def _now_ts() -> str:
    return datetime.now().strftime("%H:%M:%S")


def _build_worker_messages(role: str, task: str, context: str) -> list[dict[str, str]]:
    system = ROLE_SYSTEM_PROMPTS.get(
        role,
        "你是专业助手。请提供具体、简洁、可执行的技术建议。",
    )
    user_text = (
        f"任务：\n{task}\n\n"
        f"最近上下文：\n{context or '（无）'}\n\n"
        "输出规则：\n"
        "1) 使用中文回答；\n"
        "2) 内容简洁且可执行；\n"
        "3) 不要空话。\n"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user_text},
    ]


def _build_synth_messages(task: str, context: str, results: list[AgentResult]) -> list[dict[str, str]]:
    packed = []
    for r in results:
        if r.error:
            packed.append(f"[{r.role}] ERROR: {r.error}")
        else:
            packed.append(f"[{r.role}]\n{r.content}")
    worker_dump = "\n\n".join(packed)

    system = "你是总审阅。请将多智能体结果整合为可靠的最终答案，优先正确性。"
    user_text = (
        f"任务：\n{task}\n\n"
        f"最近上下文：\n{context or '（无）'}\n\n"
        f"各角色输出：\n{worker_dump}\n\n"
        "请产出：\n"
        "- 最终答案\n"
        "- 关键假设\n"
        "- 验证清单\n"
        "请使用中文回答。"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user_text},
    ]


def run_parallel_agents(
    task: str,
    context: str,
    roles: list[str],
    model: str | None,
    temperature: float,
    max_tokens: int | None,
    on_result: Callable[[AgentResult], None] | None = None,
) -> list[AgentResult]:
    def worker(role: str) -> AgentResult:
        client = MiniMaxClient(model=model) if model else MiniMaxClient()
        response = client.chat(
            messages=_build_worker_messages(role, task, context),
            temperature=temperature,
            max_tokens=max_tokens,
        )
        text = _strip_think_blocks(_extract_text(response.choices[0].message))
        return AgentResult(role=role, content=text)

    indexed_roles = {role: idx for idx, role in enumerate(roles)}
    collected: list[AgentResult] = []
    with ThreadPoolExecutor(max_workers=max(1, len(roles))) as pool:
        future_map = {pool.submit(worker, role): role for role in roles}
        for fut in as_completed(future_map):
            role = future_map[fut]
            try:
                result = fut.result()
            except Exception as exc:  # noqa: BLE001
                result = AgentResult(role=role, content="", error=str(exc))
            collected.append(result)
            if on_result:
                on_result(result)
    collected.sort(key=lambda r: indexed_roles.get(r.role, 10_000))
    return collected


def run_lead_review(
    task: str,
    context: str,
    results: list[AgentResult],
    model: str | None,
    max_tokens: int | None,
) -> str:
    client = MiniMaxClient(model=model) if model else MiniMaxClient()
    response = client.chat(
        messages=_build_synth_messages(task, context, results),
        temperature=0.2,
        max_tokens=max_tokens,
    )
    return _strip_think_blocks(_extract_text(response.choices[0].message))


def run_cli(
    task: str,
    roles: list[str],
    context: str,
    model: str | None,
    temperature: float,
    max_tokens: int | None,
) -> int:
    print(f"[{_now_ts()}] 启动 {len(roles)} 个并行 MiniMax 角色：{', '.join(roles)}")
    results = run_parallel_agents(
        task=task,
        context=context,
        roles=roles,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        on_result=lambda r: print(
            f"[{_now_ts()}] {r.role}: {'错误 ' + r.error if r.error else '完成'}"
        ),
    )
    print("\n=== 各角色输出 ===")
    for r in results:
        if r.error:
            print(f"\n[{r.role}] 错误：{r.error}")
        else:
            print(f"\n[{r.role}]\n{r.content}")

    print("\n=== 总审阅 ===")
    final_text = run_lead_review(
        task=task,
        context=context,
        results=results,
        model=model,
        max_tokens=max_tokens,
    )
    print(final_text)
    return 0


class GroupChatUI:
    def __init__(self, root: Any, roles: list[str], model: str | None) -> None:
        import tkinter as tk
        from tkinter import scrolledtext

        self.tk = tk
        self.root = root
        self.roles = roles
        self.model = model
        self.msg_queue: queue.Queue[tuple[str, str]] = queue.Queue()
        self.history: list[tuple[str, str]] = []

        root.title("MiniMax 多智能体群聊")
        root.geometry("1000x700")

        top = tk.Frame(root)
        top.pack(fill=tk.X, padx=8, pady=6)

        tk.Label(top, text="角色（逗号分隔）：").pack(side=tk.LEFT)
        self.roles_var = tk.StringVar(value=", ".join(roles))
        self.roles_entry = tk.Entry(top, textvariable=self.roles_var, width=60)
        self.roles_entry.pack(side=tk.LEFT, padx=6)

        tk.Label(top, text="模型（可选）：").pack(side=tk.LEFT)
        self.model_var = tk.StringVar(value=model or "")
        self.model_entry = tk.Entry(top, textvariable=self.model_var, width=24)
        self.model_entry.pack(side=tk.LEFT, padx=6)

        self.chat = scrolledtext.ScrolledText(root, wrap=tk.WORD)
        self.chat.pack(fill=tk.BOTH, expand=True, padx=8, pady=6)
        self.chat.configure(state=tk.DISABLED)

        bottom = tk.Frame(root)
        bottom.pack(fill=tk.X, padx=8, pady=6)

        self.input_var = tk.StringVar()
        self.input_entry = tk.Entry(bottom, textvariable=self.input_var, width=120)
        self.input_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 6))
        self.input_entry.bind("<Return>", self._on_send_event)

        self.send_btn = tk.Button(bottom, text="发送", command=self._on_send)
        self.send_btn.pack(side=tk.LEFT)

        self._append("系统", "已就绪。输入任务后点击发送。")
        self.root.after(100, self._drain_queue)

    def _append(self, speaker: str, text: str) -> None:
        ts = _now_ts()
        self.chat.configure(state=self.tk.NORMAL)
        self.chat.insert(self.tk.END, f"[{ts}] {speaker}:\n{text}\n\n")
        self.chat.see(self.tk.END)
        self.chat.configure(state=self.tk.DISABLED)

    def _drain_queue(self) -> None:
        try:
            while True:
                speaker, text = self.msg_queue.get_nowait()
                if speaker == "__CONTROL__":
                    if text == "ENABLE_SEND":
                        self.send_btn.configure(state=self.tk.NORMAL)
                    continue
                self._append(speaker, text)
        except queue.Empty:
            pass
        self.root.after(120, self._drain_queue)

    def _emit(self, speaker: str, text: str) -> None:
        self.msg_queue.put((speaker, text))

    def _on_send_event(self, _event: Any) -> None:
        self._on_send()

    def _parse_roles(self) -> list[str]:
        raw = self.roles_var.get().strip()
        if not raw:
            return DEFAULT_ROLES
        roles = [r.strip() for r in raw.split(",") if r.strip()]
        return roles or DEFAULT_ROLES

    def _on_send(self) -> None:
        task = self.input_var.get().strip()
        if not task:
            return
        self.input_var.set("")
        self.send_btn.configure(state=self.tk.DISABLED)
        self._append("User", task)

        context = self._history_text(limit=6)
        roles = self._parse_roles()
        model = self.model_var.get().strip() or None

        thread = threading.Thread(
            target=self._run_pipeline,
            args=(task, context, roles, model),
            daemon=True,
        )
        thread.start()

    def _history_text(self, limit: int = 6) -> str:
        if not self.history:
            return ""
        items = self.history[-limit:]
        return "\n".join([f"{speaker}: {text}" for speaker, text in items])

    def _run_pipeline(
        self, task: str, context: str, roles: list[str], model: str | None
    ) -> None:
        self._emit("协调器", f"正在启动 {len(roles)} 个并行角色：{', '.join(roles)}")

        def on_result(r: AgentResult) -> None:
            if r.error:
                self._emit(r.role, f"ERROR: {r.error}")
            else:
                self._emit(r.role, r.content)

        try:
            results = run_parallel_agents(
                task=task,
                context=context,
                roles=roles,
                model=model,
                temperature=0.3,
                max_tokens=None,
                on_result=on_result,
            )
            self._emit("协调器", "总审阅正在汇总并校验全部输出...")
            final_text = run_lead_review(
                task=task,
                context=context,
                results=results,
                model=model,
                max_tokens=None,
            )
            self._emit("总审阅", final_text)
            self.history.append(("user", task))
            self.history.append(("assistant", final_text))
        except Exception as exc:  # noqa: BLE001
            self._emit("系统", f"执行失败：{exc}")
        finally:
            self.msg_queue.put(("系统", "已完成。"))
            self.msg_queue.put(("__CONTROL__", "ENABLE_SEND"))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="MiniMax 多智能体群聊（并行角色 + 总审阅）。"
    )
    parser.add_argument(
        "--roles",
        default=",".join(DEFAULT_ROLES),
        help="逗号分隔角色名。默认：规划师,编码师,审查员,测试员",
    )
    parser.add_argument("--model", default=None, help="覆盖 MiniMax 模型。")
    parser.add_argument("--cli", default=None, help="CLI 模式单次执行任务。")
    parser.add_argument("--context", default="", help="CLI 模式可选上下文。")
    parser.add_argument("--temperature", type=float, default=0.3)
    parser.add_argument("--max-tokens", type=int, default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    roles = [r.strip() for r in args.roles.split(",") if r.strip()] or DEFAULT_ROLES

    if args.cli:
        return run_cli(
            task=args.cli,
            roles=roles,
            context=args.context,
            model=args.model,
            temperature=args.temperature,
            max_tokens=args.max_tokens,
        )

    try:
        import tkinter as tk
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(
            f"未检测到 Tkinter（{exc}）。请改用 CLI：--cli \"你的任务\""
        )

    root = tk.Tk()
    ui = GroupChatUI(root, roles=roles, model=args.model)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
