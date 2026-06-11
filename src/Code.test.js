'use strict';

// ============================================================
// GASグローバルオブジェクトのモック定義
// ============================================================

/** PropertiesService モック */
const mockProps = {
  GEMINI_API_KEY: 'test-gemini-key',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/test',
  APP_SECRET: 'my-secret',
  HATENA_RSS_URL: 'https://b.hatena.ne.jp/hotentry/it.rss',
};

global.PropertiesService = {
  getScriptProperties: jest.fn(() => ({
    getProperties: jest.fn(() => ({ ...mockProps })),
  })),
};

/** ContentService モック */
const mockTextOutput = {
  setMimeType: jest.fn().mockReturnThis(),
};
global.ContentService = {
  createTextOutput: jest.fn(() => mockTextOutput),
  MimeType: { JSON: 'application/json' },
};

/** UrlFetchApp モック (各テストケースで上書き可能) */
global.UrlFetchApp = {
  fetch: jest.fn(),
};

/** XmlService モック */
const makeXmlItem = (url, title) => ({
  getChild: jest.fn((tag) => ({
    getText: jest.fn(() => (tag === 'link' ? url : title)),
  })),
});

global.XmlService = {
  parse: jest.fn(),
  getNamespace: jest.fn(() => 'ns'),
};

/** SpreadsheetApp モック */
const mockSheet = {
  getLastRow: jest.fn(() => 0),
  getRange: jest.fn(() => ({
    getValues: jest.fn(() => []),
    setValue: jest.fn(),
  })),
  insertRowBefore: jest.fn(),
  deleteRows: jest.fn(),
  getSheetByName: jest.fn(),
};

global.SpreadsheetApp = {
  getActiveSpreadsheet: jest.fn(() => ({
    getSheetByName: jest.fn(() => mockSheet),
  })),
};

/** Utilities モック */
global.Utilities = {
  sleep: jest.fn(),
};

// ============================================================
// テスト対象モジュールのロード
// ============================================================
const {
  getProperties,
  checkToken,
  doGet,
  runCron,
  syncAndNotify,
} = require('./Code');

// ============================================================
// テストスイート
// ============================================================

beforeEach(() => {
  jest.clearAllMocks();

  // PropertiesService のデフォルトモックをリセット
  global.PropertiesService.getScriptProperties.mockReturnValue({
    getProperties: jest.fn(() => ({ ...mockProps })),
  });

  // ContentService のデフォルトモックをリセット
  global.ContentService.createTextOutput.mockReturnValue(mockTextOutput);
  mockTextOutput.setMimeType.mockReturnThis();

  // SpreadsheetApp のデフォルトモックをリセット
  mockSheet.getLastRow.mockReturnValue(0);
  mockSheet.getRange.mockReturnValue({
    getValues: jest.fn(() => []),
    setValue: jest.fn(),
  });
  mockSheet.insertRowBefore.mockReset();
  mockSheet.deleteRows.mockReset();
  global.SpreadsheetApp.getActiveSpreadsheet.mockReturnValue({
    getSheetByName: jest.fn(() => mockSheet),
  });
});

// ------------------------------------------------------------
// getProperties
// ------------------------------------------------------------
describe('getProperties()', () => {
  it('スクリプトプロパティを正しく返す', () => {
    const props = getProperties();
    expect(props.GEMINI_API_KEY).toBe('test-gemini-key');
    expect(props.SLACK_WEBHOOK_URL).toBe('https://hooks.slack.com/test');
    expect(props.APP_SECRET).toBe('my-secret');
    expect(props.HATENA_RSS_URL).toBe('https://b.hatena.ne.jp/hotentry/it.rss');
  });

  it('HATENA_RSS_URLが未設定のときデフォルトURLを返す', () => {
    global.PropertiesService.getScriptProperties.mockReturnValue({
      getProperties: jest.fn(() => ({
        ...mockProps,
        HATENA_RSS_URL: undefined,
      })),
    });
    const props = getProperties();
    expect(props.HATENA_RSS_URL).toBe('https://b.hatena.ne.jp/hotentry/it.rss');
  });
});

