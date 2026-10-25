from typing import Literal

from pydantic import BaseModel, Field


class DocumentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1)


class DocumentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, min_length=1)


class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    top_k: int | None = Field(default=None, ge=1, le=50)
    doc_ids: list[str] | None = None
    min_score: float | None = Field(default=None, ge=-1, le=1)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(SearchRequest):
    provider_id: str | None = None
    history: list[ChatMessage] = []


class ProviderCreate(BaseModel):
    name: str = Field(min_length=1)
    type: Literal["anthropic", "openai"]
    model: str = Field(min_length=1)
    base_url: str = ""
    api_key: str = ""
    extra: dict = {}


class ProviderUpdate(BaseModel):
    name: str | None = None
    type: Literal["anthropic", "openai"] | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None  # None = 不修改
    extra: dict | None = None


class SettingsUpdate(BaseModel):
    chunk_size: int | None = Field(default=None, ge=50, le=4000)
    chunk_overlap: int | None = Field(default=None, ge=0, le=1000)
    top_k: int | None = Field(default=None, ge=1, le=50)
    min_score: float | None = Field(default=None, ge=-1, le=1)
    history_turns: int | None = Field(default=None, ge=0, le=20)
