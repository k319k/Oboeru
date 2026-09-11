# おぼえる (Oboeru)

音声で文章を練習する SvelteKit アプリ。表示された文を読み上げ、マイクで録音した音声を文字起こしして類似度を採点します。

## セットアップ

```bash
npm install
```

### GROQ_API_KEY の取得と設定

文字起こし（音声認識）に Groq の Whisper API を使います。無料枠で利用できます。

1. [Groq コンソール](https://console.groq.com/) にアクセスし、アカウントを作成（またはログイン）します。
2. 左メニューの **API Keys** を開き、**Create API Key** をクリックします。
3. 表示されたキーをコピーします（この画面を閉じると再表示されません）。
4. プロジェクト直下の `.env` ファイルに貼り付けます:

```bash
GROQ_API_KEY=ここに取得したキーを貼り付け
```

`.env` は存在しない場合は作成してください。`.env.example` をコピーして使うこともできます。

```bash
cp .env.example .env
```

### GOOGLE_TTS_API_KEY の取得と設定

音声読み上げ（TTS）に Google Cloud Text-to-Speech API を使います。Neural2 音声は月 100万文字まで無料です（超過時は $16/100万文字）。

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセスし、アカウントを作成（またはログイン）します。
2. **API とサービス** → **ライブラリ** で **Cloud Text-to-Speech API** を検索し、**有効に** をクリックします。
3. **API とサービス** → **認証情報** で **認証情報を作成** → **API キー** を選択します。
4. 作成したキーの **API キーを制限** をクリックし、**アプリケーション制限** → **API キーを制限** で **Cloud Text-to-Speech API** のみに制限することを推奨します。
5. プロジェクト直下の `.env` ファイルに貼り付けます:

```bash
GOOGLE_TTS_API_KEY=ここに取得したキーを貼り付け
```

Cloudflare Workers を使用している場合は、デプロイ時にシークレットとして登録します:

```bash
npx wrangler secret put GOOGLE_TTS_API_KEY
```

キーが未設定のまま `/api/tts` を呼び出すと 503 が返り、練習ページでは「TTS API キーが未設定です」というトーストが表示されます。録音練習自体は引き続き利用可能です。

## 起動とコマンド

| コマンド | 説明 |
|---|---|
| `npm run dev` | 開発サーバー起動（http://localhost:5173） |
| `npm run build` | プロダクションビルド |
| `npm run preview` | ビルド成果物のプレビュー |
| `npm run check` | 型チェック（svelte-check） |
| `npm test` | ユニットテスト（vitest） |
| `npm run test:e2e` | E2E テスト（Playwright） |

## Cloudflare Workers へのデプロイ

このアプリは Cloudflare Workers 上で動作します。デプロイ手順は以下のとおりです。

1. Cloudflare にログインします:

   ```bash
   npx wrangler login
   ```

2. `GROQ_API_KEY` を Workers のシークレットとして登録します（値は対話的に入力します）:

   ```bash
   npx wrangler secret put GROQ_API_KEY
   ```

3. プロダクションビルドを実行します:

   ```bash
   npm run build
   ```

4. デプロイします:

   ```bash
   npx wrangler deploy
   ```

`GROQ_API_KEY` はビルド時に埋め込まれず、実行時に Workers のシークレットから読み込まれます。キーが未設定のまま `/api/transcribe` を呼び出すと 503 が返ります。

## 使い方

### 練習する

1. トップページでチャプターを選択し、**練習開始** をクリックします。
2. 文が表示され、読み上げ（TTS）が再生されます。
3. 読み上げが終わると文が隠れ、録音が始まります。表示されていた文を声に出して読みます。
4. 録音が終わると文字起こしされ、類似度が採点されます。
   - しきい値以上なら次の文へ自動で進みます。
   - しきい値未満なら同じ文をやり直します。
5. 全文が終わるとサマリー（総文数・平均類似度・スキップ数）が表示されます。

**スキップ** で現在の文を飛ばし、**終了** で途中終了できます。

### 管理画面

トップページの **管理画面で追加する** リンクから `/manage` に移動します。

- チャプターと文の追加・編集・削除（チャプターは入れ子にできます）
- **エクスポート**: 全データを JSON ファイルとしてダウンロード
- **インポート**: JSON ファイルからデータを復元
- **設定**: 合格しきい値（%）、読み上げ速度、音声（voice）、リトライ動作

データはブラウザの localStorage に保存されます（キー: `oboeru:v1` / `oboeru:settings:v1`）。ブラウザを変えるとデータは引き継がれません。JSON エクスポートでバックアップしてください。

## 制限事項

- **ブラウザ対応**: 読み上げはサーバー経由の Google Cloud TTS（Neural2）を使用するため、Firefox でも安定して動作します。マイク録音（MediaRecorder）はブラウザによって挙動が異なるため、録音機能を利用する場合は Chromium 系ブラウザ（Chrome / Edge）を推奨します。
- **TTS 品質**: 読み上げ音声は Google Cloud TTS の Neural2 を使用しています。管理画面の設定から「デフォルト（言語に応じて自動）」+ 日本語 3 声 + English 3 声から音声を選択できます。
- **API レート制限**: Groq の無料枠はおおよそ 1 分あたり 20 リクエスト（20 RPM）です。クライアントは 3.5 秒間隔のスロットリングと、429 応答時の指数バックオフ（最大 3 回リトライ）で対応しています。混雑時は「混雑中です。しばらくお待ちください。」と表示されます。
- **ライブ STT テスト**: E2E テストのうち 1 件は `GROQ_API_KEY` が設定されている場合のみ実行されます。キーがない場合はスキップされます（他のテストはすべてキーなしで通ります）。

## テスト

```bash
npm test          # ユニットテスト（vitest）
npm run test:e2e  # E2E テスト（Playwright、Chromium が必要）
```

E2E テストはマイクと TTS をモックして実行するため、実機のマイクは不要です。