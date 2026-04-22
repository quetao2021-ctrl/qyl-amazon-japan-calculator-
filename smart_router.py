from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from typing import Any

from gpt_client import GPTClient
from minimax_client import MiniMaxClient

LOW_RISK_HINTS = {
    "rewrite",
    "rephrase",
    "translate",
    "grammar",
    "format",
    "summarize logs",
    "naming",
    "generate comments",
    "doc polish",
    "non critical",
}

HIGH_RISK_HINTS = {
    "architecture",
    "design",
    "refactor",
    "root cause",
    "debug",
    "security",
    "privacy",
    "migration",
    "database",
    "data loss",
    "production",
    "deploy",
    "test strategy",
    "algorithm",
    "correctness",
}


@dataclass
class RouteDecision:
    provider: str
    reason: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Route to GPT or MiniMax. GPT is the default for safety."
    )
    parser.add_argument("prompt", help="User prompt text.")
    parser.add_argument("--system", default="You are a helpful coding assistant.")
    parser.add_argument("--provider", choices=["auto", "gpt", "minimax"], default="auto")
    parser.add_argument(
        "--task-type",
        choices=["auto", "critical", "peripheral"],
        default="auto",
        help="critical => GPT, peripheral => MiniMax",
    )
    parser.add_argument("--gpt-model", default=None)
    parser.add_argument("--minimax-model", default=None)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--max-tokens", type=int, default=None)
    parser.add_argument("--json", action="store_true", help="Print full response JSON.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only print route decision. Do not call any provider.",
    )
    parser.add_argument(
        "--explain-route",
        action="store_true",
        help="Print route decision before response.",
    )
    return parser.parse_args()


def decide_route(prompt: str, provider: str, task_type: str) -> RouteDecision:
    if provider in {"gpt", "minimax"}:
        return RouteDecision(provider=provider, reason="forced by --provider")

    if task_type == "critical":
        return RouteDecision(provider="gpt", reason="task_type=critical")
    if task_type == "peripheral":
        return RouteDecision(provider="minimax", reason="task_type=peripheral")

    text = prompt.lower()
    if any(hint in text for hint in HIGH_RISK_HINTS):
        return RouteDecision(provider="gpt", reason="matched high-risk keywords")
    if any(hint in text for hint in LOW_RISK_HINTS):
        return RouteDecision(provider="minimax", reason="matched low-risk keywords")

    return RouteDecision(provider="gpt", reason="safe default")


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


class RouterClient:
    def __init__(self) -> None:
        self._gpt: GPTClient | None = None
        self._minimax: MiniMaxClient | None = None

    def call(
        self,
        decision: RouteDecision,
        messages: list[dict[str, Any]],
        gpt_model: str | None,
        minimax_model: str | None,
        temperature: float,
        max_tokens: int | None,
    ) -> Any:
        if decision.provider == "gpt":
            if self._gpt is None:
                self._gpt = GPTClient()
            return self._gpt.chat(
                messages=messages,
                model=gpt_model,
                temperature=temperature,
                max_tokens=max_tokens,
            )

        if self._minimax is None:
            self._minimax = MiniMaxClient()
        return self._minimax.chat(
            messages=messages,
            model=minimax_model,
            temperature=temperature,
            max_tokens=max_tokens,
        )


def main() -> int:
    args = parse_args()
    decision = decide_route(args.prompt, args.provider, args.task_type)

    if args.dry_run:
        print(f"[route] provider={decision.provider} reason={decision.reason}")
        return 0

    messages = [
        {"role": "system", "content": args.system},
        {"role": "user", "content": args.prompt},
    ]

    client = RouterClient()
    response = client.call(
        decision=decision,
        messages=messages,
        gpt_model=args.gpt_model,
        minimax_model=args.minimax_model,
        temperature=args.temperature,
        max_tokens=args.max_tokens,
    )

    if args.json:
        print(
            json.dumps(
                {
                    "provider": decision.provider,
                    "reason": decision.reason,
                    "response": response.model_dump(),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    if args.explain_route:
        print(f"[route] provider={decision.provider} reason={decision.reason}")

    message = response.choices[0].message
    text = _extract_text(message)
    if decision.provider == "minimax":
        text = _strip_think_blocks(text)
    print(text or "")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Request failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
