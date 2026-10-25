"""LLM 提供商配置（可以配置多个，问答时随时切换）。"""
import json
import uuid
from datetime import datetime, timezone

from .. import db
from ..i18n import t
from ..llm import ProviderConfig
from . import settings

TYPES = {"anthropic", "openai"}


class NotFound(LookupError):
    pass


def _mask(key: str) -> str:
    if not key:
        return ""
    return key[:6] + "…" + key[-4:] if len(key) > 12 else "…" + key[-2:]


def _public(r) -> dict:
    d = dict(r)
    d["extra"] = json.loads(d["extra"] or "{}")
    d["has_api_key"] = bool(d["api_key"])
    d["api_key"] = _mask(d["api_key"])  # 永远不把完整 key 返回给前端
    d["is_default"] = d["id"] == settings.get("default_provider_id")
    return d


def list_providers() -> list[dict]:
    with db.tx() as conn:
        rows = conn.execute("SELECT * FROM providers ORDER BY created_at").fetchall()
    return [_public(r) for r in rows]


def _get_row(pid: str):
    with db.tx() as conn:
        r = conn.execute("SELECT * FROM providers WHERE id = ?", (pid,)).fetchone()
    if not r:
        raise NotFound(pid)
    return r


def get_provider(pid: str) -> dict:
    return _public(_get_row(pid))


def get_config(pid: str | None) -> ProviderConfig:
    """取完整配置（含 key）。pid 为空时用默认提供商。"""
    pid = pid or settings.get("default_provider_id")
    if not pid:
        raise NotFound(t("还没有配置任何 LLM", "No LLM is configured yet"))
    r = dict(_get_row(pid))
    r["extra"] = json.loads(r.pop("extra") or "{}")
    r.pop("created_at")
    return ProviderConfig(**r)


def create_provider(data: dict) -> dict:
    if data["type"] not in TYPES:
        raise ValueError(f"type 必须是 {TYPES}")
    pid = uuid.uuid4().hex[:12]
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO providers (id, name, type, base_url, api_key, model, extra, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                pid, data["name"], data["type"], data.get("base_url") or "", data.get("api_key") or "",
                data["model"], json.dumps(data.get("extra") or {}),
                datetime.now(timezone.utc).isoformat(timespec="seconds"),
            ),
        )
    if not settings.get("default_provider_id"):
        settings.update({"default_provider_id": pid})
    return get_provider(pid)


def update_provider(pid: str, data: dict) -> dict:
    current = dict(_get_row(pid))
    fields = {k: data[k] for k in ("name", "type", "base_url", "model") if data.get(k) is not None}
    if fields.get("type", current["type"]) not in TYPES:
        raise ValueError(f"type 必须是 {TYPES}")
    if data.get("extra") is not None:
        fields["extra"] = json.dumps(data["extra"])
    # api_key：不传或传 None 表示不修改；传空字符串表示清除
    if data.get("api_key") is not None:
        fields["api_key"] = data["api_key"]
    if fields:
        sets = ", ".join(f"{k} = ?" for k in fields)
        with db.tx() as conn:
            conn.execute(f"UPDATE providers SET {sets} WHERE id = ?", (*fields.values(), pid))
    return get_provider(pid)


def delete_provider(pid: str):
    _get_row(pid)
    with db.tx() as conn:
        conn.execute("DELETE FROM providers WHERE id = ?", (pid,))
        nxt = conn.execute("SELECT id FROM providers ORDER BY created_at LIMIT 1").fetchone()
    if settings.get("default_provider_id") == pid:
        settings.update({"default_provider_id": nxt["id"] if nxt else None})


def set_default(pid: str):
    _get_row(pid)
    settings.update({"default_provider_id": pid})


def seed_defaults():
    """首次启动时放一个 Claude 配置进去（key 留空则读 ANTHROPIC_API_KEY 环境变量）。"""
    if list_providers():
        return
    create_provider({
        "name": "Claude Opus 5.5",
        "type": "anthropic",
        "model": "claude-opus-5-5",
        "extra": {"effort": "medium"},
    })
