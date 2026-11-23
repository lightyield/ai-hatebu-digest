// プロパティ取得用ヘルパー
function getProperties() {
  const props = PropertiesService.getScriptProperties().getProperties();
  return {
    GEMINI_API_KEY: props.GEMINI_API_KEY,
    SLACK_WEBHOOK_URL: props.SLACK_WEBHOOK_URL,
    APP_SECRET: props.APP_SECRET,
    HATENA_RSS_URL: props.HATENA_RSS_URL || 'https://b.hatena.ne.jp/hotentry/it.rss',
    GITHUB_TOKEN: props.GITHUB_TOKEN || '',
    GITHUB_REPO: props.GITHUB_REPO || 'lightyield/ai-hatebu-digest',
    GAS_FAILURE_PROJECT_FILTER: props.GAS_FAILURE_PROJECT_FILTER !== undefined ? props.GAS_FAILURE_PROJECT_FILTER : 'ai-hatebu-digest,無題のプロジェクト',
    GAS_FAILURE_PROCESSED_LABEL: props.GAS_FAILURE_PROCESSED_LABEL || 'gas-failure-reported',
    GITHUB_ISSUE_LABELS: props.GITHUB_ISSUE_LABELS || ''
  };
}

function doGet(e) {
  // パラメータが渡されていない場合の安全策
  const token = (e && e.parameter) ? e.parameter.token : null;
  
  if (!checkToken(token)) {
    return ContentService.createTextOutput(JSON.stringify({success: false, error: "Unauthorized"}))
      .setMimeType(ContentService.MimeType.JSON);
  }
  
  try {
    const processedCount = syncAndNotify();
    return ContentService.createTextOutput(JSON.stringify({success: true, processedCount: processedCount}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({success: false, error: err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function checkToken(token) {
  const props = getProperties();
  return token && token === props.APP_SECRET;
}

function runCron() {
  try {
    syncAndNotify();
  } catch (err) {
    console.error(err);
  }
}

/**
 * 利用可能なGeminiモデル一覧を動的に取得し、要約に適したFlash系モデルを優先順にソートして返却する
 * @param {string} apiKey - Gemini APIキー
 * @returns {string[]} 利用可能なモデル名（ID）のリスト
 */
function getAvailableGeminiModels(apiKey) {
  const DEFAULT_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
  const MAX_CANDIDATE_MODELS = 3;
  if (!apiKey) return DEFAULT_MODELS;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    
    if (response.getResponseCode() !== 200) {
      console.warn(`Geminiモデル一覧取得失敗 (HTTP ${response.getResponseCode()}): `, response.getContentText());
      return DEFAULT_MODELS;
    }

    const data = JSON.parse(response.getContentText());
    if (!data.models || !Array.isArray(data.models)) {
      return DEFAULT_MODELS;
    }

    // 1. generateContent をサポートしているモデルを抽出
    const candidates = data.models.filter(m => {
      if (!m.name) return false;
      const methods = m.supportedGenerationMethods || [];
      return methods.includes('generateContent');
    }).map(m => m.name.replace(/^models\//, ''));

    // 2. 特殊用途モデル（画像生成、TTS、ネイティブオーディオプレビューなど）を除外
    const validModels = candidates.filter(name => {
      const lower = name.toLowerCase();
      if (lower.includes('image') || lower.includes('tts') || lower.includes('audio') || lower.includes('realtime') || lower.includes('embedding')) {
        return false;
      }
      return true;
    });

    // 3. Flash系モデルを優先し、バージョン降順でソート
    const flashModels = validModels.filter(m => m.toLowerCase().includes('flash'));
    const otherModels = validModels.filter(m => !m.toLowerCase().includes('flash') && m.toLowerCase().startsWith('gemini-'));

    const sortFn = (a, b) => {
      // プレビュー・実験用より安定版を優先
      const isPreviewA = a.includes('preview') || a.includes('exp');
      const isPreviewB = b.includes('preview') || b.includes('exp');
      if (isPreviewA !== isPreviewB) {
        return isPreviewA ? 1 : -1;
      }
      // バージョン番号の抽出比較 (例: gemini-2.5-flash -> 2.5)
      const vA = (a.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0';
      const vB = (b.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0';
      const numA = parseFloat(vA);
      const numB = parseFloat(vB);
      if (numA !== numB) {
        return numB - numA; // 降順
      }
      // -lite は高速・過負荷耐性が高いため同一バージョン内では標準版より先に配置
      const isLiteA = a.includes('lite');
      const isLiteB = b.includes('lite');
      if (isLiteA !== isLiteB) {
        return isLiteA ? -1 : 1;
      }
      return a.localeCompare(b);
    };

    flashModels.sort(sortFn);
    otherModels.sort(sortFn);

    const pool = flashModels.length > 0 ? flashModels : otherModels;
    if (pool.length === 0) return DEFAULT_MODELS;

    // 特性分散型の候補選定（最新Liteモデル、最新標準モデル、最も成熟した標準モデル）
    // GASの6分制限下でのハング・遅延を防ぐため、軽量・高速なLite系を最優先とする
    const liteModels = pool.filter(m => m.toLowerCase().includes('lite'));
    const standardModels = pool.filter(m => !m.toLowerCase().includes('lite'));

    const selected = [];

    // ① 最新の軽量Liteモデル（先頭）- 高速かつ過負荷耐性が高い
    if (liteModels.length > 0) {
      selected.push(liteModels[0]);
    }

    // ② 最新の標準Flashモデル - Lite系が利用不可・過負荷時のフォールバック先
    if (standardModels.length > 0 && !selected.includes(standardModels[0])) {
      selected.push(standardModels[0]);
    }

    // ③ 最も成熟した標準Flashモデル（末尾）- インフラが確立しており安定稼働
    if (standardModels.length > 1) {
      const stableStandards = standardModels.filter(m => !m.toLowerCase().includes('preview') && !m.toLowerCase().includes('exp'));
      const matureModel = stableStandards.length > 0 ? stableStandards[stableStandards.length - 1] : standardModels[standardModels.length - 1];
      if (!selected.includes(matureModel)) {
        selected.push(matureModel);
      }
    }

    // 候補数が上限（3件）に満たない場合は、プールからバージョン降順で重複なく補完
    for (let i = 0; i < pool.length; i++) {
      if (selected.length >= MAX_CANDIDATE_MODELS) break;
      if (!selected.includes(pool[i])) {
        selected.push(pool[i]);
      }
    }
    // それでも足りず otherModels がある場合も補完
    for (let i = 0; i < otherModels.length; i++) {
      if (selected.length >= MAX_CANDIDATE_MODELS) break;
      if (!selected.includes(otherModels[i])) {
        selected.push(otherModels[i]);
      }
    }

    return selected.slice(0, MAX_CANDIDATE_MODELS);
  } catch (e) {
    console.warn("Geminiモデル一覧取得中に例外が発生しました: ", e);
    return DEFAULT_MODELS;
  }
}

const IN_PROGRESS_ARTICLE_KEY = 'IN_PROGRESS_ARTICLE';

/**
 * thinkingConfig: { thinkingBudget: 0 } を適用する対象モデルかどうかを判定する
 * Gemini 2.5系では思考トークン抑制に有効だが、3.x系やomni系等では
 * INVALID_ARGUMENT (HTTP 400) となるケースがあるため2.5系のみに限定する
 * @param {string} modelName
 * @returns {boolean}
 */
function supportsThinkingBudgetZero(modelName) {
  if (!modelName || typeof modelName !== 'string') return false;
  return /^gemini-2\.5-/i.test(modelName);
}

/**
 * HTTP 400 レスポンス本文がAPIキー不正など全モデル共通の恒久エラーかどうかを判定する
 * @param {string} errBody
 * @returns {boolean}
 */
function isGeminiAuthOrKeyError(errBody) {
  if (!errBody || typeof errBody !== 'string') return false;
  const lower = errBody.toLowerCase();
  return (
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('invalid api key') ||
    lower.includes('permission_denied')
  );
}

/**
 * レスポンスヘッダーから大文字小文字を区別せず指定キーの値を取得する
 * @param {Object} headers
 * @param {string} targetName
 * @returns {string}
 */
function getHeaderCaseInsensitive(headers, targetName) {
  if (!headers || typeof headers !== 'object') return '';
  const lowerTarget = targetName.toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === lowerTarget) {
      return String(headers[keys[i]] || '');
    }
  }
  return '';
}

/**
 * Content-Type がHTML/テキスト系かどうかを判定する（ヘッダー未設定時は許容）
 * @param {string} contentType
 * @returns {boolean}
 */
function isHtmlOrTextContentType(contentType) {
  if (!contentType) return true;
  const lower = contentType.toLowerCase();
  return (
    lower.includes('text/') ||
    lower.includes('application/xhtml+xml') ||
    lower.includes('application/xml') ||
    lower.includes('application/json')
  );
}

/**
 * 指定タグのブロック（<tag ...>...</tag>）を線形時間 O(N) で安全に除去する
 * 正規表現によるバックトラッキング（ReDoS / CPUハング）を理論上防止する
 * @param {string} html
 * @param {string} tagName
 * @returns {string}
 */
function stripTagBlocks(html, tagName) {
  if (!html) return '';
  const openToken = `<${tagName}`;
  const closeToken = `</${tagName}`;
  const lower = html.toLowerCase();
  let result = '';
  let cursor = 0;

  while (cursor < html.length) {
    const startIdx = lower.indexOf(openToken, cursor);
    if (startIdx === -1) {
      result += html.substring(cursor);
      break;
    }
    // タグ名の直後が空白・'>'・'/' であることを確認（<scripted>等の誤爆防止）
    const nextChar = lower.charAt(startIdx + openToken.length);
    if (nextChar && nextChar !== '>' && nextChar !== '/' && !/\s/.test(nextChar)) {
      result += html.substring(cursor, startIdx + openToken.length);
      cursor = startIdx + openToken.length;
      continue;
    }

    result += html.substring(cursor, startIdx) + ' ';
    const closeIdx = lower.indexOf(closeToken, startIdx + openToken.length);
    if (closeIdx === -1) {
      // 閉じタグが無い場合は残りをすべて除去して終了
      break;
    }
    const closeEndIdx = lower.indexOf('>', closeIdx + closeToken.length);
    if (closeEndIdx === -1) {
      break;
    }
    cursor = closeEndIdx + 1;
  }

  return result;
}

/**
 * HTML文字列から安全かつ高速にプレーンテキストを抽出する
 * 巨大HTML・バイナリ混入時のCPUハングを防ぐため、クレンジング前に文字数上限を適用する
 * @param {string} rawHtml
 * @param {number} [maxRawLength=200000]
 * @param {number} [maxOutputLength=6000]
 * @returns {string}
 */
function extractPlainTextFromHtml(rawHtml, maxRawLength = 200000, maxOutputLength = 6000) {
  if (!rawHtml || typeof rawHtml !== 'string') return '';
  let html = rawHtml.length > maxRawLength ? rawHtml.substring(0, maxRawLength) : rawHtml;
  html = stripTagBlocks(html, 'script');
  html = stripTagBlocks(html, 'style');
  html = stripTagBlocks(html, 'noscript');
  html = html.replace(/<[^>]*>/g, ' ');
  html = html.replace(/\s+/g, ' ').trim();
  return html.substring(0, maxOutputLength);
}

function syncAndNotify() {
  const startTime = Date.now();
  // 実行時間ガード用の安全閾値（GAS上限 360秒 / 6分 に対する多段階防御）
  const MAX_ARTICLE_START_TIME_MS = 120 * 1000; // 2分00秒（新規記事の処理開始上限）
  const MAX_SCRAPE_TIME_MS = 140 * 1000;        // 2分20秒（スクレイピング試行上限）
  const MAX_GEMINI_TIME_MS = 160 * 1000;        // 2分40秒（Gemini API試行・リトライ・フォールバック上限）
  const MAX_HATENA_TIME_MS = 210 * 1000;        // 3分30秒（はてなブコメAPI取得上限）
  const MAX_SLACK_TIME_MS = 240 * 1000;         // 4分00秒（Slack通知送信上限）
  const SLOW_ATTEMPT_FALLBACK_MS = 15 * 1000;   // 15秒以上かかった失敗試行は同一モデル再試行せず即フォールバック
  const MAX_ARTICLES_PER_RUN = 3;               // 1回あたりの最大処理記事数

  const props = getProperties();
  const scriptProps = PropertiesService.getScriptProperties();
  const rssUrl = props.HATENA_RSS_URL;
  
  // 1. RSSの取得
  console.log(`[RSS取得開始] ${rssUrl}`);
  const response = UrlFetchApp.fetch(rssUrl);
  const xml = response.getContentText();
  const document = XmlService.parse(xml);
  const root = document.getRootElement();
  
  // はてなブックマークのRSSは RSS 1.0 (RDF) フォーマット
  const ns = XmlService.getNamespace('http://purl.org/rss/1.0/');
  const items = root.getChildren('item', ns);
  
  // 2. スプレッドシートから送信済URLの読み込み
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Articles');
  if (!sheet) throw new Error("シート 'Articles' が見つかりません。");
  
  const lastRow = sheet.getLastRow();
  let sentUrls = [];
  if (lastRow > 0) {
    const values = sheet.getRange(1, 1, lastRow, 1).getValues();
    sentUrls = values.map(row => row[0]).filter(url => url);
  }

  // 2.5 クラッシュリカバリ: 前回の実行が記事処理中に6分タイムアウト等で強制終了していた場合、
  //     該当URLを自動的に履歴登録・スキップして連日の再試行ループを遮断する
  if (scriptProps && typeof scriptProps.getProperty === 'function') {
    const rawInProgress = scriptProps.getProperty(IN_PROGRESS_ARTICLE_KEY);
    if (rawInProgress) {
      try {
        const crashedArticle = JSON.parse(rawInProgress);
        if (crashedArticle && crashedArticle.url) {
          console.warn(`[クラッシュリカバリ] 前回の実行が記事処理中に強制終了（タイムアウト等）した形跡を検出しました。再試行ループを防止するため該当記事をスキップ登録します: ${crashedArticle.url}`);
          if (!sentUrls.includes(crashedArticle.url)) {
            sheet.insertRowBefore(1);
            sheet.getRange(1, 1).setValue(crashedArticle.url);
            sentUrls.push(crashedArticle.url);
          }
          if (props.SLACK_WEBHOOK_URL && Date.now() - startTime <= MAX_SLACK_TIME_MS) {
            try {
              const recoveryBlocks = [
                {
                  "type": "header",
                  "text": {
                    "type": "plain_text",
                    "text": (crashedArticle.title || "前回タイムアウト記事").substring(0, 150),
                    "emoji": true
                  }
                },
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": `<${crashedArticle.url}|記事を開く>`
                  }
                },
                {
                  "type": "divider"
                },
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": ":warning: *タイムアウトからの自動復旧（スキップ登録）*\n前回の実行がこの記事の処理中にGASの実行時間制限等で強制終了したため、再発防止として自動的に履歴登録・スキップしました。"
                  }
                }
              ];
              UrlFetchApp.fetch(props.SLACK_WEBHOOK_URL, {
                method: 'post',
                contentType: 'application/json',
                payload: JSON.stringify({ blocks: recoveryBlocks }),
                muteHttpExceptions: true
              });
            } catch (notifyErr) {
              console.warn("クラッシュリカバリ通知のSlack送信に失敗しました: ", notifyErr);
            }
          }
        }
      } catch (parseErr) {
        console.warn("IN_PROGRESS_ARTICLE の解析に失敗しました: ", parseErr);
      } finally {
        if (typeof scriptProps.deleteProperty === 'function') {
          scriptProps.deleteProperty(IN_PROGRESS_ARTICLE_KEY);
        }
      }
    }
  }
  
  // 3. 新着記事の抽出 (最大3件)
  let newArticles = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const url = item.getChild('link', ns).getText();
    const title = item.getChild('title', ns).getText();
    
    if (!sentUrls.includes(url)) {
      newArticles.push({ url, title });
      if (newArticles.length >= MAX_ARTICLES_PER_RUN) break;
    }
  }
  
  if (newArticles.length === 0) return 0; // 新着記事なし
  
  // 4. 動的モデル一覧の取得 (上位最大3件: 最新Lite、最新標準、成熟下位標準)
  const MODEL_LIST = getAvailableGeminiModels(props.GEMINI_API_KEY);
  let activeModelList = [...MODEL_LIST];
  let geminiFatalError = false;
  // thinkingConfig 非対応・設定不可が判明したモデルを記録（2件目以降での無駄な400リトライ防止）
  const modelsWithoutThinkingConfig = {};

  // 5. 各記事の処理
  let processedCount = 0;
  for (let i = 0; i < newArticles.length; i++) {
    // 実行時間の安全監視: 2分00秒を超過している場合は残りの未着手記事を次回に回して正常終了
    if (Date.now() - startTime > MAX_ARTICLE_START_TIME_MS) {
      console.warn(`GAS実行制限時間の安全閾値（2分00秒）に達したため、残りの記事の処理を安全に終了します（処理済: ${processedCount}件）。未着手の記事は次回実行時に再処理されます。`);
      break;
    }

    const article = newArticles[i];
    const articleStartTime = Date.now();
    console.log(`[記事処理開始 ${i + 1}/${newArticles.length}] ${article.title} (${article.url}) - 累積経過時間: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    // Write-Ahead Log: 万が一この記事の処理中に6分タイムアウトで強制終了した場合に備え、処理中記事を記録
    if (scriptProps && typeof scriptProps.setProperty === 'function') {
      try {
        scriptProps.setProperty(IN_PROGRESS_ARTICLE_KEY, JSON.stringify({
          url: article.url,
          title: article.title,
          startedAt: new Date(articleStartTime).toISOString()
        }));
      } catch (propErr) {
        console.warn("IN_PROGRESS_ARTICLE の記録に失敗しました: ", propErr);
      }
    }
    
    try {
      // a. 記事本文のスクレイピング
      let textContent = "";
      let scrapeSkipped = false;
      let scrapeSkipReason = "";

      if (Date.now() - startTime > MAX_SCRAPE_TIME_MS) {
        scrapeSkipped = true;
        scrapeSkipReason = "実行時間の制限に近づいたため、記事本文の取得をスキップしました。";
        console.warn(`スクレイピング試行前に安全閾値（2分20秒）を超過したため、本文取得をスキップします: ${article.url}`);
      } else {
        const scrapeStart = Date.now();
        console.log(`[スクレイピング開始] ${article.url} - 累積経過時間: ${((scrapeStart - startTime) / 1000).toFixed(1)}s`);
        try {
          const pageRes = UrlFetchApp.fetch(article.url, {muteHttpExceptions: true});
          const responseCode = pageRes.getResponseCode();
          if (responseCode === 200) {
            const headers = typeof pageRes.getHeaders === 'function' ? pageRes.getHeaders() : null;
            const contentType = getHeaderCaseInsensitive(headers, 'content-type');
            if (!isHtmlOrTextContentType(contentType)) {
              scrapeSkipped = true;
              scrapeSkipReason = `HTML/テキスト以外のコンテンツ（Content-Type: ${contentType}）のため、要約をスキップしました。`;
              console.warn(`非テキストコンテンツのためスクレイピングスキップ (${contentType}): ${article.url}`);
            } else {
              const rawHtml = pageRes.getContentText();
              textContent = extractPlainTextFromHtml(rawHtml);
            }
          } else {
            // 200以外のステータスコード（ペイウォール、リダイレクト、複数ページ等）
            scrapeSkipped = true;
            scrapeSkipReason = `記事本文へのアクセスに失敗しました（HTTPステータス: ${responseCode}）。複数ページ構成やアクセス制限の可能性があります。`;
            console.warn("スクレイピングスキップ (" + responseCode + "): " + article.url);
          }
        } catch (e) {
          scrapeSkipped = true;
          scrapeSkipReason = "記事本文の取得中にエラーが発生しました。";
          console.warn("スクレイピング失敗: " + article.url, e);
        }
        console.log(`[スクレイピング完了] 所要時間: ${Date.now() - scrapeStart}ms, 取得文字数: ${textContent ? textContent.length : 0}文字`);
      }
      
      // テキストが取れなかった、または極端に短い場合もスキップ扱い
      const MIN_TEXT_LENGTH = 150;
      if (!scrapeSkipped && (!textContent || textContent.length < MIN_TEXT_LENGTH)) {
        scrapeSkipped = true;
        scrapeSkipReason = `記事本文のテキストを十分に抽出できませんでした（取得文字数: ${textContent ? textContent.length : 0}文字）。SPA（JavaScriptによる動的描画のサイト）や、Cloudflareなどのボット防御によってコンテンツ取得が遮断された可能性があります。`;
      }
      
      // スキップ時: Slack通知してスプレッドシートに保存し次の記事へ
      if (scrapeSkipped) {
        console.warn("記事をスキップします: " + article.url);
        const skipBlocks = [
          {
            "type": "header",
            "text": {
              "type": "plain_text",
              "text": article.title,
              "emoji": true
            }
          },
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": `<${article.url}|記事を開く>`
            }
          },
          {
            "type": "divider"
          },
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": `:warning: *要約スキップ*\n${scrapeSkipReason}`
            }
          }
        ];
        if (Date.now() - startTime <= MAX_SLACK_TIME_MS) {
          try {
            UrlFetchApp.fetch(props.SLACK_WEBHOOK_URL, {
              method: 'post',
              contentType: 'application/json',
              payload: JSON.stringify({ blocks: skipBlocks }),
              muteHttpExceptions: true
            });
          } catch (e) {
            console.error("スキップ通知のSlack送信失敗", e);
          }
        } else {
          console.warn(`スキップ通知送信前に安全閾値（4分00秒）を超過したため、Slack通知をスキップします: ${article.url}`);
        }
        // スキップ記事もスプレッドシートに保存してカウント
        sheet.insertRowBefore(1);
        sheet.getRange(1, 1).setValue(article.url);
        processedCount++;
        continue;
      }
      
      // b. Gemini APIによる要約
      let summary = "要約を取得できませんでした。";
      if (geminiFatalError) {
        summary = "Gemini APIが一時的に利用不可のため、要約処理をスキップしました。";
      } else {
        const geminiStart = Date.now();
        console.log(`[Gemini要約開始] 候補モデル: ${JSON.stringify(activeModelList)} - 累積経過時間: ${((geminiStart - startTime) / 1000).toFixed(1)}s`);
        let successfulModel = null;
        try {
          const baseContents = [{
            parts: [{ text: `以下の記事本文を日本語で要約してください。\n\n${textContent}` }]
          }];
          
          let succeeded = false;
          let geminiTimeExceeded = false;
          let had400Failure = false;
          let allFailedWith400 = true;
          for (let m = 0; m < activeModelList.length; m++) {
            const currentModel = activeModelList[m];
            let attempt = 1;
            const maxAttempts = 2;
            let delayMs = 1500;
            let shouldFallback = false;

            while (attempt <= maxAttempts) {
              // Gemini API呼び出し前の時間ガード（リトライやフォールバックで6分制限を超過するのを防ぐ）
              if (Date.now() - startTime > MAX_GEMINI_TIME_MS) {
                console.warn(`Gemini API試行中に制限時間の安全閾値（2分40秒）を超過したため、要約リトライ・フォールバックを中断します: ${article.url}`);
                geminiTimeExceeded = true;
                break;
              }
              const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${props.GEMINI_API_KEY}`;
              const useThinkingConfig = supportsThinkingBudgetZero(currentModel) && !modelsWithoutThinkingConfig[currentModel];
              const generationConfig = useThinkingConfig
                ? { maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } }
                : { maxOutputTokens: 2048 };
              const payload = {
                contents: baseContents,
                generationConfig: generationConfig
              };
              const attemptStart = Date.now();
              try {
                const geminiRes = UrlFetchApp.fetch(geminiUrl, {
                  method: 'post',
                  contentType: 'application/json',
                  payload: JSON.stringify(payload),
                  muteHttpExceptions: true
                });

                const attemptElapsedMs = Date.now() - attemptStart;
                const responseCode = geminiRes.getResponseCode();
                if (responseCode === 200) {
                  const geminiData = JSON.parse(geminiRes.getContentText());
                  if (geminiData.candidates && geminiData.candidates.length > 0) {
                    const candidate = geminiData.candidates[0];
                    if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                      summary = candidate.content.parts[0].text;
                      succeeded = true;
                      successfulModel = currentModel;
                      break;
                    } else if (candidate.finishReason) {
                      summary = `要約を取得できませんでした (理由: ${candidate.finishReason})`;
                      console.warn(`Gemini API 判定ブロック: ${candidate.finishReason} - URL: ${article.url}`);
                      succeeded = true; // ブロックはモデルの判定結果のためリトライ・フォールバック不要
                      successfulModel = currentModel;
                      break;
                    }
                  }
                } else if (responseCode === 429) {
                  // レートリミット（無料枠制限 / Quota Exceeded）
                  console.warn(`Gemini API レートリミット超過 (${responseCode}): `, geminiRes.getContentText());
                  geminiFatalError = true; // 1日の利用上限枯渇のため即座にサーキットブレーカー発動
                  break;
                } else if (responseCode === 503) {
                  // 一時的過負荷: 応答自体に時間がかかっていた場合は即座に次モデルへフォールバック
                  console.warn(`モデル ${currentModel} で一時的エラー (${responseCode}, 所要 ${attemptElapsedMs}ms) - 試行 ${attempt}/${maxAttempts}: `, geminiRes.getContentText());
                  if (attempt < maxAttempts && attemptElapsedMs < SLOW_ATTEMPT_FALLBACK_MS) {
                    Utilities.sleep(delayMs);
                    delayMs *= 2;
                    attempt++;
                  } else {
                    allFailedWith400 = false;
                    shouldFallback = true;
                    break;
                  }
                } else if (responseCode === 404) {
                  // モデルが存在しない / 廃止された: 次のモデルへフォールバック
                  console.warn(`モデル ${currentModel} が見つかりません (${responseCode}): `, geminiRes.getContentText());
                  allFailedWith400 = false;
                  shouldFallback = true;
                  break;
                } else if (responseCode === 400) {
                  const errBody = geminiRes.getContentText() || '';
                  if (isGeminiAuthOrKeyError(errBody)) {
                    // APIキー不正など全モデル共通の恒久エラーは即座にサーキットブレーカー発動
                    console.warn(`Gemini API 認証・キーエラー (${responseCode}): `, errBody);
                    geminiFatalError = true;
                    break;
                  }
                  if (useThinkingConfig) {
                    // thinkingConfig 付きで 400 が返った場合はエラー文言に依存せず除外して同一モデルで即時再試行
                    // （APIが汎用的な "Request contains an invalid argument." しか返さないケースに対応）
                    console.warn(`モデル ${currentModel} で thinkingConfig 付きリクエストが拒否されたため除外して再試行します (${responseCode}): `, errBody);
                    modelsWithoutThinkingConfig[currentModel] = true;
                    continue;
                  }
                  // thinkingConfig なしでも 400 の場合はモデル固有の非互換の可能性があるため次候補へフォールバック
                  console.warn(`モデル ${currentModel} でリクエストエラー (${responseCode}): `, errBody);
                  had400Failure = true;
                  shouldFallback = true;
                  break;
                } else {
                  console.warn(`Gemini API 恒常的エラー (${responseCode}): `, geminiRes.getContentText());
                  geminiFatalError = true;
                  break;
                }
              } catch (e) {
                const attemptElapsedMs = Date.now() - attemptStart;
                console.warn(`モデル ${currentModel} 接続エラー (所要 ${attemptElapsedMs}ms) - 試行 ${attempt}/${maxAttempts}: ` + article.url, e);
                if (attempt < maxAttempts && attemptElapsedMs < SLOW_ATTEMPT_FALLBACK_MS) {
                  Utilities.sleep(delayMs);
                  delayMs *= 2;
                  attempt++;
                } else {
                  allFailedWith400 = false;
                  shouldFallback = true;
                  break;
                }
              }
            }

            if (succeeded || geminiFatalError || geminiTimeExceeded) {
              break;
            }

            if (shouldFallback && m < activeModelList.length - 1) {
              console.warn(`モデル ${currentModel} から次候補モデル ${activeModelList[m + 1]} へフォールバックします。`);
            }
          }

          // 全候補モデルが 400 エラーで失敗した場合は恒常的リクエスト異常とみなしてサーキットブレーカー発動
          if (!succeeded && !geminiFatalError && !geminiTimeExceeded && had400Failure && allFailedWith400) {
            console.warn(`利用可能な全モデルで HTTP 400 エラーが発生したため、サーキットブレーカーを作動させます: ${article.url}`);
            geminiFatalError = true;
          }

          // 成功したモデルがあれば、次回記事で優先利用（先頭に配置）
          if (successfulModel && activeModelList[0] !== successfulModel) {
            activeModelList = [successfulModel, ...activeModelList.filter(m => m !== successfulModel)];
          }

          if (!succeeded && !geminiFatalError) {
            if (geminiTimeExceeded) {
              summary = "実行時間の制限に近づいたため、この記事の要約処理をスキップしました。";
            } else {
              console.warn(`この記事 (${article.url}) では利用可能な全モデルで一時的過負荷等のため要約を取得できませんでした。次の記事の処理を継続します。`);
              summary = "一時的なサーバー混雑等のため、この記事の要約を取得できませんでした。";
            }
          }
        } catch (e) {
          console.warn("Gemini API要約処理プロセス全体で例外が発生しました: " + article.url, e);
        }
        console.log(`[Gemini要約完了] モデル: ${successfulModel || 'なし'}, 所要時間: ${Date.now() - geminiStart}ms`);
      }
      
      // c. はてなブックマーク JSONLite API でブコメ取得
      let commentsText = "";
      if (Date.now() - startTime > MAX_HATENA_TIME_MS) {
        console.warn(`ブコメ取得前に安全閾値（3分30秒）を超過したため、コメント取得をスキップします: ${article.url}`);
        commentsText = "実行時間の制限に近づいたため、コメント取得をスキップしました。";
      } else {
        const bApiStart = Date.now();
        console.log(`[ブコメ取得開始] ${article.url} - 累積経過時間: ${((bApiStart - startTime) / 1000).toFixed(1)}s`);
        try {
          const bApiUrl = `https://b.hatena.ne.jp/entry/jsonlite/?url=${encodeURIComponent(article.url)}`;
          const bRes = UrlFetchApp.fetch(bApiUrl, {muteHttpExceptions: true});
          if (bRes.getResponseCode() === 200) {
            const bData = JSON.parse(bRes.getContentText());
            if (bData && bData.bookmarks) {
              // コメントが空でないものを最大10件抽出
              const comments = bData.bookmarks.filter(b => b.comment.trim() !== "").slice(0, 10);
              if (comments.length > 0) {
                commentsText = comments.map(c => `• *${c.user}*: ${c.comment}`).join('\n');
              } else {
                commentsText = "コメントはまだありません。";
              }
            }
          }
        } catch (e) {
          console.warn("はてなブコメ取得失敗: " + article.url, e);
          commentsText = "コメントの取得に失敗しました。";
        }
        console.log(`[ブコメ取得完了] 所要時間: ${Date.now() - bApiStart}ms`);
      }
      if (!commentsText) commentsText = "コメントはまだありません。";
      
      // d. Slack Block Kit メッセージの構築
      const blocks = [
        {
          "type": "header",
          "text": {
            "type": "plain_text",
            "text": article.title.substring(0, 150),
            "emoji": true
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `<${article.url}|記事を開く>`
          }
        },
        {
          "type": "divider"
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*✨ AI 要約*\n${summary}`
          }
        },
        {
          "type": "divider"
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*💬 新着ブコメ*\n${commentsText}`
          }
        }
      ];
      
      // e. Slackへの送信
      if (Date.now() - startTime > MAX_SLACK_TIME_MS) {
        console.warn(`Slack通知送信前に安全閾値（4分00秒）を超過したため、Slack通知をスキップします: ${article.url}`);
      } else {
        const slackStart = Date.now();
        console.log(`[Slack送信開始] ${article.url} - 累積経過時間: ${((slackStart - startTime) / 1000).toFixed(1)}s`);
        try {
          UrlFetchApp.fetch(props.SLACK_WEBHOOK_URL, {
            method: 'post',
            contentType: 'application/json',
            payload: JSON.stringify({ blocks: blocks }),
            muteHttpExceptions: true
          });
        } catch (e) {
          console.error("Slack通知失敗", e);
        }
        console.log(`[Slack送信完了] 所要時間: ${Date.now() - slackStart}ms`);
      }
      
      // f. スプレッドシートに送信済URLを保存 (先頭に挿入)
      sheet.insertRowBefore(1);
      sheet.getRange(1, 1).setValue(article.url);

      processedCount++;
      console.log(`[記事処理完了 ${i + 1}/${newArticles.length}] 所要時間: ${Date.now() - articleStartTime}ms, 累積経過時間: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    } catch (err) {
      console.error("記事の処理中に重大なエラーが発生しました (" + article.url + "): ", err);
      // 再試行ループ防止: 重大なエラーが発生した記事もスプレッドシートに記録して翌日のスタックを防止
      try {
        sheet.insertRowBefore(1);
        sheet.getRange(1, 1).setValue(article.url);
      } catch (sheetErr) {
        console.error("エラー記事の履歴保存に失敗しました: " + article.url, sheetErr);
      }
    } finally {
      // 処理完了（または例外捕捉済）のため Write-Ahead Log を確実にクリア
      if (scriptProps && typeof scriptProps.deleteProperty === 'function') {
        try {
          scriptProps.deleteProperty(IN_PROGRESS_ARTICLE_KEY);
        } catch (propErr) {
          console.warn("IN_PROGRESS_ARTICLE の削除に失敗しました: ", propErr);
        }
      }
      // 次の記事が存在し、かつ時間余裕がある場合のみレートリミット対策の待機を行う
      if (i < newArticles.length - 1 && Date.now() - startTime <= MAX_ARTICLE_START_TIME_MS) {
        Utilities.sleep(2500);
      }
    }
  }
  
  // 100件を超える古い履歴の削除
  const newLastRow = sheet.getLastRow();
  if (newLastRow > 100) {
    sheet.deleteRows(101, newLastRow - 100);
  }
  
  return processedCount;
}

// ----------------------------------------------------
// GASエラー通知メール監視 & GitHub Issue 自動起票
// ----------------------------------------------------

const GAS_FAILURE_SENDER = 'noreply-apps-scripts-notifications@google.com';
const REPORTED_GAS_FAILURE_MSG_IDS_KEY = 'REPORTED_GAS_FAILURE_MSG_IDS';
const MAX_REPORTED_GAS_FAILURE_MSG_IDS = 100;

/**
 * GASエラー通知メールの件名からプロジェクト名を抽出する
 * 例: "Summary of failures for Google Apps Script: ai-hatebu-digest" -> "ai-hatebu-digest"
 * @param {string} subject
 * @returns {string}
 */
function extractProjectNameFromFailureSubject(subject) {
  if (!subject || typeof subject !== 'string') return '';
  const colonIdx = Math.max(subject.indexOf(':'), subject.indexOf('：'));
  if (colonIdx !== -1) {
    return subject.substring(colonIdx + 1).trim();
  }
  return subject.trim();
}

/**
 * 抽出されたプロジェクト名が監視対象フィルタに一致するか判定する
 * フィルタが空または '*' の場合は全プロジェクトを対象とする
 * @param {string} projectName
 * @param {string} filterStr - カンマ区切りのプロジェクト名リスト
 * @returns {boolean}
 */
function matchesGasFailureProjectFilter(projectName, filterStr) {
  if (!filterStr || typeof filterStr !== 'string') return true;
  const trimmed = filterStr.trim();
  if (!trimmed || trimmed === '*') return true;
  const targets = trimmed
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0);
  if (targets.length === 0) return true;
  const normalizedName = String(projectName || '').trim().toLowerCase();
  return targets.includes(normalizedName);
}

/**
 * 基本的なHTMLエンティティをデコードし空白を正規化する
 * @param {string} text
 * @returns {string}
 */
function decodeBasicHtmlEntities(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * GASエラー通知メールを解析してプロジェクト名とエラー明細一覧を抽出する
 * HTMLテーブル構造が変わった場合でもプレーンテキスト抜粋へ安全にフォールバックする
 * @param {string} subject
 * @param {string} htmlBody
 * @param {string} plainBody
 * @returns {{ projectName: string, entries: Array<{start: string, func: string, errorMessage: string, trigger: string, end: string}>, rawExcerpt: string }}
 */
function parseGasFailureEmail(subject, htmlBody, plainBody) {
  const projectName = extractProjectNameFromFailureSubject(subject);
  const entries = [];

  if (htmlBody && typeof htmlBody === 'string') {
    const safeHtml = htmlBody.length > 100000 ? htmlBody.substring(0, 100000) : htmlBody;
    const rowMatches = safeHtml.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (let i = 0; i < rowMatches.length; i++) {
      const rowHtml = rowMatches[i];
      const cellMatches = rowHtml.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi);
      if (!cellMatches || cellMatches.length < 5) continue;
      const cells = cellMatches.map(cell => {
        const stripped = cell.replace(/<[^>]*>/g, ' ');
        return decodeBasicHtmlEntities(stripped);
      });
      // ヘッダー行が <td> で構成されている場合の安全除外
      if (cells[0].toLowerCase() === 'start' && cells[1].toLowerCase() === 'function') {
        continue;
      }
      entries.push({
        start: cells[0],
        func: cells[1],
        errorMessage: cells[2],
        trigger: cells[3],
        end: cells[4]
      });
    }
  }

  let rawExcerpt = '';
  if (entries.length === 0) {
    const fallbackText = (plainBody && typeof plainBody === 'string' && plainBody.trim())
      ? plainBody.trim()
      : extractPlainTextFromHtml(htmlBody || '', 50000, 1500);
    rawExcerpt = fallbackText.substring(0, 1500);
  }

  return { projectName, entries, rawExcerpt };
}

/**
 * Markdownテーブルのセル内文字列を安全にエスケープする
 * @param {string} value
 * @returns {string}
 */
function escapeMarkdownTableCell(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * 解析済みのGASエラー通知情報から GitHub Issue 作成用ペイロードを構築する
 * @param {{ projectName: string, entries: Array, rawExcerpt: string }} parsed
 * @param {string} receivedDateStr
 * @param {string} [labelsStr='']
 * @returns {{ title: string, body: string, labels?: string[] }}
 */
function buildGasFailureIssuePayload(parsed, receivedDateStr, labelsStr) {
  let title = '';
  if (parsed.entries && parsed.entries.length > 0) {
    const first = parsed.entries[0];
    const cleanErr = String(first.errorMessage || 'Error').replace(/\s+/g, ' ').trim();
    const shortErr = cleanErr.length > 60 ? cleanErr.substring(0, 57) + '...' : cleanErr;
    const moreSuffix = parsed.entries.length > 1 ? ` 他${parsed.entries.length - 1}件` : '';
    const startPart = first.start ? ` (${first.start})` : '';
    title = `[GAS Error] ${first.func || 'unknown'}: ${shortErr}${moreSuffix}${startPart}`;
  } else {
    title = `[GAS Error] ${parsed.projectName || 'Google Apps Script'} でエラー発生 (${receivedDateStr})`;
  }
  if (title.length > 150) {
    title = title.substring(0, 147) + '...';
  }

  const lines = [
    '## 発生概要',
    '',
    `- **GASプロジェクト**: ${parsed.projectName || '(不明)'}`,
    `- **通知メール受信日時**: ${receivedDateStr}`,
    `- **検出エラー件数**: ${parsed.entries ? parsed.entries.length : 0}件`,
    ''
  ];

  if (parsed.entries && parsed.entries.length > 0) {
    lines.push('## エラー詳細', '');
    lines.push('| Start | Function | Error Message | Trigger | End |');
    lines.push('| :--- | :--- | :--- | :--- | :--- |');
    for (let i = 0; i < parsed.entries.length; i++) {
      const e = parsed.entries[i];
      lines.push(
        `| ${escapeMarkdownTableCell(e.start)} | \`${escapeMarkdownTableCell(e.func)}\` | ${escapeMarkdownTableCell(e.errorMessage)} | ${escapeMarkdownTableCell(e.trigger)} | ${escapeMarkdownTableCell(e.end)} |`
      );
    }
    lines.push('');
  } else if (parsed.rawExcerpt) {
    lines.push('## メール本文（抜粋）', '');
    lines.push('```text');
    lines.push(parsed.rawExcerpt);
    lines.push('```', '');
  }

  lines.push('---');
  lines.push('*本Issueは `watchGasFailureEmails` により GAS エラー通知メールから自動起票されました。*');

  const payload = {
    title: title,
    body: lines.join('\n')
  };

  if (labelsStr && typeof labelsStr === 'string') {
    const labels = labelsStr
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (labels.length > 0) {
      payload.labels = labels;
    }
  }

  return payload;
}

