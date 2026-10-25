from ..i18n import t
from .base import LLMError, ProviderConfig


def create_llm(cfg: ProviderConfig):
    if cfg.type == "anthropic":
        from .anthropic_provider import AnthropicLLM

        return AnthropicLLM(cfg)
    if cfg.type == "openai":
        from .openai_provider import OpenAICompatibleLLM

        return OpenAICompatibleLLM(cfg)
    raise LLMError(t(f"未知的 LLM 类型：{cfg.type}", f"Unknown LLM type: {cfg.type}"))


__all__ = ["LLMError", "ProviderConfig", "create_llm"]
