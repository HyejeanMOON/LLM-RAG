"""Claude（Anthropic 官方 SDK），流式输出。"""
from typing import Iterator

import anthropic

from .base import LLMError, ProviderConfig

# 这些模型支持服务端拒答回退：被安全分类器拒绝时自动换推荐的备用模型重试
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}


class AnthropicLLM:
    def __init__(self, cfg: ProviderConfig):
        self.cfg = cfg
        # api_key 为空时 SDK 会读环境变量 ANTHROPIC_API_KEY
        self.client = anthropic.Anthropic(
            api_key=cfg.api_key or None,
            base_url=cfg.base_url or None,
        )

    def stream(self, system: str, messages: list[dict]) -> Iterator[str]:
        kwargs = dict(
            model=self.cfg.model,
            max_tokens=int(self.cfg.extra.get("max_tokens", 16000)),
            system=system,
            messages=messages,
        )
        effort = self.cfg.extra.get("effort", "medium")
        if effort:
            kwargs["output_config"] = {"effort": effort}

        try:
            if self.cfg.model in FALLBACK_MODELS:
                ctx = self.client.beta.messages.stream(
                    **kwargs, betas=["server-side-fallback-2026-07-01"], fallbacks="default"
                )
            else:
                ctx = self.client.messages.stream(**kwargs)
            with ctx as stream:
                yield from stream.text_stream
                final = stream.get_final_message()
        except anthropic.AuthenticationError as e:
            raise LLMError("Claude API Key 无效或未设置") from e
        except anthropic.NotFoundError as e:
            raise LLMError(f"模型不存在：{self.cfg.model}") from e
        except anthropic.RateLimitError as e:
            raise LLMError("请求太频繁或额度不足，请稍后再试") from e
        except anthropic.APIStatusError as e:
            raise LLMError(f"Claude 返回错误 {e.status_code}：{e.message}") from e
        except anthropic.APIConnectionError as e:
            raise LLMError("连接 Claude API 失败，请检查网络或 Base URL") from e
        except TypeError as e:
            # 既没填 key 也没有 ANTHROPIC_API_KEY 环境变量时，SDK 在发请求前抛 TypeError
            if "authentication" not in str(e):
                raise
            raise LLMError("没有设置 Claude API Key：请在模型设置里填写，或设置环境变量 ANTHROPIC_API_KEY") from e

        if final.stop_reason == "refusal":
            yield "\n\n（模型拒绝回答了这个问题。）"
        elif final.stop_reason == "max_tokens":
            yield "\n\n（回答达到长度上限被截断。）"