/**
 * GitHub REST API を呼び出して Issue を作成する
 * @param {string} repo - "owner/repo" 形式
 * @param {string} token - GitHub Personal Access Token
 * @param {{ title: string, body: string, labels?: string[] }} issuePayload
 * @returns {{ ok: boolean, number?: number, htmlUrl?: string, statusCode?: number, error?: string }}
 */
function createGitHubIssue(repo, token, issuePayload) {
  const url = `https://api.github.com/repos/${repo}/issues`;
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ai-hatebu-digest-gas'
    },
    payload: JSON.stringify(issuePayload),
    muteHttpExceptions: true
  });

  const statusCode = res.getResponseCode();
  const bodyText = res.getContentText() || '';
  if (statusCode === 201 || statusCode === 200) {
    const data = JSON.parse(bodyText);
    return {
      ok: true,
      number: data.number,
      htmlUrl: data.html_url
    };
  }
  return {
    ok: false,
    statusCode: statusCode,
    error: bodyText
  };
}

/**
 * 自動起票した GitHub Issue のリンクを Slack へ通知する
 * @param {string} webhookUrl
 * @param {{ projectName: string, entries: Array }} parsed
 * @param {{ number: number, htmlUrl: string }} issueResult
 * @param {string} receivedDateStr
 */
