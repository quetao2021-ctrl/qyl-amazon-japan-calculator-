from __future__ import annotations

import os
import time
from typing import Any, Callable

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    InternalServerError,
    OpenAI,
    RateLimitError,
)

DEFAULT_BASE_URL = os.getenv("GPT_BASE_URL", "https://api.openai.com/v1")
DEFAULT_MODEL = os.getenv("GPT_MODEL", "gpt-5.4-mini")
DEFAULT_TIMEOUT_SECONDS = float(os.getenv("GPT_TIMEOUT_SECONDS", "60"))


class GPTClient:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        model: str = DEFAULT_MODEL,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = 3,
        retry_backoff_seconds: float = 1.5,
    ) -> None:
        key = api_key or os.getenv("GPT_API_KEY") or os.getenv("OPENAI_API_KEY")
        if not key:
            raise ValueError(
                "Missing GPT API key. Set GPT_API_KEY or OPENAI_API_KEY."
            )
        if max_retries < 0:
            raise ValueError("max_retries must be >= 0")
        if retry_backoff_seconds <= 0:
            raise ValueError("retry_backoff_seconds must be > 0")

        self._client = OpenAI(api_key=key, base_url=base_url, timeout=timeout_seconds)
        self._model = model
        self._max_retries = max_retries
        self._retry_backoff_seconds = retry_backoff_seconds

    def chat(
        self,
        messages: list[dict[str, Any]],
        model: str | None = None,
        temperature: float = 0.2,
        max_tokens: int | None = None,
    ) -> Any:
        request: dict[str, Any] = {
            "model": model or self._model,
            "messages": messages,
            "temperature": temperature,
        }
        if max_tokens is not None:
            request["max_tokens"] = max_tokens

        return self._with_retries(
            lambda: self._client.chat.completions.create(**request)
        )

    def _with_retries(self, call: Callable[[], Any]) -> Any:
        attempt = 0
        while True:
            try:
                return call()
            except (
                APITimeoutError,
                APIConnectionError,
                RateLimitError,
                InternalServerError,
            ):
                if attempt >= self._max_retries:
                    raise
                sleep_seconds = self._retry_backoff_seconds * (2**attempt)
                time.sleep(sleep_seconds)
                attempt += 1
            except APIStatusError as err:
                status = getattr(err, "status_code", None)
                retriable = status in {408, 409, 429} or (
                    status is not None and status >= 500
                )
                if not retriable or attempt >= self._max_retries:
                    raise
                sleep_seconds = self._retry_backoff_seconds * (2**attempt)
                time.sleep(sleep_seconds)
                attempt += 1
