"""OpenAI 兼容接口：OpenAI、DeepSeek、通义千问、Kimi、智谱，以及本地的 Ollama / LM Studio / llama.cpp 都能用。"""
import os
from typing import Iterator

import openai

from ..i18n import t
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
            raise LLMError(t("API Key 无效或未设置", "Invalid or missing API key")) from e
        except openai.NotFoundError as e:
            where = f"{self.cfg.model} @ {self.cfg.base_url or 'api.openai.com'}"
            hint = t(f"。本地模型请先下载，例如 `ollama pull {self.cfg.model}`", f". Download local models first, e.g. `ollama pull {self.cfg.model}`") if _is_local(self.cfg.base_url) else ""
            raise LLMError(t(f"模型或接口地址不存在：{where}", f"Model or endpoint not found: {where}") + hint) from e
        except openai.RateLimitError as e:
            raise LLMError(t("请求太频繁或额度不足，请稍后再试", "Rate limited or out of quota, please try again later")) from e
        except openai.APIStatusError as e:
            raise LLMError(t(f"模型接口返回错误 {e.status_code}：{e.message}", f"Model API error {e.status_code}: {e.message}")) from e
        except openai.APIConnectionError as e:
            raise LLMError(_connection_hint(self.cfg.base_url)) from e


def _is_local(base_url: str) -> bool:
    return any(h in (base_url or "") for h in ("localhost", "127.0.0.1", "host.docker.internal"))


def _connection_hint(base_url: str) -> str:
    msg = t("连接模型接口失败，请检查网络或 Base URL", "Could not connect to the model API. Check the network or Base URL")
    if "localhost" in (base_url or "") or "127.0.0.1" in (base_url or ""):
        if os.path.exists("/.dockerenv"):
            return msg + t(
                "。后端运行在 Docker 里，localhost 指的是容器自己，访问宿主机上的模型请把地址改成 http://host.docker.internal:端口/v1",
                ". The backend runs in Docker, where localhost is the container itself. To reach a model on the host, use http://host.docker.internal:PORT/v1",
            )
    if _is_local(base_url):
        return msg + t(
            "。本地模型服务启动了吗？Ollama 可以运行 `ollama serve`，再用 `ollama list` 看已安装的模型",
            ". Is the local model server running? For Ollama, run `ollama serve`, then `ollama list` to see installed models",
        )
    return msg