function notifyGasFailureIssueToSlack(webhookUrl, parsed, issueResult, receivedDateStr) {
  if (!webhookUrl) return;
  const first = (parsed.entries && parsed.entries.length > 0) ? parsed.entries[0] : null;
  const summaryLines = [
    `*プロジェクト*: ${parsed.projectName || '(不明)'}`,
    `*メール受信日時*: ${receivedDateStr}`
  ];
  if (first) {
    summaryLines.push(`*関数*: \`${first.func}\``);
    summaryLines.push(`*エラー*: ${first.errorMessage}`);
    if (first.start) {
      summaryLines.push(`*発生時刻*: ${first.start}`);
    }
  }
  summaryLines.push(`*GitHub Issue*: <${issueResult.htmlUrl}|#${issueResult.number} を開く>`);

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🚨 GASエラー検知・GitHub Issue自動起票',
        emoji: true
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: summaryLines.join('\n')
      }
    }
  ];

  try {
    UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ blocks: blocks }),
      muteHttpExceptions: true
    });
  } catch (err) {
    console.warn('GASエラー自動起票のSlack通知に失敗しました: ', err);
  }
}

/**
 * 処理済みメッセージID一覧を ScriptProperties から読み込む
 * @param {Object} scriptProps
 * @returns {string[]}
 */
