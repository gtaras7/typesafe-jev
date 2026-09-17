#!/usr/bin/env python3
"""Extract text from PDFs via pymupdf.

Two modes, same output format for a single file:

    pdf_to_text.py <path.pdf>
        writes the extracted text to stdout.

    pdf_to_text.py --batch
        reads one file path per line on stdin and writes one JSON object per line
        on stdout: {"path": "...", "text": "...", "error": null}

Batch mode exists because a folder of 300 CVs would otherwise mean 300 python
startups, which costs more wall time than the judgments themselves. One process,
one import, 300 files.

Whitespace is collapsed so a PDF that wraps a sentence across lines still reads as one sentence.
"""
import json
import sys

try:
    import fitz  # pymupdf
except ImportError:
    sys.stderr.write("pymupdf not installed: python3 -m pip install pymupdf\n")
    sys.exit(3)


def extract(path: str) -> str:
    doc = fitz.open(path)
    try:
        pages = [" ".join(page.get_text().split()) for page in doc]
    finally:
        doc.close()
    return " ".join(pages)


def main() -> int:
    args = sys.argv[1:]

    if args and args[0] == "--batch":
        for line in sys.stdin:
            path = line.strip()
            if not path:
                continue
            try:
                sys.stdout.write(json.dumps({"path": path, "text": extract(path)}) + "\n")
            except Exception as exc:  # noqa: BLE001
                sys.stdout.write(
                    json.dumps({"path": path, "text": "", "error": str(exc)}) + "\n"
                )
            sys.stdout.flush()
        return 0

    if len(args) != 1:
        sys.stderr.write("usage: pdf_to_text.py <path.pdf> | --batch\n")
        return 2

    try:
        sys.stdout.write(extract(args[0]))
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"could not open PDF: {exc}\n")
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
