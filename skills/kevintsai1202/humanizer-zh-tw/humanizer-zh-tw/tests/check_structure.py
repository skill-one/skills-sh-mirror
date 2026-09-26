"""比對原始 Markdown 與改寫副本中的受保護區段是否完全一致（唯讀檢查）。"""

import argparse
import json
import re
from pathlib import Path


def protected_parts(text):
    """擷取 Markdown 中不應被潤飾改動的區段。

    回傳 dict：鍵是區段類型，值是依出現順序排列的擷取結果。
    原稿與改寫稿的同一個鍵必須完全相等，才算保留成功。
    """
    # YAML front matter：只認檔案最開頭、由 --- 包住的區塊
    frontmatter = re.match(r"\A---\n.*?\n---\n", text, re.S)
    return {
        "frontmatter": frontmatter.group(0) if frontmatter else None,
        # 圍欄程式碼區塊（含開頭的語言標記與內容）
        "fenced_code": re.findall(r"^```[^\n]*\n.*?^```[ \t]*$", text, re.M | re.S),
        # 行內程式碼（單一反引號包住的內容）
        "inline_code": re.findall(r"(?<!`)`([^`\n]+)`(?!`)", text),
        # 各層級標題；改動會破壞自動錨點
        "headings": re.findall(r"^#{1,6} .+$", text, re.M),
        # 連結目標（URL 與頁內錨點）
        "link_targets": re.findall(r"\]\(([^\n)]+)\)", text),
        # 表格列（含表頭與分隔列）
        "table_rows": re.findall(r"^\|.*\|$", text, re.M),
        # 有序步驟清單
        "ordered_steps": re.findall(r"^\d+\. .+$", text, re.M),
        # 帶明確 id 屬性的 HTML 標籤（頁內連結的目標）
        "explicit_ids": re.findall(r'<[^>]+\bid="[^"]+"[^>]*>', text),
    }


def main():
    """讀入原稿與改寫稿，逐類比對受保護區段，並以 JSON 輸出結果。

    全部一致時回傳 0；任一類不一致時回傳 1，方便在腳本或 CI 中判斷。
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="原始 Markdown 檔，例如 tests/fixtures/structure.md")
    parser.add_argument("edited", type=Path, help="交給 skill 潤飾後的副本")
    args = parser.parse_args()
    before = protected_parts(args.source.read_text(encoding="utf-8"))
    after = protected_parts(args.edited.read_text(encoding="utf-8"))
    # 逐類比對：True 表示該類受保護區段完全保留
    checks = {key: before[key] == after[key] for key in before}
    print(json.dumps({"preserved": checks, "passed": all(checks.values())}, indent=2))
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
