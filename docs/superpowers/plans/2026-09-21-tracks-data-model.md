# トラック構造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** チャプター→トラック→文の3層データ構造を導入し、管理/練習UI・インポートv2・babel.txt取り込みまで一気通貫で動かす。

**Architecture:** ストレージは同一キー `oboeru:v1` に `{chapters, tracks, sentences}` を保存 (旧データは読み込みシムで既定トラックに収容)。練習順は track.order → sentence.order の二段ソート。インポート/エクスポートは version 2 のみ。

**Tech Stack:** SvelteKit + TypeScript + Svelte 5 ($state/$effect)、vitest、Playwright

**Spec:** `docs/superpowers/specs/2026-09-21-tracks-data-model.md`

## Global Constraints

- 既存のデザインシステム準拠: shadcn-svelte コンポーネント、`src/app.css` のトークン (`--lang-ja/--lang-en` 等)、Badge/Button/AlertDialog の既存慣習
- a11y: axe serious/critical 0 維持、削除は必ず AlertDialog、グループ見出しに `role="group"` + `aria-label`
- 全タスクで `npm run check` (0エラー) と `npm test` を通す
- git コミットはタスク単位。`babel-import.json` と `.omo/` は絶対にコミットしない
- 日本語 UI 文言・日本語報告

---

### Task 1: 型 + ストレージ層 (Track 導入と二段ソート)

**Files:**
- Modify: `src/lib/types.ts` (Track 追加、Sentence.trackId)
- Modify: `src/lib/sentences.ts` (StoreData、読み込みシム、track CRUD、二段ソート、addSentence 署名)
- Modify: `src/lib/default-sentences.ts` (既定トラックを明示的に同梱)
- Test: `src/lib/sentences.test.ts`

**Interfaces:**
- Produces (後続タスクが依存):
  - `type Track = { id: string; chapterId: string; name: string; order: number }`
  - `Sentence.trackId: string`
  - `loadTracks(): Track[]` / `saveTracks(tracks: Track[]): void`
  - `addTrack(chapterId: string, name: string): Track` (order = 章内 max+1)
  - `updateTrack(id: string, updates: Partial<Omit<Track, 'id'>>): void`
  - `deleteTrack(id: string): void` (所属文も削除)
  - `getChapterTracks(chapterId: string, tracks: Track[]): Track[]` (order 昇順)
  - `getChapterSentences(chapterId: string, sentences: Sentence[]): Sentence[]` — **署名不変**、内部で loadTracks し (track.order, sentence.order) ソート
  - `addSentence(chapterId: string, text: string, language, trackId?: string): Sentence` — trackId 省略時は章の先頭トラック (無ければ自動作成「トラック1」)

- [ ] **Step 1: types.ts 更新**

```ts
export interface Track {
	id: string;
	chapterId: string;
	name: string;
	order: number;
}

export interface Sentence {
	id: string;
	chapterId: string;
	trackId: string;
	text: string;
	language: 'ja' | 'en';
	order: number;
}
```

- [ ] **Step 2: sentences.ts — StoreData と読み込みシム**

```ts
interface StoreData {
	chapters: Chapter[];
	tracks: Track[];
	sentences: Sentence[];
}

function defaultTrackFor(ch: Chapter): Track {
	return { id: `tr-${ch.id}`, chapterId: ch.id, name: 'トラック1', order: 1 };
}

function loadData(): StoreData {
	// 既存処理後、tracks が無ければ:
	//   tracks = chapters.map(defaultTrackFor)
	//   sentences = sentences.map(s => ({ ...s, trackId: s.trackId ?? `tr-${s.chapterId}` }))
	//   (未知の chapterId の文はスキップせず同様に付与)
}
```

- [ ] **Step 3: track CRUD + 二段ソート実装** (spec のシグネチャどおり。`deleteChapter` は子孫章の track も削除に変更。`getChapterSentences` は `trackOrder = new Map(loadTracks().map(t => [t.id, t.order]))` を作り `sort((a,b) => (trackOrder.get(a.trackId) ?? 999) - (trackOrder.get(b.trackId) ?? 999) || a.order - b.order)`)
- [ ] **Step 4: default-sentences.ts に既定トラック同梱** (`tr-ch-ja-01`「トラック1」/ `tr-ch-en-01`「トラック1」+ ja/en 全文に trackId)
- [ ] **Step 5: ユニットテスト追加** (track CRUD、二段ソート、deleteTrack カスケード、旧形式読み込みシム、addSentence 既定トラック)
- [ ] **Step 6: `npx vitest run src/lib` 全緑 → `npm run check` 0エラー → commit `feat: track data model in storage layer`**

---

### Task 2: 管理画面 (トラックUI + インポート/エクスポート v2)

**Files:**
- Modify: `src/routes/manage/+page.svelte` (文リストのグループ化、トラックCRUD、フォーム、v2)
- Test: `tests/manage.spec.ts`, `tests/io-settings.spec.ts`

**Interfaces:**
- Consumes: Task 1 の全シグネチャ
- Produces: testid — `track-group`(role=group, aria-label=トラック名), `track-name`, `track-order-up/down`, `edit-track`, `delete-track`, `confirm-delete-track`, `add-track`, `new-track-name`, `confirm-add-track`, `sentence-form-track`(セレクタ)