function loadReportedGasFailureMessageIds(scriptProps) {
  if (!scriptProps || typeof scriptProps.getProperty !== 'function') return [];
  const raw = scriptProps.getProperty(REPORTED_GAS_FAILURE_MSG_IDS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (e) {
    console.warn('REPORTED_GAS_FAILURE_MSG_IDS の解析に失敗しました: ', e);
    return [];
  }
}

/**
 * 処理済みメッセージID一覧を上限件数内で ScriptProperties へ保存する
 * @param {Object} scriptProps
 * @param {string[]} ids
 */
function saveReportedGasFailureMessageIds(scriptProps, ids) {
  if (!scriptProps || typeof scriptProps.setProperty !== 'function') return;
  const trimmed = ids.slice(-MAX_REPORTED_GAS_FAILURE_MSG_IDS);
  scriptProps.setProperty(REPORTED_GAS_FAILURE_MSG_IDS_KEY, JSON.stringify(trimmed));
}

/**
 * 指定名のGmailラベルを取得し、存在しなければ作成する
 * @param {string} labelName
 * @returns {Object|null}
 */
function getOrCreateGmailLabel(labelName) {
  if (!labelName || typeof GmailApp === 'undefined') return null;
  try {
    return GmailApp.getUserLabelByName(labelName) || GmailApp.createLabel(labelName);
  } catch (err) {
    console.warn(`Gmailラベル (${labelName}) の取得・作成に失敗しました: `, err);
    return null;
  }
}

/**
 * Gmail の GAS エラー通知メールを監視し、未処理のものを GitHub Issue として自動起票する
 * 重複起票防止はメッセージIDの永続化（ScriptProperties）で行い、可視化のために Gmail ラベルも付与する
 * （Gmail のスレッドまとめ機能が有効でも翌日の新規メッセージを取りこぼさない設計）
 * @returns {{ checkedThreads: number, createdIssues: number, skippedCount: number }}
 */
function processGasFailureEmails() {
  const props = getProperties();
  if (!props.GITHUB_TOKEN) {
    console.warn('[GASエラー監視] GITHUB_TOKEN が未設定のため、Issue自動起票をスキップします。');
    return { checkedThreads: 0, createdIssues: 0, skippedCount: 0 };
  }
  if (typeof GmailApp === 'undefined') {
    console.warn('[GASエラー監視] GmailApp が利用できない環境のためスキップします。');
    return { checkedThreads: 0, createdIssues: 0, skippedCount: 0 };
  }

  const scriptProps = PropertiesService.getScriptProperties();
  const reportedIds = loadReportedGasFailureMessageIds(scriptProps);
  const query = `from:${GAS_FAILURE_SENDER} newer_than:14d`;
  const threads = GmailApp.search(query, 0, 20);

  let createdIssues = 0;
  let skippedCount = 0;
  let processedLabel = null;

  for (let t = 0; t < threads.length; t++) {
    const thread = threads[t];
    const messages = thread.getMessages();
    let hasMatchedTarget = false;
    let allMatchedSucceeded = true;

    for (let m = 0; m < messages.length; m++) {
      const msg = messages[m];
      const from = typeof msg.getFrom === 'function' ? String(msg.getFrom() || '') : '';
      if (!from.toLowerCase().includes(GAS_FAILURE_SENDER)) {
        continue;
      }

      const msgId = String(msg.getId());
      if (reportedIds.includes(msgId)) {
        skippedCount++;
        continue;
      }

      const subject = msg.getSubject() || '';
      const htmlBody = typeof msg.getBody === 'function' ? (msg.getBody() || '') : '';
      const plainBody = typeof msg.getPlainBody === 'function' ? (msg.getPlainBody() || '') : '';
      const parsed = parseGasFailureEmail(subject, htmlBody, plainBody);

      if (!matchesGasFailureProjectFilter(parsed.projectName, props.GAS_FAILURE_PROJECT_FILTER)) {
        skippedCount++;
        continue;
      }

      hasMatchedTarget = true;
      const msgDate = typeof msg.getDate === 'function' && msg.getDate() ? msg.getDate() : new Date();
      const receivedDateStr = msgDate instanceof Date ? msgDate.toISOString() : String(msgDate);
      const issuePayload = buildGasFailureIssuePayload(parsed, receivedDateStr, props.GITHUB_ISSUE_LABELS);

      const issueResult = createGitHubIssue(props.GITHUB_REPO, props.GITHUB_TOKEN, issuePayload);
      if (issueResult.ok) {
        console.log(`[GASエラー監視] GitHub Issue を自動起票しました: #${issueResult.number} (${issueResult.htmlUrl})`);
        createdIssues++;
        reportedIds.push(msgId);
        saveReportedGasFailureMessageIds(scriptProps, reportedIds);
        notifyGasFailureIssueToSlack(props.SLACK_WEBHOOK_URL, parsed, issueResult, receivedDateStr);
      } else {
        console.error(`[GASエラー監視] GitHub Issue の作成に失敗しました (HTTP ${issueResult.statusCode}): `, issueResult.error);
        allMatchedSucceeded = false;
      }
    }

    if (hasMatchedTarget && allMatchedSucceeded) {
      if (!processedLabel) {
        processedLabel = getOrCreateGmailLabel(props.GAS_FAILURE_PROCESSED_LABEL);
      }
      if (processedLabel && typeof thread.addLabel === 'function') {
        try {
          thread.addLabel(processedLabel);
        } catch (labelErr) {
          console.warn('処理済みGmailラベルの付与に失敗しました: ', labelErr);
        }
      }
    }
  }

  return {
    checkedThreads: threads.length,
    createdIssues: createdIssues,
    skippedCount: skippedCount
  };
}

/**
 * 時間主導型トリガー用: GASエラー通知メール監視のエントリーポイント
 */
function watchGasFailureEmails() {
  try {
    return processGasFailureEmails();
  } catch (err) {
    console.error('GASエラー通知メール監視中に予期せぬエラーが発生しました: ', err);
  }
}

// ----------------------------------------------------
// テストおよびデバッグ用ユーティリティ
// ----------------------------------------------------

function testFetchRSS() {
  const props = getProperties();
  const rssUrl = props.HATENA_RSS_URL || 'https://b.hatena.ne.jp/hotentry/it.rss';
  const response = UrlFetchApp.fetch(rssUrl);
  const xml = response.getContentText();
  const document = XmlService.parse(xml);
  const root = document.getRootElement();
  const ns = XmlService.getNamespace('http://purl.org/rss/1.0/');
  const items = root.getChildren('item', ns);
  console.log(`取得件数: ${items.length} 件`);
  if (items.length > 0) {
    console.log("最初の記事タイトル: " + items[0].getChild('title', ns).getText());
  }
}

function testSlackNotification() {
  const props = getProperties();
  if (!props.SLACK_WEBHOOK_URL) {
    console.error("SLACK_WEBHOOK_URL が設定されていません");
    return;
  }
  const blocks = [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "テスト通知",
        "emoji": true
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "これは GAS からの Slack Block Kit テスト通知です。"
      }
    }
  ];
  UrlFetchApp.fetch(props.SLACK_WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ blocks: blocks })
  });
  console.log("Slack にテスト通知を送信しました。");
}

