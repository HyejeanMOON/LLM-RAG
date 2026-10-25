"""界面语言：前端每个请求都带 Accept-Language（zh / en），后端的错误信息、默认提示词跟着变。

用 ContextVar 保存当前请求的语言，任何地方调用 t("中文", "English") 即可，不用层层传参。
没带这个头的请求（例如直接用 curl 调接口）默认中文。
"""
from contextvars import ContextVar

_lang: ContextVar[str] = ContextVar("lang", default="zh")


def parse(header: str | None) -> str:
    first = (header or "").split(",")[0].strip().lower()
    return "en" if first.startswith("en") else "zh"


def get_lang() -> str:
    return _lang.get()


def set_lang(lang: str):
    return _lang.set(lang)


def t(zh: str, en: str) -> str:
    return en if _lang.get() == "en" else zh


class LanguageMiddleware:
    """纯 ASGI 中间件：把请求头里的语言放进 ContextVar，流式响应里也能读到。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope.get("headers") or [])
            token = _lang.set(parse(headers.get(b"accept-language", b"").decode("latin-1")))
            try:
                await self.app(scope, receive, send)
            finally:
                _lang.reset(token)
        else:
            await self.app(scope, receive, send)
