from app import i18n

from test_api import _events

EN = {"Accept-Language": "en"}


def test_parse_header():
    assert i18n.parse("en-US,en;q=0.9") == "en"
    assert i18n.parse("zh") == "zh"
    assert i18n.parse(None) == "zh"


def test_errors_follow_accept_language(client):
    assert client.get("/api/documents/nope").json()["detail"] == "文档不存在"
    assert client.get("/api/documents/nope", headers=EN).json()["detail"] == "Document not found"


def test_default_prompt_follows_language_until_customized(client):
    zh = client.get("/api/settings").json()["generation"]
    en = client.get("/api/settings", headers=EN).json()["generation"]
    assert "问题：" in zh["user_template"]
    assert en["user_template"].endswith("Question: {question}")
    assert en["system_prompt"].startswith("You are an assistant")
    # 自己改过之后就不再跟着语言变
    client.put("/api/settings", json={"generation": {"system_prompt": "custom"}}, headers=EN)
    assert client.get("/api/settings").json()["generation"]["system_prompt"] == "custom"


def test_chat_stream_uses_english(client, monkeypatch):
    seen = {}

    class FakeLLM:
        def __init__(self, cfg):
            pass

        def stream(self, system, messages):
            seen["system"] = system
            yield "ok"

    monkeypatch.setattr("app.services.rag.create_llm", FakeLLM)
    _events(client.post("/api/chat", json={"query": "annual leave?"}, headers=EN).text)
    assert seen["system"].startswith("You are an assistant")
    ev = _events(client.post("/api/chat", json={"query": "hi", "provider_id": "nope"}, headers=EN).text)
    assert ev[-1] == ("error", {"message": "LLM config not found. Add one on the LLM models page first."})


def test_embedding_models_localized(client):
    zh = client.get("/api/embedding/models").json()[0]
    en = client.get("/api/embedding/models", headers=EN).json()[0]
    assert zh["lang"] == "中文" and en["lang"] == "Chinese"