// ------------------------------------------------------------
// checkToken
// ------------------------------------------------------------
describe('checkToken()', () => {
  it('正しいトークンのときtrueを返す', () => {
    expect(checkToken('my-secret')).toBe(true);
  });

  it('誤ったトークンのときfalseを返す', () => {
    expect(checkToken('wrong-secret')).toBe(false);
  });

  it('nullのときfalseを返す', () => {
    expect(checkToken(null)).toBeFalsy();
  });

  it('空文字のときfalseを返す', () => {
    expect(checkToken('')).toBeFalsy();
  });
});

// ------------------------------------------------------------
// doGet
// ------------------------------------------------------------
describe('doGet()', () => {
  it('正しいトークンのとき syncAndNotify を呼び出し success:true を返す', () => {
    // syncAndNotify が内部で呼ぶ全APIをモック
    const rssXmlMock = buildRssXml([]);
    global.UrlFetchApp.fetch.mockReturnValue({
      getContentText: jest.fn(() => rssXmlMock),
      getResponseCode: jest.fn(() => 200),
    });
    setupXmlServiceMock([]);

    const e = { parameter: { token: 'my-secret' } };
    const result = doGet(e);

    expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
      expect.stringContaining('"success":true')
    );
    expect(result).toBe(mockTextOutput);
  });

  it('誤ったトークンのとき Unauthorized を返す', () => {
    const e = { parameter: { token: 'bad-token' } };
    doGet(e);
    expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
      expect.stringContaining('Unauthorized')
    );
  });

  it('パラメータなしのとき Unauthorized を返す', () => {
    doGet(null);
    expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
      expect.stringContaining('Unauthorized')
    );
  });

  it('syncAndNotify が例外を投げたとき success:false を返す', () => {
    // RSSフェッチで例外を投げる
    global.UrlFetchApp.fetch.mockImplementation(() => {
      throw new Error('Network error');
    });

    const e = { parameter: { token: 'my-secret' } };
    doGet(e);

    expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
      expect.stringContaining('"success":false')
    );
  });
});

// ------------------------------------------------------------
// runCron
// ------------------------------------------------------------
describe('runCron()', () => {
  it('新着記事が0件のとき例外を投げない', () => {
    const rssXmlMock = buildRssXml([]);
    global.UrlFetchApp.fetch.mockReturnValue({
      getContentText: jest.fn(() => rssXmlMock),
      getResponseCode: jest.fn(() => 200),
    });
    setupXmlServiceMock([]);

    expect(() => runCron()).not.toThrow();
  });

  it('syncAndNotify が例外を投げても runCron は例外を外に伝播しない', () => {
    global.UrlFetchApp.fetch.mockImplementation(() => {
      throw new Error('Unexpected error');
    });
    expect(() => runCron()).not.toThrow();
  });
});

