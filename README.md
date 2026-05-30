# AI はてなブックマーク ダイジェスト (ai-hatebu-digest)

はてなブックマークのホットエントリー（テクノロジーカテゴリ）から記事を自動取得し、Geminiで要約したものをSlackに通知する、**Google Apps Script (GAS)** と **Google スプレッドシート** を使った完全無料のシステムです。

---

## 🚀 システム概要

```mermaid
sequenceDiagram
    autonumber
    actor User as ユーザー (Slack / Browser)
    participant GAS as GAS サーバー (Code.js)
    participant Sheet as Google スプレッドシート
    participant Hatebu as はてなブックマーク RSS / API
    participant WebPage as 各記事のWebページ
    participant Gemini as Gemini 2.5 Flash
    participant Slack as Slack

    Note over GAS, Slack: 【自動定期クローラー / 手動起動】
    alt 手動トリガー (URLアクセス)
        User->>GAS: WebアプリURLにアクセス (?token=XXX)
        GAS->>GAS: トークン検証
    else 定期実行 (日付ベーストリガー)
        Note over GAS: 1日1回などのタイマー起動
    end

    GAS->>Hatebu: RSSフィードを取得 (it.rss)
    Hatebu-->>GAS: RSS XMLデータを返却
    GAS->>Sheet: 既送信記事のURLリストを読み取り
    Sheet-->>GAS: 送信済URLリストを返却
    GAS->>GAS: 新着記事 (最大3件) を抽出
    
    loop 各新着記事
        GAS->>WebPage: 記事本文をスクレイピング
        WebPage-->>GAS: 本文テキスト (HTMLをクレンジング)
        GAS->>Gemini: 本文テキストを渡して要約を依頼
        Gemini-->>GAS: 日本語の要約
        GAS->>Hatebu: ブコメ取得 API (jsonlite) を呼び出し
        Hatebu-->>GAS: ブックマークコメント (最大5件)
        GAS->>Slack: 要約とブコメを含む Block Kit メッセージを送信
        GAS->>Sheet: 送信済記事のURLを保存
    end

    alt 手動トリガーの場合
        GAS-->>User: 処理完了ステータス (JSON) を返却
    end
```

### 💡 主な機能
1. **全自動定期実行 (1日1回など)**:
   - はてなブックマークのテクノロジーホットエントリーから新着記事を自動取得。
   - スプレッドシートの送信済履歴と比較し、重複するURLは自動除外。
   - 各記事の本文をスクレイピングし、Gemini APIを使用して要約。
   - はてなブックマークのEntry APIからコメント（ブコメ）を最大5件取得。
   - 新規記事（最大3件）をSlackチャンネルへ整形して通知。
2. **Slack上での情報完結**:
   - Slackの Block Kit 形式で、記事タイトル、Gemini要約、人気ブコメがスッキリとまとまったメッセージを配信。
   - iPhoneやPCのSlackアプリからダイレクトに要約とユーザー反応を確認可能。
3. **手動更新 (Webhook)**:
   - GASでデプロイしたWebアプリURLにアクセス（トークン付き）することで、いつでも手動で最新の情報を取得・要約・Slack送信可能。
4. **ランニングコスト0円**:
   - ホスティング & API: Google Apps Script (0円)
   - データベース: Google スプレッドシート (0円)
   - AI要約: Gemini API (Google AI Studio: 0円, 15 RPM)

---

## 🛠️ スクリプトプロパティ設定 (環境変数)

GASのプロジェクト設定で、以下のスクリプトプロパティ（Script Properties）を設定します。

| プロパティ名 | 必須/任意 | 説明 |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | 必須 | Google AI Studioから取得したGemini APIキー |
| `SLACK_WEBHOOK_URL` | 必須 | 通知させたいSlackチャンネルのIncoming Webhook URL |
| `APP_SECRET` | 必須 | 手動更新用URLに含める任意のパスワード（トークン）文字列 |
| `HATENA_RSS_URL` | 任意 | 取得対象のRSS。デフォルトは `https://b.hatena.ne.jp/hotentry/it.rss` |

---

## 📱 手動更新の利用方法

