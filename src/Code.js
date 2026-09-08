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
  const DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
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
      // -lite は標準版の後に配置
      const isLiteA = a.includes('lite');
      const isLiteB = b.includes('lite');
      if (isLiteA !== isLiteB) {
        return isLiteA ? 1 : -1;
      }
      return a.localeCompare(b);
    };

    flashModels.sort(sortFn);
    otherModels.sort(sortFn);

    const result = [...flashModels, ...otherModels];
    if (result.length > 0) {
      return result;
    }

    return DEFAULT_MODELS;
  } catch (e) {
    console.warn("Geminiモデル一覧取得中に例外が発生しました: ", e);
    return DEFAULT_MODELS;
  }
}

function syncAndNotify() {
  const props = getProperties();
  const rssUrl = props.HATENA_RSS_URL;
  
  // 1. RSSの取得
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
  
  // 3. 新着記事の抽出 (最大5件)
  let newArticles = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const url = item.getChild('link', ns).getText();
    const title = item.getChild('title', ns).getText();
    
    if (!sentUrls.includes(url)) {
      newArticles.push({ url, title });
      if (newArticles.length >= 5) break;
    }
  }
  
  if (newArticles.length === 0) return 0; // 新着記事なし
  
  // 4. 動的モデル一覧の取得
  const MODEL_LIST = getAvailableGeminiModels(props.GEMINI_API_KEY);
  let geminiServiceUnavailable = false;

  // 5. 各記事の処理
  let processedCount = 0;
  for (let i = 0; i < newArticles.length; i++) {
    const article = newArticles[i];
    
    try {
      // a. 記事本文のスクレイピング
      let textContent = "";
      let scrapeSkipped = false;
      let scrapeSkipReason = "";
      try {
        const pageRes = UrlFetchApp.fetch(article.url, {muteHttpExceptions: true});
        const responseCode = pageRes.getResponseCode();
        if (responseCode === 200) {
          let html = pageRes.getContentText();
          // script, style タグ of 除去 and プレーンテキスト of 抽出
          html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
          html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
          html = html.replace(/<[^>]+>/g, ' '); // HTMLタグを除去
          html = html.replace(/\s+/g, ' ').trim(); // 空白を正規化
          
          textContent = html.substring(0, 8000); // 制限を設ける
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
        // スキップ記事もスプレッドシートに保存してカウント
        sheet.insertRowBefore(1);
        sheet.getRange(1, 1).setValue(article.url);
        processedCount++;
        continue;
      }
      
      // b. Gemini APIによる要約
      let summary = "要約を取得できませんでした。";
      if (geminiServiceUnavailable) {
        summary = "Gemini APIが一時的に利用不可のため、要約処理をスキップしました。";
      } else {
        try {
          const payload = {
            contents: [{
              parts: [{ text: `以下の記事本文を日本語で要約してください。\n\n${textContent}` }]
            }]
          };
          
          let succeeded = false;
          for (let m = 0; m < MODEL_LIST.length; m++) {
            const currentModel = MODEL_LIST[m];
            let attempt = 1;
            const maxAttempts = 2;
            let delayMs = 1500;
            let shouldFallback = false;

            while (attempt <= maxAttempts) {
              const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${props.GEMINI_API_KEY}`;
              try {
                const geminiRes = UrlFetchApp.fetch(geminiUrl, {
                  method: 'post',
                  contentType: 'application/json',
                  payload: JSON.stringify(payload),
                  muteHttpExceptions: true
                });

                const responseCode = geminiRes.getResponseCode();
                if (responseCode === 200) {
                  const geminiData = JSON.parse(geminiRes.getContentText());
                  if (geminiData.candidates && geminiData.candidates.length > 0) {
                    const candidate = geminiData.candidates[0];
                    if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                      summary = candidate.content.parts[0].text;
                      succeeded = true;
                      break;
                    } else if (candidate.finishReason) {
                      summary = `要約を取得できませんでした (理由: ${candidate.finishReason})`;
                      console.warn(`Gemini API 判定ブロック: ${candidate.finishReason} - URL: ${article.url}`);
                      succeeded = true; // ブロックはモデルの判定結果のためリトライ・フォールバック不要
                      break;
                    }
                  }
                } else if (responseCode === 429 || responseCode === 503) {
                  console.warn(`モデル ${currentModel} で一時的エラー (${responseCode}) - 試行 ${attempt}/${maxAttempts}: `, geminiRes.getContentText());
                  if (attempt < maxAttempts) {
                    Utilities.sleep(delayMs);
                    delayMs *= 2;
                    attempt++;
                  } else {
                    shouldFallback = true;
                    break;
                  }
                } else if (responseCode === 404 || responseCode === 400) {
                  console.warn(`モデル ${currentModel} でエラー (${responseCode}): `, geminiRes.getContentText());
                  shouldFallback = true;
                  break;
                } else {
                  console.warn(`Gemini API 恒常的エラー (${responseCode}): `, geminiRes.getContentText());
                  geminiServiceUnavailable = true;
                  break;
                }
              } catch (e) {
                console.warn(`モデル ${currentModel} 接続エラー - 試行 ${attempt}/${maxAttempts}: ` + article.url, e);
                if (attempt < maxAttempts) {
                  Utilities.sleep(delayMs);
                  delayMs *= 2;
                  attempt++;
                } else {
                  shouldFallback = true;
                  break;
                }
              }
            }

            if (succeeded || geminiServiceUnavailable) {
              break;
            }

            if (shouldFallback && m < MODEL_LIST.length - 1) {
              console.warn(`モデル ${currentModel} から次候補モデル ${MODEL_LIST[m + 1]} へフォールバックします。`);
            }
          }

          if (!succeeded && !geminiServiceUnavailable) {
            console.warn("すべてのGeminiモデル候補で要約生成に失敗しました。以降の記事のAPI呼び出しを一時停止します。");
            geminiServiceUnavailable = true;
          }
        } catch (e) {
          console.warn("Gemini API要約処理プロセス全体で例外が発生しました: " + article.url, e);
        }
      }
      
      // c. はてなブックマーク JSONLite API でブコメ取得
      let commentsText = "";
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
      if (!commentsText) commentsText = "コメントはまだありません。";
      
      // d. Slack Block Kit メッセージの構築
      const blocks = [
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
      
      // f. スプレッドシートに送信済URLを保存 (先頭に挿入)
      sheet.insertRowBefore(1);
      sheet.getRange(1, 1).setValue(article.url);

      processedCount++;
    } catch (err) {
      console.error("記事の処理中に重大なエラーが発生しました (" + article.url + "): ", err);
    } finally {
      // APIレートリミットを考慮して少し待機
      Utilities.sleep(1500);
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
        let html = pageRes.getContentText();
        console.log("元HTML文字数: " + html.length + "文字");
        
        // クレンジング処理
        html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
        html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
        html = html.replace(/<[^>]+>/g, ' ');
        html = html.replace(/\s+/g, ' ').trim();
        textContent = html.substring(0, 8000);
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
  module.exports = { getProperties, doGet, checkToken, runCron, getAvailableGeminiModels, syncAndNotify, runDiagnostics };
}