// ------------------------------------------------------------
// syncAndNotify
// ------------------------------------------------------------
describe('syncAndNotify()', () => {
  it("シート 'Articles' が存在しない場合エラーを投げる", () => {
    global.SpreadsheetApp.getActiveSpreadsheet.mockReturnValue({
      getSheetByName: jest.fn(() => null),
    });

    // RSSはフェッチできる状態にしておく
    setupXmlServiceMock([]);
    global.UrlFetchApp.fetch.mockReturnValue({
      getContentText: jest.fn(() => buildRssXml([])),
      getResponseCode: jest.fn(() => 200),
    });

    expect(() => syncAndNotify()).toThrow("シート 'Articles' が見つかりません。");
  });

  it('新着記事が0件のとき0を返す', () => {
    // スプレッドシートに送信済URL無し、RSS も空
    setupXmlServiceMock([]);
    global.UrlFetchApp.fetch.mockReturnValue({
      getContentText: jest.fn(() => buildRssXml([])),
      getResponseCode: jest.fn(() => 200),
    });

    const count = syncAndNotify();
    expect(count).toBe(0);
  });

  it('新着記事が1件あるとき1を返す', () => {
    const articles = [
      { url: 'https://example.com/article1', title: 'テスト記事1' },
    ];

    setupXmlServiceMock(articles);
    setupFetchMocksForArticles(articles);

    const count = syncAndNotify();
    expect(count).toBe(1);
  });

  it('スプレッドシートの送信済URLと重複する記事はスキップする', () => {
    const alreadySentUrl = 'https://example.com/already-sent';
    const newUrl = 'https://example.com/new-article';

    // 送信済URLが1件ある状態
    mockSheet.getLastRow.mockReturnValue(1);
    mockSheet.getRange.mockReturnValue({
      getValues: jest.fn(() => [[alreadySentUrl]]),
      setValue: jest.fn(),
    });

    const articles = [
      { url: alreadySentUrl, title: '送信済記事' },
      { url: newUrl, title: '新着記事' },
    ];
    setupXmlServiceMock(articles);
    setupFetchMocksForArticles([{ url: newUrl, title: '新着記事' }]);

    const count = syncAndNotify();
    expect(count).toBe(1);
  });

  it('処理後に送信済URLがスプレッドシートに保存される', () => {
    const articles = [
      { url: 'https://example.com/article1', title: 'テスト記事1' },
    ];
    setupXmlServiceMock(articles);
    setupFetchMocksForArticles(articles);

    syncAndNotify();

    expect(mockSheet.insertRowBefore).toHaveBeenCalledWith(1);
  });

  it('送信済が100件を超えたら古い行を削除する', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '記事1' },
    ];
    setupXmlServiceMock(articles);
    setupFetchMocksForArticles(articles);

    // 処理後の行数を101として返す
    mockSheet.getLastRow
      .mockReturnValueOnce(0)   // 最初の読み取り (sentUrls用)
      .mockReturnValueOnce(101); // 最後の削除チェック用

    syncAndNotify();

    expect(mockSheet.deleteRows).toHaveBeenCalledWith(101, 1);
  });

  it('Gemini APIが失敗しても処理を継続し記事をカウントする', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '記事1' },
    ];
    setupXmlServiceMock(articles);

    // 各URLへのフェッチをURLで振り分け
    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '記事本文。'.repeat(50) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('generativelanguage')) {
        // Gemini API 失敗
        return {
          getContentText: jest.fn(() => '{"error":"quota exceeded"}'),
          getResponseCode: jest.fn(() => 429),
        };
      }
      if (url.includes('b.hatena.ne.jp/entry/jsonlite')) {
        return {
          getContentText: jest.fn(() =>
            JSON.stringify({ bookmarks: [{ user: 'user1', comment: 'コメント1' }] })
          ),
          getResponseCode: jest.fn(() => 200),
        };
      }
      // Slack Webhook
      return {
        getContentText: jest.fn(() => 'ok'),
        getResponseCode: jest.fn(() => 200),
      };
    });

    const count = syncAndNotify();
    expect(count).toBe(1);
  });

  it('最大5件を超えるRSS記事が来ても5件のみ処理する', () => {
    const articles = Array.from({ length: 15 }, (_, i) => ({
      url: `https://example.com/article${i + 1}`,
      title: `記事${i + 1}`,
    }));

    setupXmlServiceMock(articles);
    setupFetchMocksForArticles(articles.slice(0, 5));

    const count = syncAndNotify();
    expect(count).toBe(5);
  });

  it('記事ページへのアクセスがHTTPエラー(403等)の場合、要約をスキップしSlack通知しカウントする', () => {
    const articles = [
      { url: 'https://example.com/article1', title: 'アクセス制限記事' },
    ];

    setupXmlServiceMock(articles);

    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      // 記事ページ: 403を返す
      if (url === articles[0].url) {
        return {
          getContentText: jest.fn(() => 'Forbidden'),
          getResponseCode: jest.fn(() => 403),
        };
      }
      // Slack Webhook
      return {
        getContentText: jest.fn(() => 'ok'),
        getResponseCode: jest.fn(() => 200),
      };
    });

    const count = syncAndNotify();

    // スキップでも1件としてカウントされる
    expect(count).toBe(1);
    // スプレッドシートにURLが保存される
    expect(mockSheet.insertRowBefore).toHaveBeenCalledWith(1);
  });

  it('記事ページの本文テキストが空の場合、要約をスキップしSlack通知しカウントする', () => {
    const articles = [
      { url: 'https://example.com/article2', title: '空コンテンツ記事' },
    ];

    setupXmlServiceMock(articles);

    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      // 記事ページ: 200だがHTMLが空（タグのみで本文なし）
      if (url === articles[0].url) {
        return {
          getContentText: jest.fn(() => '<html><head></head><body></body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      // Slack Webhook
      return {
        getContentText: jest.fn(() => 'ok'),
        getResponseCode: jest.fn(() => 200),
      };
    });

    const count = syncAndNotify();

    // スキップでも1件としてカウントされる
    expect(count).toBe(1);
    // スプレッドシートにURLが保存される
    expect(mockSheet.insertRowBefore).toHaveBeenCalledWith(1);
  });

  it('ある記事の処理中に重大な例外が発生しても、他の記事の処理を継続する', () => {
    const articles = [
      { url: 'https://example.com/article1', title: 'テスト記事1' },
      { url: 'https://example.com/article2', title: 'テスト記事2' },
    ];

    setupXmlServiceMock(articles);
    setupFetchMocksForArticles(articles);

    // 1件目のスプレッドシートへの保存処理 (insertRowBefore) で例外を発生させる
    mockSheet.insertRowBefore.mockImplementationOnce(() => {
      throw new Error('Database write error');
    });

    const count = syncAndNotify();
    
    // 1件目は例外でカウントされず（processedCount++がスキップされる）、2件目は正常にカウントされるため合計1になる
    expect(count).toBe(1);
    // insertRowBefore は2回とも呼ばれるはず
    expect(mockSheet.insertRowBefore).toHaveBeenCalledTimes(2);
  });

  it('本文テキストが極端に短い（150文字未満）の場合、要約をスキップしSlack警告通知を送る', () => {
    const articles = [
      { url: 'https://example.com/short', title: '短い記事' },
    ];
    setupXmlServiceMock(articles);
    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url) {
        return {
          getContentText: jest.fn(() => '<html><body>短いテキスト。</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      return {
        getContentText: jest.fn(() => 'ok'),
        getResponseCode: jest.fn(() => 200),
      };
    });

    const count = syncAndNotify();
    expect(count).toBe(1);
    
    // Slack Webhook に警告メッセージ（要約スキップ）が送信されたことを検証
    const slackCall = global.UrlFetchApp.fetch.mock.calls.find(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
    expect(slackCall).toBeDefined();
    const payload = JSON.parse(slackCall[1].payload);
    expect(payload.blocks[3].text.text).toContain('要約スキップ');
    expect(payload.blocks[3].text.text).toContain('テキストを十分に抽出できませんでした');
  });

  it('Gemini APIが安全フィルター（SAFETY等）でブロックされた場合、リトライせずにエラー理由を表示する', () => {
    const articles = [
      { url: 'https://example.com/blocked', title: 'ブロック記事' },
    ];
    setupXmlServiceMock(articles);
    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('generativelanguage')) {
        // contentが欠落し、finishReason が SAFETY であるレスポンス
        return {
          getContentText: jest.fn(() => JSON.stringify({
            candidates: [{ finishReason: 'SAFETY' }]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('b.hatena.ne.jp')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({ bookmarks: [] })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      return {
        getContentText: jest.fn(() => 'ok'),
        getResponseCode: jest.fn(() => 200),
      };
    });

    const count = syncAndNotify();
    expect(count).toBe(1);

    // Slack への送信内容に安全フィルターに関する理由が含まれることを検証
    const slackCall = global.UrlFetchApp.fetch.mock.calls.find(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
    expect(slackCall).toBeDefined();
    const payload = JSON.parse(slackCall[1].payload);
    expect(payload.blocks[3].text.text).toContain('理由: SAFETY');
  });

  it('Gemini APIが恒常的なエラー（400等）を返した場合、サーキットブレーカー（利用停止フラグ）が作動し以降の記事のAPI呼び出しをスキップする', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '記事1' },
      { url: 'https://example.com/article2', title: '記事2' },
    ];
    setupXmlServiceMock(articles);

    let geminiCallCount = 0;
    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url || url === articles[1].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('generativelanguage')) {
        geminiCallCount++;
        // 恒常的エラー 400 Bad Request
        return {
          getContentText: jest.fn(() => '{"error":"bad request"}'),
          getResponseCode: jest.fn(() => 400),
        };
      }
      if (url.includes('b.hatena.ne.jp')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({ bookmarks: [] })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      return {
        getContentText: jest.fn(() => 'ok'),
        getResponseCode: jest.fn(() => 200),
      };
    });

    const count = syncAndNotify();
    expect(count).toBe(2);
    // 恒常的エラーを検知した時点でサーキットブレーカーが作動するため、Gemini APIの呼び出しは1回のみになるはず
    expect(geminiCallCount).toBe(1);

    // 2件目の記事は「Gemini APIが一時的に利用不可のため〜」という要約になることを検証
    const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
    expect(slackCalls.length).toBe(2);
    const payload2 = JSON.parse(slackCalls[1][1].payload);
    expect(payload2.blocks[3].text.text).toContain('Gemini APIが一時的に利用不可');
  });
});

