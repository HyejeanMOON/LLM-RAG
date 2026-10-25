"""把上传的文件转成纯文本。支持 .md .txt .pdf .docx"""
import io

from .i18n import t

SUPPORTED = {".md", ".markdown", ".txt", ".pdf", ".docx"}


class UnsupportedFile(ValueError):
    pass


def extract_text(filename: str, data: bytes) -> tuple[str, str]:
    """返回 (纯文本, 文件类型)。"""
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in SUPPORTED:
        raise UnsupportedFile(t(
            f"不支持的文件类型：{ext or '无扩展名'}，支持 {', '.join(sorted(SUPPORTED))}",
            f"Unsupported file type: {ext or 'no extension'}. Supported: {', '.join(sorted(SUPPORTED))}",
        ))

    if ext == ".pdf":
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        text = "\n\n".join((page.extract_text() or "").strip() for page in reader.pages)
    elif ext == ".docx":
        import docx

        document = docx.Document(io.BytesIO(data))
        lines = []
        for p in document.paragraphs:
            # 把 Word 的标题样式转成 Markdown 标题，切片时就能按章节切
            style = (p.style.name or "").lower() if p.style is not None else ""
            if style.startswith("heading") and style[-1:].isdigit():
                lines.append("#" * int(style[-1]) + " " + p.text)
            else:
                lines.append(p.text)
        text = "\n\n".join(lines)
    else:
        text = _decode(data)

    text = text.strip()
    if not text:
        raise UnsupportedFile(t("没有从文件中提取到文字（扫描版 PDF 需要先做 OCR）", "No text could be extracted (scanned PDFs need OCR first)"))
    return text, ext.lstrip(".")


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")
