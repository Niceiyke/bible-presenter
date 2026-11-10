"""Generates build_prebuilt_indexes.ipynb from build_prebuilt_indexes.py.

The Python script stays the single source of truth so the pins, corpus pipeline
and index writer cannot drift between the paste-and-run script and the Colab
notebook. Run this after editing the script:

    python tools/semantic-index-builder/make_notebook.py

The notebook keeps one code cell per `# Step N` section so Colab users get
incremental output instead of one enormous cell.
"""

import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
SOURCE = HERE / "build_prebuilt_indexes.py"
TARGET = HERE / "build_prebuilt_indexes.ipynb"

DOCSTRING = re.compile(r'^"""[\s\S]*?"""\n\n')
SECTION = re.compile(r"# -{20,}\n# (Step [^\n]+)\n# -{20,}\n")

INTRO = """# Pre-built semantic index builder (Colab)

Builds `bible-semantic-bge-base-v1.zip` — pre-built paraphrase indexes for
**NKJV, ASV, WEB, NIV, and AMP** — so operators download them during
preparation instead of embedding ~232k passages on the church machine.

**Before you run**

1. `Runtime → Change runtime type → T4 GPU` (CPU works, ~10x slower).
2. `Runtime → Run all`. The cells below mirror `build_prebuilt_indexes.py`
   exactly (this notebook is generated from it by `make_notebook.py`).
3. Bible source: the `wordlyte_bible.zip` release asset is fetched
   automatically; if it is missing you are prompted to upload
   `wordlyte_bible.db`.
4. Output lands at `/content/bible-semantic-bge-base-v1.zip` (~180 MB) and is
   offered for download. Re-running is safe — finished indexes are cached in
   `/content/semantic-cache` and skipped while their fingerprint matches.

**Publishing** — upload to the *latest* release, because the app resolves
`https://github.com/Niceiyke/bible-presenter/releases/latest/download/bible-semantic-bge-base-v1.zip`:

```bash
gh release upload <tag> bible-semantic-bge-base-v1.zip --clobber
```

Rebuild whenever the pinned model revision, the corpus pipeline, or a
translation's text in `wordlyte_bible.db` changes.
"""


def main() -> None:
    source = SOURCE.read_text(encoding="utf-8")
    stripped = DOCSTRING.sub("", source)
    chunks = SECTION.split(stripped)
    if len(chunks) < 3 or (len(chunks) - 1) % 2 != 0:
        raise SystemExit("expected '# Step N' section comments in the script")

    cells = [{"cell_type": "markdown", "metadata": {}, "source": INTRO.splitlines(keepends=True)}]
    cells.append(
        {
            "cell_type": "markdown",
            "metadata": {},
            "source": ["## Setup — imports, pins, work directory\n"],
        }
    )
    cells.append(
        {"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": chunks[0].splitlines(keepends=True)}
    )
    code_texts = [chunks[0]]
    for index in range(1, len(chunks), 2):
        title = chunks[index]
        body = chunks[index + 1]
        cells.append(
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [f"## {title}\n"],
            }
        )
        cells.append(
            {"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": body.splitlines(keepends=True)}
        )
        code_texts.append(body)

    # The notebook must reproduce the script byte-for-byte apart from the
    # docstring (now markdown above) and the section banners (now markdown
    # headings), so the pins cannot silently diverge.
    expected = SECTION.sub("", stripped)
    if "".join(code_texts) != expected:
        raise SystemExit("generated notebook cells do not reconstruct the script")

    notebook = {
        "cells": cells,
        "metadata": {
            "colab": {"provenance": [], "toc_visible": True},
            "kernelspec": {"display_name": "Python 3", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 0,
    }
    TARGET.write_text(json.dumps(notebook, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {TARGET.name}: {len(cells)} cells")


if __name__ == "__main__":
    main()