1. **アクセスURL**:
   - GASでデプロイしたWebアプリのURLに、設定した `APP_SECRET` をパラメータとして付与してアクセス（ブラウザや外部APIクライアント等からGETリクエスト）します。
   - 例: `https://script.google.com/macros/s/XXXXX/exec?token=YOUR_SECRET_STRING`
2. **レスポンス**:
   - 正常に完了すると `{"success": true, "processedCount": X}` のようなJSONが返却されます。

---

## ⚙️ セットアップ手順

1. **スプレッドシートの作成**:
   - 新規の Google スプレッドシートを作成します。
   - シート名を「Articles」にしておきます（送信済URLの履歴保存用）。
2. **Apps Script を開く**:
   - メニューの「拡張機能」 > 「Apps Script」を選択します。
3. **コードの配置**:
   - デフォルトで作成されている `コード.gs`（または `Code.gs`）に、`src/Code.js` のコードを貼り付けます。
4. **スクリプトプロパティの設定**:
   - 左メニューの歯車アイコン（プロジェクトの設定）をクリックします。
   - 画面下部の「スクリプトプロパティ」セクションで、「スクリプトプロパティを追加」をクリックし、`GEMINI_API_KEY`、`SLACK_WEBHOOK_URL`、`APP_SECRET` を設定し保存します。
5. **ウェブアプリのデプロイ (手動更新を利用する場合のみ)**:
   - 右上の「デプロイ」 > 「新しいデプロイ」をクリックします。
   - ギアアイコン（種類の選択）をクリックし、「ウェブアプリ」を選択します。
   - 以下のように設定します：
     - 次のユーザーとして実行: **自分**
     - アクセスできるユーザー: **全員**
   - 「デプロイ」をクリックし、承認プロンプトが表示された場合は許可します。
   - 発行された **「ウェブアプリのURL」** をコピーします。
6. **定期実行トリガーの設定**:
   - 左メニューの目覚まし時計アイコン（トリガー）をクリックします。
   - 右下の「トリガーを追加」をクリックします。
   - 以下のように設定します：
     - 実行する関数を選択: `runCron`
     - 実行するデプロイを選択: `Head`
     - イベントのソースを選択: **時間主導型**
     - 時間ベースのトリガーのタイプを選択: **日付ベースのタイマー**
     - 時刻を選択: **午前 7時〜8時**（お好みの時間）
   - 「保存」をクリックします。

---

## 🛠️ 実装ログ

### フェーズ1: コアロジック実装 ✅ 完了

#### バックエンド: [src/Code.js](src/Code.js)
- **`doGet(e)`**: WebアプリのURLパラメータ `token` を検証し、一致すれば `syncAndNotify()` を実行して結果をJSON形式で返却。
- **`checkToken(token)`**: `token` が `APP_SECRET` に一致するか判定。
- **`runCron()`**: 定期実行用エントリポイント。トークン不要でクローラーおよび通知を実行。
- **`syncAndNotify()`**:
  1. はてなブックマーク RSS から最新記事を取得。
  2. スプレッドシート「Articles」シートから送信済URL履歴を読み込み、新着記事（最大10件）を抽出。
  3. 各記事のWebページをスクレイピングし、不要タグを除去してプレーンテキスト（上限8,000文字）を抽出。
  4. Gemini 2.5 Flash API へリクエストし、日本語要約を生成。
  5. はてなブックマーク JSONLite API からブコメ（最大5件）を取得。
  6. Slack Block Kit メッセージを構築し、Webhook へ POST。
  7. 送信済URLをスプレッドシート先頭に追記（100件超の古い行を自動削除）。

#### 検証ステータス ✅
- GASエディタから `runCron` を手動実行し、RSS取得〜Gemini要約〜Slack通知の全フローが正常動作することを確認済み。

---

### フェーズ2: CI/CD環境構築 ✅ 完了

#### 構成ファイル
- **[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)**: `main` ブランチへのプッシュをトリガーに、テスト（Jest）→ GAS へのデプロイ（`clasp push`）を自動実行するワークフロー。
- **[`package.json`](package.json)**: `clasp`・`jest`・`@types/google-apps-script` を devDependencies に追加。
- **[`src/Code.test.js`](src/Code.test.js)**: Jest テストのエントリポイント。
- **[`.clasp.json.sample`](.clasp.json.sample)**: `scriptId` 設定のサンプルファイル（実際の `.clasp.json` は `.gitignore` で除外）。

