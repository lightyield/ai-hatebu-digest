// プロパティ取得用ヘルパー
function getProperties() {
  const props = PropertiesService.getScriptProperties().getProperties();
  return {
    GEMINI_API_KEY: props.GEMINI_API_KEY,
    SLACK_WEBHOOK_URL: props.SLACK_WEBHOOK_URL,
    APP_SECRET: props.APP_SECRET,
    HATENA_RSS_URL: props.HATENA_RSS_URL || 'https://b.hatena.ne.jp/hotentry/it.rss'
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
              const useThinkingConfig = !modelsWithoutThinkingConfig[currentModel];
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
                    shouldFallback = true;
                    break;
                  }
                } else if (responseCode === 404) {
                  // モデルが存在しない / 廃止された: 次のモデルへフォールバック
                  console.warn(`モデル ${currentModel} が見つかりません (${responseCode}): `, geminiRes.getContentText());
                  shouldFallback = true;
                  break;
                } else if (responseCode === 400) {
                  const errBody = geminiRes.getContentText() || '';
                  if (useThinkingConfig && errBody.toLowerCase().includes('thinking')) {
                    // thinkingConfig 非対応・設定不可モデルの場合は thinkingConfig を除外して即時再試行
                    console.warn(`モデル ${currentModel} で thinkingConfig が非対応のため除外して再試行します (${responseCode}): `, errBody);
                    modelsWithoutThinkingConfig[currentModel] = true;
                    continue;
                  }
                  // 不正なリクエスト / APIキー不正等
                  console.warn(`Gemini API リクエストエラー (${responseCode}): `, errBody);
                  geminiFatalError = true;
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
    extractPlainTextFromHtml,
    isHtmlOrTextContentType,
    syncAndNotify,
    runDiagnostics
  };
}