// ============================================================
// テストヘルパー
// ============================================================

/**
 * XmlService をモック化し、指定した articles をRSS itemsとして返す
 */
function setupXmlServiceMock(articles) {
  const mockItems = articles.map((a) => makeXmlItem(a.url, a.title));
  const mockRoot = {
    getChildren: jest.fn(() => mockItems),
  };
  const mockDocument = {
    getRootElement: jest.fn(() => mockRoot),
  };
  global.XmlService.parse.mockReturnValue(mockDocument);
  global.XmlService.getNamespace.mockReturnValue('ns');
}

/**
 * 記事スクレイピング・Gemini・ブコメ・Slack の fetch をまとめてモック化
 */
function setupFetchMocksForArticles(articles) {
  global.UrlFetchApp.fetch.mockImplementation((url) => {
    // RSS フェッチ
    if (url === mockProps.HATENA_RSS_URL) {
      return {
        getContentText: jest.fn(() => buildRssXml(articles)),
        getResponseCode: jest.fn(() => 200),
      };
    }
    // Gemini API
    if (url.includes('generativelanguage')) {
      return {
        getContentText: jest.fn(() =>
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'テスト要約' }] } }],
          })
        ),
        getResponseCode: jest.fn(() => 200),
      };
    }
    // はてなブコメ API
    if (url.includes('b.hatena.ne.jp/entry/jsonlite')) {
      return {
        getContentText: jest.fn(() =>
          JSON.stringify({
            bookmarks: [
              { user: 'user1', comment: 'ブコメ1' },
              { user: 'user2', comment: '' },
            ],
          })
        ),
        getResponseCode: jest.fn(() => 200),
      };
    }
    // Slack Webhook & 記事本文スクレイピング
    return {
      getContentText: jest.fn(() => '<html><body>' + '記事本文テキスト。'.repeat(30) + '</body></html>'),
      getResponseCode: jest.fn(() => 200),
    };
  });
}

/**
 * buildRssXml: XmlService.parse が受け取るダミーのXML文字列を返す
 * (実際には XmlService をモック化しているため内容は問わない)
 */
function buildRssXml(articles) {
  return `<?xml version="1.0"?><rdf:RDF></rdf:RDF>`;
}