#### GitHub Secrets の設定 ✅
| Secret名 | 内容 |
| :--- | :--- |
| `CLASPRC_JSON` | `~/.clasprc.json` の中身（`npx clasp login` で生成される認証情報） |
| `CLASP_JSON` | `.clasp.json` の中身（`scriptId` と `rootDir` を含むJSON）。`.clasp.json` は `.gitignore` で除外されているため、CI環境でファイルを再生成するために必要 |

#### CI/CDフロー
```
git push (main) → GitHub Actions 起動
  → npm ci（依存パッケージインストール）
  → npm test（Jest テスト実行）
  → ~/.clasprc.json を CLASPRC_JSON シークレットから生成
  → .clasp.json を CLASP_JSON シークレットから生成
  → clasp push -f（GASへデプロイ）
```

#### 修正履歴
- **Node.js 20 → 24 に更新**: `actions/checkout@v4` / `actions/setup-node@v4` の Node.js 20 非推奨警告を解消。
- **`CLASP_JSON` シークレット追加**: `.clasp.json` が `.gitignore` で除外されているため CI 環境に存在せず `clasp push` が失敗していた問題を修正。シークレットからファイルを生成するステップを追加。

---

## 🗺️ 今後のロードマップ

### フェーズ3: テストの拡充 ✅ 完了

#### テストファイル: [src/Code.test.js](src/Code.test.js)
- GASのグローバルオブジェクト（`PropertiesService`, `UrlFetchApp`, `XmlService`, `SpreadsheetApp`, `ContentService`, `Utilities`）を Jest でモック化し、ローカル環境で完結したテストを実現。
- 全関数をカバーする **20件** のテストケースを実装。
  | 関数 | テスト数 | 主なテスト内容 |
  | :--- | :---: | :--- |
  | `getProperties()` | 2 | プロパティ取得、デフォルトURL |
  | `checkToken()` | 4 | 正常・誤り・null・空文字 |
  | `doGet()` | 4 | 認証成功・失敗・例外ハンドリング |
  | `runCron()` | 2 | 正常終了・例外の非伝播 |
  | `syncAndNotify()` | 8 | シート不在・新着0件・重複除外・保存・削除・API失敗時の継続・最大10件制限 |
- `src/Code.js` 末尾に `typeof module !== 'undefined'` ガード付きの `module.exports` を追加（GAS本番環境への影響なし）。

#### 検証ステータス ✅
- `npm test` ローカル実行で 20 tests passed を確認済み。

---

### フェーズ4: 処理件数の削減と耐障害性の向上 (try-catch 強化) ✅ 完了

#### 改修内容: [src/Code.js](src/Code.js)
- **1回あたりの最大処理件数を 3件 に削減**:
  - GASの実行時間制限（90分/日）およびAPI制限の安全マージンを確保するため、新着記事の最大処理件数を `10` 件から `3` 件に減らしました。
- **ループ内エラーハンドリングの強化 (try-catch-finally の導入)**:
  - 記事ごとの処理（本文スクレイピング、Gemini API、ブコメAPI、スプレッドシート保存）全体を `try-catch-finally` で囲むことにより、いずれかの処理（特にスプレッドシートやAPI）で予期せぬ重大な例外が発生した場合でも、残りの記事の処理を中断させずに継続できるようにしました。
  - レートリミット回避用のウェイト処理（`Utilities.sleep(1500)`）を `finally` に配置し、例外発生時でも必ずウェイトが実行され、Gemini APIの RPM 制限（15回/分）を安定して回避できるようにしました。

#### テストファイル: [src/Code.test.js](src/Code.test.js)
- 処理制限テストの期待値を `3` 件に変更。
- ある記事の処理中に重大な例外が発生した場合でも、他の記事の処理がスキップされずに継続され、結果がカウントされることを検証する耐障害性テストを1件追加。

#### 検証ステータス ✅
- ローカル環境での `npm test`（全21件）がすべてパスすることを確認済み。

---

### フェーズ5: Slack通知の機能拡張 (次の作業)
- Block Kit のインタラクティブ機能（ボタン等）を活用し、Slack上からの追加アクション（例: 記事の保存、既読マーク等）を検討する。