function runDiagnostics() {
  const props = getProperties();
  console.log("=== GAS環境情報の診断 ===");
  console.log("SLACK_WEBHOOK_URL: " + (props.SLACK_WEBHOOK_URL ? "設定あり" : "未設定"));
  console.log("GEMINI_API_KEY: " + (props.GEMINI_API_KEY ? "設定あり (長さ: " + props.GEMINI_API_KEY.length + ")" : "未設定"));
  console.log("HATENA_RSS_URL: " + props.HATENA_RSS_URL);
  
  if (!props.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY が設定されていません。スクリプトプロパティを確認してください。");
    return;
  }
  
  console.log("\n=== 1. RSSフィードの取得テスト ===");
  let items = [];
  try {
    const rssRes = UrlFetchApp.fetch(props.HATENA_RSS_URL);
    console.log("RSS取得ステータス: " + rssRes.getResponseCode());
    const xml = rssRes.getContentText();
    const document = XmlService.parse(xml);
    const root = document.getRootElement();
    const ns = XmlService.getNamespace('http://purl.org/rss/1.0/');
    items = root.getChildren('item', ns);
    console.log("RSS内の記事数: " + items.length + " 件");
  } catch (e) {
    console.error("RSSの取得または解析に失敗しました: ", e);
    return;
  }
  
  if (items.length === 0) {
    console.warn("RSS内の記事が見つかりませんでした。");
    return;
  }

  console.log("\n=== 2. Gemini 利用可能モデルの動的取得テスト ===");
  const availableModels = getAvailableGeminiModels(props.GEMINI_API_KEY);
  console.log("利用可能モデル候補: ", JSON.stringify(availableModels));
  
  console.log("\n=== 3. 記事の取得・スクレイピング・Gemini APIテスト (先頭3件) ===");
  const testCount = Math.min(items.length, 3);
  const ns = XmlService.getNamespace('http://purl.org/rss/1.0/');
  
  for (let i = 0; i < testCount; i++) {
    const item = items[i];
    const url = item.getChild('link', ns).getText();
    const title = item.getChild('title', ns).getText();
    console.log(`\n--- テスト記事 [${i+1}] ---`);
    console.log("タイトル: " + title);
    console.log("URL: " + url);
    
    // a. スクレイピングテスト
    let textContent = "";
    try {
      const pageRes = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
      const responseCode = pageRes.getResponseCode();
      console.log("HTTPステータスコード: " + responseCode);
      if (responseCode === 200) {
        const rawHtml = pageRes.getContentText();
        console.log("元HTML文字数: " + rawHtml.length + "文字");
        
        // クレンジング処理（本番と同一の安全ロジック）
        textContent = extractPlainTextFromHtml(rawHtml);
        console.log("クレンジング後文字数: " + textContent.length + "文字");
        if (textContent.length > 0) {
          console.log("テキストサンプル: " + textContent.substring(0, 150) + "...");
        } else {
          console.warn("警告: クレンジング後のテキストが空です。");
        }
      } else {
        console.warn(`警告: HTTP ${responseCode} のためスクレイピングはスキップ対象になります。`);
      }
    } catch (e) {
      console.error("スクレイピング中に例外が発生しました: ", e);
    }
    
    // b. Gemini APIテスト
    if (textContent) {
      console.log("Gemini APIへのリクエストを送信します...");
      
      for (let m = 0; m < availableModels.length; m++) {
        const currentModel = availableModels[m];
        console.log(`モデル ${currentModel} でのテスト試行...`);
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${props.GEMINI_API_KEY}`;
        const payload = {
          contents: [{
            parts: [{ text: `以下の記事本文を日本語で要約してください。\n\n${textContent}` }]
          }]
        };
        
        try {
          const geminiRes = UrlFetchApp.fetch(geminiUrl, {
            method: 'post',
            contentType: 'application/json',
            payload: JSON.stringify(payload),
            muteHttpExceptions: true
          });
          const responseCode = geminiRes.getResponseCode();
          console.log(`  レスポンスコード: ${responseCode}`);
          const resText = geminiRes.getContentText();
          
          if (responseCode === 200) {
            const geminiData = JSON.parse(resText);
            if (geminiData.candidates && geminiData.candidates.length > 0) {
              const candidate = geminiData.candidates[0];
              if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                console.log("  要約成功！内容: " + candidate.content.parts[0].text.substring(0, 150) + "...");
                break; // 成功したらこの記事のテストは完了
              } else {
                console.warn("  警告: content/parts がありません。finishReason: " + candidate.finishReason);
              }
            } else {
              console.warn("  警告: candidates が空です。");
            }
          } else {
            console.warn(`  エラーレスポンス: ${resText.substring(0, 300)}`);
          }
        } catch (e) {
          console.error("  例外発生: ", e);
        }
      }
    } else {
      console.log("本文がないため Gemini API テストはスキップします。");
    }
    
    Utilities.sleep(1000); // テスト間のウェイト
  }
  console.log("\n=== 診断終了 ===");
}

// ----------------------------------------------------
// Jest テスト用エクスポート (GAS本番環境では無視される)
// ----------------------------------------------------
if (typeof module !== 'undefined') {
  module.exports = {
    getProperties,
    doGet,
    checkToken,
    runCron,
    getAvailableGeminiModels,
    supportsThinkingBudgetZero,
    isGeminiAuthOrKeyError,
    extractPlainTextFromHtml,
    isHtmlOrTextContentType,
    syncAndNotify,
    extractProjectNameFromFailureSubject,
    matchesGasFailureProjectFilter,
    parseGasFailureEmail,
    buildGasFailureIssuePayload,
    createGitHubIssue,
    processGasFailureEmails,
    watchGasFailureEmails,
    runDiagnostics
  };
}

