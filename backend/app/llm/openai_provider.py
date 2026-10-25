"""OpenAI 兼容接口：OpenAI、DeepSeek、通义千问、Kimi、智谱、Ollama 等都能用。"""
from typing import Iterator

import openai

from .base import LLMError, ProviderConfig


class OpenAICompatibleLLM:
    def __init__(self, cfg: ProviderConfig):
        self.cfg = cfg
        self.client = openai.OpenAI(
            # Ollama 等本地服务不校验 key，但 SDK 要求非空
            api_key=cfg.api_key or "not-needed",
            base_url=cfg.base_url or None,
        )

    def stream(self, system: str, messages: list[dict]) -> Iterator[str]:
        kwargs = {}
        if self.cfg.extra.get("temperature") is not None:
            kwargs["temperature"] = float(self.cfg.extra["temperature"])
        if self.cfg.extra.get("top_p") is not None:
            kwargs["top_p"] = float(self.cfg.extra["top_p"])
        if self.cfg.extra.get("max_tokens"):
            kwargs["max_tokens"] = int(self.cfg.extra["max_tokens"])
        try:
            resp = self.client.chat.completions.create(
                model=self.cfg.model,
                messages=[{"role": "system", "content": system}, *messages],
                stream=True,
                **kwargs,
            )
            for chunk in resp:
                if chunk.choices and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content
        except openai.AuthenticationError as e:
            raise LLMError("API Key 无效或未设置") from e
        except openai.NotFoundError as e:
            raise LLMError(f"模型或接口地址不存在：{self.cfg.model} @ {self.cfg.base_url or 'api.openai.com'}") from e
        except openai.RateLimitError as e:
            raise LLMError("请求太频繁或额度不足，请稍后再试") from e
        except openai.APIStatusError as e:
            raise LLMError(f"模型接口返回错误 {e.status_code}：{e.message}") from e
        except openai.APIConnectionError as e:
            raise LLMError("连接模型接口失败，请检查网络或 Base URL") from e