- [ ] **Step 1: 文リストをトラック別グループ化** — `filteredSentences` を trackId でグループ (`getChapterTracks` 順)。見出し: 名前 + (N文) + ↑↓/編集/削除。見出しクリックで折りたたみ。削除は AlertDialog (`delete-track` → `confirm-delete-track`)
- [ ] **Step 2: トラック追加** — `add-track` ボタン (章フィルタ中の章、無ければ各グループ横) → インライン入力 `new-track-name` → `confirm-add-track` → `addTrack(chapterId, name)`
- [ ] **Step 3: 文フォームにトラックセレクタ** — `sentence-form-track`。章セレクタ変更で options を連動 (`getChapterTracks`)、既定 = 先頭トラック。`confirmAddSentence` は `addSentence(chapterId, text, lang, trackId)`、`confirmEditSentence` は `updateSentence(id, { text, language, chapterId, trackId })`
- [ ] **Step 4: エクスポート v2** — `handleExport` に `version: 2` + `tracks: loadTracks()`
- [ ] **Step 5: インポート v2** — `validateImportJson`: `version !== 2` で拒否 / `tracks` 配列必須 / 各 track の `id,chapterId,name` 文字列 / 各 sentence の `trackId` 文字列。`handleImport`: tracks を ID マージ。メッセージ「N件のチャプター、N件のトラック、N件の文章をインポートしました」
- [ ] **Step 6: テスト** — manage.spec.ts にトラック追加/編名/削除/グループ表示を追加。io-settings.spec.ts: エクスポート検証を v2 (tracks 同梱) に、Validインポートを v2 に、version mismatch テストを `version:1` → 拒否 に変更
- [ ] **Step 7: `npm run check` + `npx playwright test tests/manage.spec.ts tests/io-settings.spec.ts` 全緑 → commit `feat: manage page track groups + import/export v2`**

---

### Task 3: 練習画面 (トラック順 + トラック名表示)

**Files:**
- Modify: `src/routes/practice/+page.svelte` (トラック名バッジ)
- Test: `tests/practice.spec.ts`

**Interfaces:**
- Consumes: Task 1 の `getChapterSentences` (二段ソート済み)
- Produces: testid `track-badge` (現在のトラック名を表示)

- [ ] **Step 1: トラック名派生** — `const tracks = loadTracks()` を onMount で読み、`currentTrackName = tracks.find(t => t.id === sentences[currentIndex]?.trackId)?.name ?? ''` を currentIndex から派生 ($derived)
- [ ] **Step 2: ヘッダ表示** — 章名の横に `<span data-testid="track-badge">{currentTrackName}</span>` (Badge 準拠、紫系 container 色)。進捗テキストは `{currentTrackName} · {progress}` (トラック名が空なら従来どおり progress のみ)
- [ ] **Step 3: テスト** — practice.spec.ts: 2トラック×2文の章で順序 (トラック1の文 → トラック2の文) と `track-badge` の遷移を検証
- [ ] **Step 4: `npx playwright test tests/practice.spec.ts` 全緑 → commit `feat: practice track order + track badge`**

---

### Task 4: babel.txt → v2 インポートファイル

**Files:**
- Modify: `.omo/exports/build_babel_import.py` (v2 + トラック解析)
- Modify: `.omo/exports/verify_babel_import.py` (v2 検証)
- Create (生成物): `/home/k319/develop/Oboeru/babel-import.json` (コミット禁止)

**Interfaces:**
- Consumes: `/home/k319/ダウンロード/babel.txt`、Task 2 の v2 スキーマ
- Produces: `{version:2, chapters:[ch-babel], tracks:[トラック24..27], sentences:[babel-NNN]}`

- [ ] **Step 1: ジェネレータ実装**

```python
TRACK = re.compile(r'^(\d+)トラック\s*$')

def parse(txt: str):
    tracks, sentences = [], []
    cur = None  # {name, order}
    for para in re.split(r'\n\s*\n', txt):          # 空行区切りブロック
        para = para.strip()
        if not para:
            continue
        m = TRACK.match(para)
        if m and '\n' not in para:
            cur = {'id': f'tr-babel-{m.group(1)}', 'chapterId': 'ch-babel',
                   'name': f'トラック{m.group(1)}', 'order': len(tracks) + 1}
            tracks.append(cur)
            continue
        en = ' '.join(l.strip() for l in para.splitlines() if not CJK.search(l))
        ja = ' '.join(l.strip() for l in para.splitlines() if CJK.search(l))
        for text, lang in ((en, 'en'), (ja, 'ja')):
            if text:
                n = len(sentences) + 1
                sentences.append({'id': f'babel-{n:03d}', 'chapterId': 'ch-babel',
                                  'trackId': cur['id'], 'text': text,
                                  'language': lang, 'order': n})
    return tracks, sentences
```

- [ ] **Step 2: 実行** — `python3 .omo/exports/build_babel_import.py` (トラック4件・文数を報告)
- [ ] **Step 3: 検証スクリプト更新 + 実行** — version 2 / tracks 4件 (24..27, order 1..4) / 全 sentence が trackId を持ち track が存在 / トラック内は「JA の直前に同ブロック EN が存在」構造を検証 / 重複報告。`ALL CHECKS PASSED` を確認
- [ ] **Step 4: git 状態確認** — `babel-import.json` が untracked のまま (コミットしない)
- [ ] **Step 5: commit (スクリプトは .omo 配置のため対象外。コミット不要)**

---

### Task 5: 全体検証

- [ ] **Step 1: `npm run check` / `npm test` / `npx playwright test` (全体) 全緑** (1件の既存 skip はそのまま)
- [ ] **Step 2: 手動QA** — `npm run dev` → 管理画面でバベルの塔をインポート (ユーザー実施でも可) → トラック表示/練習順/バッジを確認
- [ ] **Step 3: 完了報告**
