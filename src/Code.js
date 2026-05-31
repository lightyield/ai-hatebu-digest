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
  
  // 3. 新着記事の抽出 (最大10件)
  let newArticles = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const url = item.getChild('link', ns).getText();
    const title = item.getChild('title', ns).getText();
    
    if (!sentUrls.includes(url)) {
      newArticles.push({ url, title });
      if (newArticles.length >= 3) break;
    }
  }
  
  if (newArticles.length === 0) return 0; // 新着記事なし
  
  // 4. 各記事の処理
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
      
      // テキストが取れなかった場合もスキップ扱い
      if (!scrapeSkipped && !textContent) {
        scrapeSkipped = true;
        scrapeSkipReason = "記事本文のテキストを抽出できませんでした。複数ページ構成や動的コンテンツの可能性があります。";
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
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${props.GEMINI_API_KEY}`;
        const payload = {
          contents: [{
            parts: [{ text: `以下の記事本文を日本語で要約してください。\n\n${textContent}` }]
          }]
        };
        
        const maxAttempts = 3;
        let delayMs = 2000;
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
                summary = geminiData.candidates[0].content.parts[0].text;
                break;
              }
            } else if (responseCode === 503 || responseCode === 429) {
              console.warn(`Gemini API 一時的エラー (${responseCode}) - リトライ試行 ${attempt}/${maxAttempts}: `, geminiRes.getContentText());
              if (attempt < maxAttempts) {
                Utilities.sleep(delayMs);
                delayMs *= 2; // 指数バックオフ
              }
            } else {
              console.warn(`Gemini API エラー (${responseCode}): `, geminiRes.getContentText());
              break; // 400等の致命的/恒常的エラーはリトライしない
            }
          } catch (e) {
            console.warn(`Gemini API 接続エラー - リトライ試行 ${attempt}/${maxAttempts}: ` + article.url, e);
            if (attempt < maxAttempts) {
              Utilities.sleep(delayMs);
              delayMs *= 2;
            }
          }
        }
      } catch (e) {
        console.warn("Gemini API要約処理プロセス全体で例外が発生しました: " + article.url, e);
      }
      
      // c. はてなブックマーク JSONLite API でブコメ取得
      let commentsText = "";
      try {
        const bApiUrl = `https://b.hatena.ne.jp/entry/jsonlite/?url=${encodeURIComponent(article.url)}`;
        const bRes = UrlFetchApp.fetch(bApiUrl, {muteHttpExceptions: true});
        if (bRes.getResponseCode() === 200) {
          const bData = JSON.parse(bRes.getContentText());
          if (bData && bData.bookmarks) {
            // コメントが空でないものを最大5件抽出
            const comments = bData.bookmarks.filter(b => b.comment.trim() !== "").slice(0, 5);
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
            "text": `*💬 人気ブコメ*\n${commentsText}`
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

// ----------------------------------------------------
// Jest テスト用エクスポート (GAS本番環境では無視される)
// ----------------------------------------------------
if (typeof module !== 'undefined') {
  module.exports = { getProperties, doGet, checkToken, runCron, syncAndNotify };
}
