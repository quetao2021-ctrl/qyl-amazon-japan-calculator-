from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any

from minimax_client import MiniMaxClient


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Call MiniMax via OpenAI-compatible API."
    )
    parser.add_argument("prompt", help="User prompt text.")
    parser.add_argument("--system", default="You are a helpful coding assistant.")
    parser.add_argument("--model", default=None)
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--max-tokens", type=int, default=None)
    parser.add_argument(
        "--reasoning-split",
        action="store_true",
        help="Enable MiniMax reasoning split in extra_body.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print full raw response JSON.",
    )
    return parser.parse_args()


def _dump_reasoning_details(message: Any) -> None:
    details = getattr(message, "reasoning_details", None)
    if not details:
        return

    print("=== reasoning_details ===")
    for idx, item in enumerate(details, start=1):
        item_type = getattr(item, "type", None) or item.get("type") if isinstance(item, dict) else None
        item_text = getattr(item, "text", None) or item.get("text") if isinstance(item, dict) else None
        label = item_type or f"detail_{idx}"
        if item_text:
            print(f"[{label}] {item_text}")
    print("=========================")


def _strip_think_blocks(text: str) -> str:
    # Some MiniMax models may include internal reasoning inside <think> blocks.
    return re.sub(r"<think>[\s\S]*?</think>\s*", "", text, flags=re.IGNORECASE).strip()


def main() -> int:
    args = parse_args()

    client = MiniMaxClient()
    messages = [
        {"role": "system", "content": args.system},
        {"role": "user", "content": args.prompt},
    ]

    response = client.chat(
        messages=messages,
        model=args.model,
        temperature=args.temperature,
        max_tokens=args.max_tokens,
        reasoning_split=args.reasoning_split,
    )

    if args.json:
        print(json.dumps(response.model_dump(), ensure_ascii=False, indent=2))
        return 0

    choice = response.choices[0]
    message = choice.message

    _dump_reasoning_details(message)

    text = message.content
    if isinstance(text, list):
        parts = []
        for item in text:
            if isinstance(item, dict):
                maybe_text = item.get("text")
                if maybe_text:
                    parts.append(maybe_text)
        text = "\n".join(parts)
    print(_strip_think_blocks(text or ""))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Request failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
