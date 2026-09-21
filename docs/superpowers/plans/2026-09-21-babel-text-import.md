# バベルの塔テキスト取り込み Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the-tower-of-babel の segments.json (英→日交互184行) から、Oboeru 管理画面のインポート形式に合致する `babel-import.json` を生成・検証する。

**Architecture:** アプリ変更ゼロ。Python ワンオフスクリプトで JSON 変換し、Oboeru 既存の `handleImport` (ID マージ) で取り込む。検証は manage の `validateImportJson` と同じ必須フィールド + 仕様チェック (件数・交互・重複) を独立スクリプトで行う。

**Tech Stack:** Python 3 (標準ライブラリのみ)

**Spec:** `docs/superpowers/specs/2026-09-21-babel-text-import-design.md`

## Global Constraints

- ソース: `/home/k319/develop/the-tower-of-babel/segments.json` (変更しない・読み取りのみ)
- 出力: `/home/k319/develop/Oboeru/babel-import.json`
- chapter: `{id: "ch-babel", name: "バベルの塔", parentId: null, order: 99}` — 値は仕様どおり固定
- sentence: `id` は `babel-001`〜 (0埋め3桁)、`order` は 1始まり連番、`chapterId` は `ch-babel`
- `language`: 平仮名/カタカナ/漢字を含む → `ja`、それ以外 → `en` (regex `[ぁ-んァ-ヶ一-龯]`)
- text は trim、trim 後に空になる行は除外する
- **`babel-import.json` と `.omo/` は絶対に git コミットしない** (.omo は gitignore 済み、json は untracked のまま)
- ユーザーへの応答は日本語

---

### Task 1: 生成スクリプトの作成と実行

**Files:**
- Create: `.omo/exports/build_babel_import.py`
- Create (生成物): `/home/k319/develop/Oboeru/babel-import.json`

**Interfaces:**
- Consumes: segments.json の `lines[].text`
- Produces: Task 2 が検証する `babel-import.json` (スキーマは spec 参照)

- [ ] **Step 1: 生成スクリプトを書く**

```python
#!/usr/bin/env python3
"""Generate Oboeru import JSON from the-tower-of-babel segments.json."""
import json
import re
from pathlib import Path

SRC = Path('/home/k319/develop/the-tower-of-babel/segments.json')
OUT = Path('/home/k319/develop/Oboeru/babel-import.json')
CJK = re.compile(r'[ぁ-んァ-ヶ一-龯]')


def detect_language(text: str) -> str:
    return 'ja' if CJK.search(text) else 'en'


def main() -> None:
    data = json.loads(SRC.read_text(encoding='utf-8'))
    texts = [line['text'].strip() for line in data['lines']]
    texts = [t for t in texts if t]
    sentences = [
        {
            'id': f'babel-{i:03d}',
            'chapterId': 'ch-babel',
            'text': text,
            'language': detect_language(text),
            'order': i,
        }
        for i, text in enumerate(texts, start=1)
    ]
    payload = {
        'chapters': [
            {'id': 'ch-babel', 'name': 'バベルの塔', 'parentId': None, 'order': 99}
        ],
        'sentences': sentences,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'wrote {OUT}: {len(payload["chapters"])} chapter, {len(sentences)} sentences')


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: 実行する**

Run: `python3 .omo/exports/build_babel_import.py`
Expected: `wrote /home/k319/develop/Oboeru/babel-import.json: 1 chapter, 184 sentences`
(184 以外になった場合: 空行除外の影響 → Task 2 で交互パターンと突合し、spec の「件数報告」に従う)

- [ ] **Step 3: 先頭と末尾を目視確認**

Run: `python3 -c "import json; d=json.load(open('/home/k319/develop/Oboeru/babel-import.json')); print(d['chapters']); print(d['sentences'][0]); print(d['sentences'][-1])"`
Expected: chapter は `ch-babel`/`バベルの塔`/order 99。先頭は `babel-001` "The Tower of Babel." (en, order 1)、末尾は `babel-184` (ja, order 184)。

---

### Task 2: 検証スクリプトの作成と実行

**Files:**
- Create: `.omo/exports/verify_babel_import.py`
- Read: `/home/k319/develop/Oboeru/babel-import.json` (Task 1 の生成物)

**Interfaces:**
- Consumes: `babel-import.json`
- Produces: 検証レポート (stdout)。exit 0 = 全チェック合格、exit 1 = エラー一覧

- [ ] **Step 1: 検証スクリプトを書く**

```python
#!/usr/bin/env python3
"""Verify babel-import.json against the Oboeru import contract + spec checks."""
import json
import re
from collections import Counter
from pathlib import Path

