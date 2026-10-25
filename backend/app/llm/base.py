"""LLM 统一接口：不同厂商的实现都提供 stream(system, messages) -> 逐段文本。"""
from dataclasses import dataclass, field
from typing import Iterator, Protocol


@dataclass
class ProviderConfig:
    id: str
    name: str
    type: str          # anthropic | openai
    model: str
    api_key: str = ""
    base_url: str = ""
    extra: dict = field(default_factory=dict)


class LLMError(RuntimeError):
    """调用模型失败时抛出，消息会直接展示给用户。"""


class LLM(Protocol):
    def stream(self, system: str, messages: list[dict]) -> Iterator[str]: ...