OUT = Path('/home/k319/develop/Oboeru/babel-import.json')
CJK = re.compile(r'[ぁ-んァ-ヶ一-龯]')


def main() -> None:
    data = json.loads(OUT.read_text(encoding='utf-8'))
    errors = []

    chapters = data['chapters']
    if len(chapters) != 1:
        errors.append(f'chapters: expected 1, got {len(chapters)}')
    ch = chapters[0]
    for field in ('id', 'name'):
        if not isinstance(ch.get(field), str):
            errors.append(f'chapter.{field} missing or not a string')

    sentences = data['sentences']
    if len(sentences) != 184:
        errors.append(f'sentences: expected 184, got {len(sentences)}')

    langs = []
    dupes = Counter()
    for i, s in enumerate(sentences, start=1):
        if s.get('id') != f'babel-{i:03d}':
            errors.append(f'sentence[{i}].id mismatch: {s.get("id")!r}')
        if s.get('chapterId') != 'ch-babel':
            errors.append(f'sentence[{i}].chapterId mismatch: {s.get("chapterId")!r}')
        text = s.get('text')
        if not isinstance(text, str) or not text.strip():
            errors.append(f'sentence[{i}].text empty or not a string')
            continue
        dupes[text] += 1
        expected_lang = 'ja' if CJK.search(text) else 'en'
        if s.get('language') != expected_lang:
            errors.append(f'sentence[{i}].language: expected {expected_lang}, got {s.get("language")!r}')
        if s.get('order') != i:
            errors.append(f'sentence[{i}].order: expected {i}, got {s.get("order")!r}')
        langs.append(expected_lang)

    pattern = ''.join('E' if x == 'en' else 'J' for x in langs)
    if pattern != 'EJ' * (len(langs) // 2):
        first_bad = next((k for k, (a, b) in enumerate(zip(langs[::2], langs[1::2])) if (a, b) != ('en', 'ja')), None)
        errors.append(f'alternation broken (pair index {first_bad})')

    dupe_texts = {t: n for t, n in dupes.items() if n > 1}
    print(f'sentences: {len(sentences)} (en={langs.count("en")}, ja={langs.count("ja")})')
    print(f'alternation EJ pattern: {"OK" if pattern == "EJ" * (len(langs) // 2) else "NG"}')
    print(f'duplicate texts: {len(dupe_texts)} kind(s)')
    for t, n in list(dupe_texts.items())[:10]:
        print(f'  x{n}: {t[:50]}')

    if errors:
        print('ERRORS:')
        for e in errors:
            print(f'  - {e}')
        raise SystemExit(1)
    print('ALL CHECKS PASSED')


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: 実行する**

Run: `python3 .omo/exports/verify_babel_import.py`
Expected: `ALL CHECKS PASSED`。`duplicate texts` の件数は仕様どおり「除去せず報告」する (spec の検証4)。

- [ ] **Step 3: git 状態を確認 (コミット禁止の担保)**

Run: `git status --short`
Expected: `babel-import.json` は `??` (untracked) のまま。**コミット・プッシュしない**。`.omo/` は表示されない (gitignore)。

---

### Task 3: 完了報告 (ユーザーへの引き渡し)

**Files:** なし (報告のみ)

- [ ] **Step 1: 報告する**

報告内容:
1. 生成物のパス: `/home/k319/develop/Oboeru/babel-import.json`
2. 検証結果 (Task 2 の stdout をそのまま貼る)
3. 導入手順: Oboeru を開く → 管理画面 → データのインポート → `babel-import.json` を選択 → 「1件のチャプター、184件の文章をインポートしました」を確認
4. 注意: 一部の行は曲の区切りで文が途中まで (例: "...came to be built in") — spec どおり未処理
