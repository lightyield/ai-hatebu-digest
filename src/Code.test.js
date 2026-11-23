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

let mockPropStore = { ...mockProps };
const mockScriptProperties = {
  getProperties: jest.fn(() => ({ ...mockPropStore })),
  getProperty: jest.fn((key) => (key in mockPropStore ? mockPropStore[key] : null)),
  setProperty: jest.fn((key, val) => { mockPropStore[key] = String(val); }),
  deleteProperty: jest.fn((key) => { delete mockPropStore[key]; }),
};

global.PropertiesService = {
  getScriptProperties: jest.fn(() => mockScriptProperties),
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

/** GmailApp モック */
const mockGmailLabel = { getName: jest.fn(() => 'gas-failure-reported') };
global.GmailApp = {
  search: jest.fn(() => []),
  getUserLabelByName: jest.fn(() => mockGmailLabel),
  createLabel: jest.fn(() => mockGmailLabel),
};

// ============================================================
// テスト対象モジュールのロード
// ============================================================
const {
  getProperties,
  checkToken,
  doGet,
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
} = require('./Code');

// ============================================================
// テストスイート
// ============================================================

beforeEach(() => {
  jest.clearAllMocks();

  // PropertiesService のデフォルトモックをリセット
  mockPropStore = { ...mockProps };
  mockScriptProperties.getProperties.mockImplementation(() => ({ ...mockPropStore }));
  mockScriptProperties.getProperty.mockImplementation((key) => (key in mockPropStore ? mockPropStore[key] : null));
  mockScriptProperties.setProperty.mockImplementation((key, val) => { mockPropStore[key] = String(val); });
  mockScriptProperties.deleteProperty.mockImplementation((key) => { delete mockPropStore[key]; });
  global.PropertiesService.getScriptProperties.mockReturnValue(mockScriptProperties);

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

  // GmailApp のデフォルトモックをリセット
  global.GmailApp.search.mockReset().mockReturnValue([]);
  global.GmailApp.getUserLabelByName.mockReset().mockReturnValue(mockGmailLabel);
  global.GmailApp.createLabel.mockReset().mockReturnValue(mockGmailLabel);
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
// getAvailableGeminiModels
// ------------------------------------------------------------
describe('getAvailableGeminiModels()', () => {
  it('APIキーが未指定の場合、デフォルトモデルリストを返す', () => {
    const models = getAvailableGeminiModels('');
    expect(models).toEqual(['gemini-2.5-flash-lite', 'gemini-2.5-flash']);
  });

  it('models.list APIから正常にモデル一覧を取得し、適切にフィルタ・ソートして最大3件に絞り込む', () => {
    const mockApiResponse = {
      models: [
        { name: 'models/gemini-1.5-pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] }, // 画像用除外
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }, // 非generateContent
        { name: 'models/gemini-2.5-flash-preview', supportedGenerationMethods: ['generateContent'] }, // プレビュー版
      ],
    };

    global.UrlFetchApp.fetch.mockReturnValue({
      getContentText: jest.fn(() => JSON.stringify(mockApiResponse)),
      getResponseCode: jest.fn(() => 200),
    });

    const result = getAvailableGeminiModels('test-key');

    // 特性分散型により、最新Lite、最新標準、最も成熟した標準モデルが選定される
    expect(result.length).toBe(3);
    expect(result[0]).toBe('gemini-2.5-flash-lite');
    expect(result[1]).toBe('gemini-3.5-flash');
    expect(result[2]).toBe('gemini-2.5-flash');
  });

  it('多数のFlashモデルが存在する場合、最新Lite・最新標準・成熟下位標準を自動選出する', () => {
    const mockApiResponse = {
      models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.7-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
      ],
    };

    global.UrlFetchApp.fetch.mockReturnValue({
      getContentText: jest.fn(() => JSON.stringify(mockApiResponse)),
      getResponseCode: jest.fn(() => 200),
    });

    const result = getAvailableGeminiModels('test-key');

    expect(result).toEqual([
      'gemini-3.5-flash-lite', // ① 最新のLite（高速・過負荷耐性優先）
      'gemini-3.8-flash',      // ② 最新の標準Flash
      'gemini-2.5-flash',      // ③ 最も成熟した標準Flash
    ]);
  });

  it('models.list APIがHTTPエラーを返した場合、デフォルトモデルリストを返す', () => {
    global.UrlFetchApp.fetch.mockReturnValue({
      getContentText: jest.fn(() => 'Internal Server Error'),
      getResponseCode: jest.fn(() => 500),
    });

    const result = getAvailableGeminiModels('test-key');
    expect(result).toEqual(['gemini-2.5-flash-lite', 'gemini-2.5-flash']);
  });

  it('models.list API呼び出しで例外が発生した場合、デフォルトモデルリストを返す', () => {
    global.UrlFetchApp.fetch.mockImplementation(() => {
      throw new Error('Network error');
    });

    const result = getAvailableGeminiModels('test-key');
    expect(result).toEqual(['gemini-2.5-flash-lite', 'gemini-2.5-flash']);
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
      if (url.includes('models?key=')) {
        // models.list
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '記事本文。'.repeat(50) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
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

  it('最大3件を超えるRSS記事が来ても3件のみ処理する', () => {
    const articles = Array.from({ length: 15 }, (_, i) => ({
      url: `https://example.com/article${i + 1}`,
      title: `記事${i + 1}`,
    }));

    setupXmlServiceMock(articles);
    setupFetchMocksForArticles(articles.slice(0, 3));

    const count = syncAndNotify();
    expect(count).toBe(3);
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
    // insertRowBefore は、1件目で通常保存の失敗＋catch内のフォールバック保存、および2件目の通常保存の計3回呼ばれる
    expect(mockSheet.insertRowBefore).toHaveBeenCalledTimes(3);
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
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
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

  it('Gemini APIがモデルエラー（404等）を返した場合、次候補モデルにフォールバックして要約を生成する', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '記事1' },
    ];
    setupXmlServiceMock(articles);

    let triedModels = [];
    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [
              { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
            ]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
        if (url.includes('gemini-3.5-flash')) {
          triedModels.push('gemini-3.5-flash');
          return {
            getContentText: jest.fn(() => '{"error":"model not found"}'),
            getResponseCode: jest.fn(() => 404),
          };
        }
        if (url.includes('gemini-2.5-flash')) {
          triedModels.push('gemini-2.5-flash');
          return {
            getContentText: jest.fn(() => JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'フォールバック成功要約' }] } }]
            })),
            getResponseCode: jest.fn(() => 200),
          };
        }
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
    expect(triedModels).toEqual(['gemini-3.5-flash', 'gemini-2.5-flash']);

    const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
    expect(slackCalls.length).toBe(1);
    const payload = JSON.parse(slackCalls[0][1].payload);
    expect(payload.blocks[3].text.text).toContain('フォールバック成功要約');
  });

  it('すべてのGeminiモデルでエラーとなった場合、サーキットブレーカーが作動し以降の記事をスキップする', () => {
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
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
            ]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url || url === articles[1].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
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
    // 2.5系2モデルそれぞれで thinkingConfig あり→なしの計4回試行後に全モデル400失敗でサーキットブレーカー作動。
    // 2件目の記事での generateContent は一切呼ばれない
    expect(geminiCallCount).toBe(4);

    // 2件目の記事は「Gemini APIが一時的に利用不可のため〜」という要約になることを検証
    const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
    expect(slackCalls.length).toBe(2);
    const payload2 = JSON.parse(slackCalls[1][1].payload);
    expect(payload2.blocks[3].text.text).toContain('Gemini APIが一時的に利用不可');
  });

  it('Gemini APIがレートリミット（429）を返した場合、フォールバックせずに即座にサーキットブレーカーを作動させる', () => {
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
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
            ]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url || url === articles[1].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
        geminiCallCount++;
        // 429 Too Many Requests
        return {
          getContentText: jest.fn(() => '{"error":"Resource has been exhausted"}'),
          getResponseCode: jest.fn(() => 429),
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
    // 429発生により1回目のモデル呼び出しで即座にサーキットブレーカーが作動（フォールバックせず1回のみ）
    expect(geminiCallCount).toBe(1);

    const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
    expect(slackCalls.length).toBe(2);
    const payload2 = JSON.parse(slackCalls[1][1].payload);
    expect(payload2.blocks[3].text.text).toContain('Gemini APIが一時的に利用不可');
  });

  it('1件目の記事で503過負荷により全モデル失敗しても、サーキットブレーカーを作動させず2件目の記事の要約を継続する', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '記事1' },
      { url: 'https://example.com/article2', title: '記事2' },
    ];
    setupXmlServiceMock(articles);

    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
            ]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url || url === articles[1].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
        // 1件目の記事は全モデル503エラー、2件目の記事は200成功
        if (url.includes('gemini-2.5-flash')) {
          // 呼び出し履歴から1件目のリクエストか2件目かを判定
          const isArticle2 = global.UrlFetchApp.fetch.mock.calls.some(c => c[0] === articles[1].url);
          if (!isArticle2) {
            return {
              getContentText: jest.fn(() => '{"error":{"code":503,"message":"The service is temporarily unavailable"}}'),
              getResponseCode: jest.fn(() => 503),
            };
          } else {
            return {
              getContentText: jest.fn(() => JSON.stringify({
                candidates: [{ content: { parts: [{ text: '2件目の要約成功' }] } }]
              })),
              getResponseCode: jest.fn(() => 200),
            };
          }
        }
        return {
          getContentText: jest.fn(() => '{"error":{"code":503,"message":"The service is temporarily unavailable"}}'),
          getResponseCode: jest.fn(() => 503),
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

    const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
    expect(slackCalls.length).toBe(2);
    // 1件目は過負荷エラーメッセージ
    const payload1 = JSON.parse(slackCalls[0][1].payload);
    expect(payload1.blocks[3].text.text).toContain('一時的なサーバー混雑等のため');

    // 2件目はサーキットブレーカーで巻き添えにならず、正常に要約が届く
    const payload2 = JSON.parse(slackCalls[1][1].payload);
    expect(payload2.blocks[3].text.text).toContain('2件目の要約成功');
  });

  it('1件目でフォールバック先のモデルで成功した場合、2件目ではその成功モデルを優先して呼び出す', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '記事1' },
      { url: 'https://example.com/article2', title: '記事2' },
    ];
    setupXmlServiceMock(articles);

    const geminiUrlsCalled = [];
    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
            ]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url || url === articles[1].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
        geminiUrlsCalled.push(url);
        // 第1候補 gemini-2.5-flash-lite は 404 で失敗し、第2候補 gemini-2.5-flash は 200 で成功する
        if (url.includes('gemini-2.5-flash-lite:generateContent')) {
          return {
            getContentText: jest.fn(() => '{"error":"model not found"}'),
            getResponseCode: jest.fn(() => 404),
          };
        }
        return {
          getContentText: jest.fn(() => JSON.stringify({
            candidates: [{ content: { parts: [{ text: '標準モデルでの要約' }] } }]
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
    expect(count).toBe(2);

    // 1件目: gemini-2.5-flash-lite (404) -> gemini-2.5-flash (200成功)
    // 2件目: 直前で成功した gemini-2.5-flash が先頭に昇格して最優先で呼ばれる
    expect(geminiUrlsCalled.length).toBe(3);
    expect(geminiUrlsCalled[0]).toContain('gemini-2.5-flash-lite:generateContent');
    expect(geminiUrlsCalled[1]).toContain('gemini-2.5-flash:generateContent');
    expect(geminiUrlsCalled[2]).toContain('gemini-2.5-flash:generateContent'); // 2件目は最初から標準モデルを呼び出す
  });

  it('処理時間が2分00秒（120秒）を超過した場合、残りの記事の処理を安全に中断して正常終了する', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '記事1' },
      { url: 'https://example.com/article2', title: '記事2' },
      { url: 'https://example.com/article3', title: '記事3' },
    ];
    setupXmlServiceMock(articles);
    setupFetchMocksForArticles(articles);

    let currentTime = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
    mockSheet.insertRowBefore.mockImplementation(() => {
      currentTime = 125000; // 1件目保存完了後に125秒経過（> 120秒）へ進める
    });

    try {
      const count = syncAndNotify();
      // 1件目のみ処理され、2件目以降はタイムアウトガードで中断される
      expect(count).toBe(1);
    } finally {
      Date.now.mockRestore();
    }
  });

  it('Gemini APIのリトライ・フォールバック中に2分40秒（160秒）を超過した場合、直ちに要約試行を打ち切って記事処理を完了させる', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '記事1' },
    ];
    setupXmlServiceMock(articles);

    let geminiCallCount = 0;
    let currentTime = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => currentTime);

    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
            ]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
        geminiCallCount++;
        currentTime = 165000; // 1回目の503レスポンス後に165秒経過（> 160秒）へ進める
        return {
          getContentText: jest.fn(() => '{"error":{"code":503,"message":"unavailable"}}'),
          getResponseCode: jest.fn(() => 503),
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

    try {
      const count = syncAndNotify();
      expect(count).toBe(1);
      // 1回目の503の後、2回目のリトライ前に時間超過を検知して打ち切るため、Gemini APIは1回しか呼ばれない
      expect(geminiCallCount).toBe(1);

      const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
      expect(slackCalls.length).toBe(1);
      const payload = JSON.parse(slackCalls[0][1].payload);
      expect(payload.blocks[3].text.text).toContain('実行時間の制限に近づいたため');
    } finally {
      Date.now.mockRestore();
    }
  });

  it('スクレイピング前に2分20秒（140秒）を超過した場合、本文取得をスキップして要約スキップ通知を送る', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '記事1' },
    ];
    setupXmlServiceMock(articles);

    let currentTime = 1000;
    let scrapeFetchCalled = false;
    let passedLoopCheck = false;
    jest.spyOn(Date, 'now').mockImplementation(() => {
      if (passedLoopCheck) {
        return 145000; // スクレイピング判定以降は145秒経過（> 140秒）
      }
      if (currentTime === 110000) {
        passedLoopCheck = true; // 記事ループ先頭チェック（120秒）を通過
      }
      return currentTime;
    });

    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('models?key=')) {
        // モデル一覧取得後に時刻を110秒へ進める（記事ループ先頭の120秒判定は通過する）
        currentTime = 110000;
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url) {
        scrapeFetchCalled = true;
        return {
          getContentText: jest.fn(() => '<html><body>本文</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      return {
        getContentText: jest.fn(() => 'ok'),
        getResponseCode: jest.fn(() => 200),
      };
    });

    try {
      const count = syncAndNotify();
      expect(count).toBe(1);
      // スクレイピングのfetchはスキップされる
      expect(scrapeFetchCalled).toBe(false);

      // Slack通知にスキップ理由が含まれていることを確認
      const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
      expect(slackCalls.length).toBe(1);
      const payload = JSON.parse(slackCalls[0][1].payload);
      expect(payload.blocks[3].text.text).toContain('実行時間の制限に近づいたため、記事本文の取得をスキップしました');
    } finally {
      Date.now.mockRestore();
    }
  });

  it('はてなブコメ取得前に3分30秒（210秒）を超過した場合、ブコメAPIのfetchをスキップする', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '記事1' },
    ];
    setupXmlServiceMock(articles);

    let currentTime = 1000;
    let bApiFetchCalled = false;
    jest.spyOn(Date, 'now').mockImplementation(() => currentTime);

    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
        // Gemini成功後に時刻を215秒（> 210秒、かつ <= 240秒）へ進める
        currentTime = 215000;
        return {
          getContentText: jest.fn(() => JSON.stringify({
            candidates: [{ content: { parts: [{ text: '要約テスト' }] } }]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('b.hatena.ne.jp/entry/jsonlite')) {
        bApiFetchCalled = true;
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

    try {
      const count = syncAndNotify();
      expect(count).toBe(1);
      // ブコメ取得のfetchはスキップされる
      expect(bApiFetchCalled).toBe(false);

      // Slack通知のブコメ欄に制限警告が含まれる
      const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
      expect(slackCalls.length).toBe(1);
      const payload = JSON.parse(slackCalls[0][1].payload);
      expect(payload.blocks[5].text.text).toContain('実行時間の制限に近づいたため、コメント取得をスキップしました');
    } finally {
      Date.now.mockRestore();
    }
  });

  it('Slack通知送信前に4分00秒（240秒）を超過した場合、Slack通知のfetchをスキップしスプレッドシートに保存する', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '記事1' },
    ];
    setupXmlServiceMock(articles);

    let currentTime = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => currentTime);

    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            candidates: [{ content: { parts: [{ text: '要約テスト' }] } }]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('b.hatena.ne.jp/entry/jsonlite')) {
        // ブコメ取得後に245秒（> 240秒）へ進める
        currentTime = 245000;
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

    try {
      const count = syncAndNotify();
      expect(count).toBe(1);

      // Slack通知のfetchは呼ばれない
      const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
      expect(slackCalls.length).toBe(0);

      // スプレッドシートには保存される
      expect(mockSheet.insertRowBefore).toHaveBeenCalledWith(1);
      expect(mockSheet.getRange().setValue).toHaveBeenCalledWith(articles[0].url);
    } finally {
      Date.now.mockRestore();
    }
  });

  it('記事の処理中に重大な例外が発生した場合でも、スプレッドシートにURLを保存して翌日の再試行ループを防止する', () => {
    const articles = [
      { url: 'https://example.com/article1', title: 'テスト記事' },
    ];
    setupXmlServiceMock(articles);
    setupFetchMocksForArticles(articles);

    let setValueCalls = 0;
    mockSheet.getRange.mockImplementation(() => ({
      getValues: jest.fn(() => []),
      setValue: jest.fn(() => {
        setValueCalls++;
        // 通常の保存処理（1回目）で予期せぬ例外を発生させる
        if (setValueCalls === 1) {
          throw new Error('Database disk full error');
        }
      }),
    }));

    const count = syncAndNotify();
    // 重大例外発生のため正常処理数にはカウントされない
    expect(count).toBe(0);
    // catchブロック内の再試行ループ防止処理により、setValueが2回（失敗した通常保存＋フォールバック保存）呼ばれる
    expect(setValueCalls).toBe(2);
    expect(mockSheet.insertRowBefore).toHaveBeenCalledWith(1);
  });

  it('前回実行が記事処理中に強制終了（IN_PROGRESS_ARTICLE残存）していた場合、該当URLを自動スキップ登録してSlack通知し、後続記事を処理する', () => {
    const crashedArticle = { url: 'https://example.com/crashed-article', title: 'タイムアウト原因記事' };
    const nextArticle = { url: 'https://example.com/next-article', title: '次の正常記事' };
    mockPropStore.IN_PROGRESS_ARTICLE = JSON.stringify({
      url: crashedArticle.url,
      title: crashedArticle.title,
      startedAt: '2026-11-20T11:18:00.000Z',
    });

    const articles = [crashedArticle, nextArticle];
    setupXmlServiceMock(articles);
    setupFetchMocksForArticles([nextArticle]);

    const savedUrls = [];
    mockSheet.getRange.mockImplementation(() => ({
      getValues: jest.fn(() => []),
      setValue: jest.fn((val) => savedUrls.push(val)),
    }));

    const count = syncAndNotify();
    // 正常記事1件のみが処理カウントされる
    expect(count).toBe(1);
    // クラッシュ記事が先に履歴登録され、その後正常記事も履歴登録される
    expect(savedUrls).toEqual([crashedArticle.url, nextArticle.url]);
    // クラッシュ記事のURLはスクレイピングされない
    const crashedFetchCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === crashedArticle.url);
    expect(crashedFetchCalls.length).toBe(0);
    // Slack通知はクラッシュ自動復旧警告 + 正常記事通知 の計2件
    const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
    expect(slackCalls.length).toBe(2);
    const recoveryPayload = JSON.parse(slackCalls[0][1].payload);
    expect(recoveryPayload.blocks[3].text.text).toContain('タイムアウトからの自動復旧');
    // IN_PROGRESS_ARTICLE はクリーンアップされている
    expect(mockPropStore.IN_PROGRESS_ARTICLE).toBeUndefined();
  });

  it('記事のContent-TypeがPDFなど非テキストの場合、getContentTextを呼ばずに要約スキップして履歴保存する', () => {
    const articles = [
      { url: 'https://example.com/paper.pdf', title: 'PDF論文記事' },
    ];
    setupXmlServiceMock(articles);

    const pdfGetContentText = jest.fn(() => '%PDF-1.7 binary...');
    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url) {
        return {
          getHeaders: jest.fn(() => ({ 'Content-Type': 'application/pdf' })),
          getContentText: pdfGetContentText,
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
    // 非テキストコンテンツのため getContentText() は呼ばれない
    expect(pdfGetContentText).not.toHaveBeenCalled();

    const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
    expect(slackCalls.length).toBe(1);
    const payload = JSON.parse(slackCalls[0][1].payload);
    expect(payload.blocks[3].text.text).toContain('HTML/テキスト以外のコンテンツ');
    expect(payload.blocks[3].text.text).toContain('application/pdf');
  });

  it('Gemini APIの503応答に15秒以上かかった場合、同一モデルを再試行せず即座に次候補モデルへフォールバックする', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '遅延テスト記事' },
    ];
    setupXmlServiceMock(articles);

    let currentTime = 1000;
    const geminiModelsCalled = [];
    jest.spyOn(Date, 'now').mockImplementation(() => currentTime);

    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
            ]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
        if (url.includes('gemini-2.5-flash-lite:generateContent')) {
          geminiModelsCalled.push('gemini-2.5-flash-lite');
          currentTime += 20000; // 20秒（>= 15秒）かかって503を返す
          return {
            getContentText: jest.fn(() => '{"error":{"code":503,"message":"overloaded"}}'),
            getResponseCode: jest.fn(() => 503),
          };
        }
        geminiModelsCalled.push('gemini-2.5-flash');
        return {
          getContentText: jest.fn(() => JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'フォールバックモデルで高速要約成功' }] } }]
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

    try {
      const count = syncAndNotify();
      expect(count).toBe(1);
      // 1回目の遅延503の後、同一モデル(gemini-2.5-flash-lite)を再試行せず即座に次候補(gemini-2.5-flash)へフォールバックする
      expect(geminiModelsCalled).toEqual(['gemini-2.5-flash-lite', 'gemini-2.5-flash']);
    } finally {
      Date.now.mockRestore();
    }
  });

  it('Gemini APIリクエストに thinkingBudget: 0 が含まれ、thinking非対応の400エラー時はthinkingConfigを除外して再試行し2件目以降も除外する', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '記事1' },
      { url: 'https://example.com/article2', title: '記事2' },
    ];
    setupXmlServiceMock(articles);

    const geminiPayloads = [];
    global.UrlFetchApp.fetch.mockImplementation((url, options) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
            ]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url || url === articles[1].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
        const parsed = JSON.parse(options.payload);
        geminiPayloads.push(parsed);
        // thinkingConfig が含まれている場合は非対応エラー(400)を返す
        if (parsed.generationConfig && parsed.generationConfig.thinkingConfig) {
          return {
            getContentText: jest.fn(() => '{"error":{"code":400,"message":"Thinking is not supported by this model."}}'),
            getResponseCode: jest.fn(() => 400),
          };
        }
        return {
          getContentText: jest.fn(() => JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'thinkingConfig除外で要約成功' }] } }]
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
    expect(count).toBe(2);
    // 1回目(記事1): thinkingBudget: 0 付きで400
    // 2回目(記事1再試行): thinkingConfig 除外で200成功
    // 3回目(記事2): 記憶済のため最初から thinkingConfig なしで200成功
    expect(geminiPayloads.length).toBe(3);
    expect(geminiPayloads[0].generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(geminiPayloads[1].generationConfig.thinkingConfig).toBeUndefined();
    expect(geminiPayloads[2].generationConfig.thinkingConfig).toBeUndefined();

    const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
    expect(slackCalls.length).toBe(2);
    expect(JSON.parse(slackCalls[0][1].payload).blocks[3].text.text).toContain('thinkingConfig除外で要約成功');
    expect(JSON.parse(slackCalls[1][1].payload).blocks[3].text.text).toContain('thinkingConfig除外で要約成功');
  });

  it('Gemini 3.x系など2.5系以外のモデルでは最初から thinkingConfig を付与せずにリクエストする', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '記事1' },
    ];
    setupXmlServiceMock(articles);

    const geminiPayloads = [];
    global.UrlFetchApp.fetch.mockImplementation((url, options) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [
              { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
            ]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
        const parsed = JSON.parse(options.payload);
        geminiPayloads.push(parsed);
        return {
          getContentText: jest.fn(() => JSON.stringify({
            candidates: [{ content: { parts: [{ text: '3.5-flash-liteで1発成功' }] } }]
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
    expect(geminiPayloads.length).toBe(1);
    expect(geminiPayloads[0].generationConfig.thinkingConfig).toBeUndefined();
    expect(geminiPayloads[0].generationConfig.maxOutputTokens).toBe(2048);

    const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
    expect(slackCalls.length).toBe(1);
    expect(JSON.parse(slackCalls[0][1].payload).blocks[3].text.text).toContain('3.5-flash-liteで1発成功');
  });

  it('2.5系モデルでエラー文言に"thinking"を含まない汎用HTTP 400 (INVALID_ARGUMENT) が返っても thinkingConfig を除外して再試行し成功する', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '記事1' },
    ];
    setupXmlServiceMock(articles);

    const geminiPayloads = [];
    global.UrlFetchApp.fetch.mockImplementation((url, options) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
            ]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
        const parsed = JSON.parse(options.payload);
        geminiPayloads.push(parsed);
        if (parsed.generationConfig && parsed.generationConfig.thinkingConfig) {
          // "thinking" を一切含まない汎用的な INVALID_ARGUMENT レスポンス
          return {
            getContentText: jest.fn(() => JSON.stringify({
              error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' }
            })),
            getResponseCode: jest.fn(() => 400),
          };
        }
        return {
          getContentText: jest.fn(() => JSON.stringify({
            candidates: [{ content: { parts: [{ text: '汎用400から除外再試行で成功' }] } }]
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
    expect(geminiPayloads.length).toBe(2);
    expect(geminiPayloads[0].generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(geminiPayloads[1].generationConfig.thinkingConfig).toBeUndefined();

    const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
    expect(slackCalls.length).toBe(1);
    expect(JSON.parse(slackCalls[0][1].payload).blocks[3].text.text).toContain('汎用400から除外再試行で成功');
  });

  it('先頭モデルが thinkingConfig なしでも HTTP 400 を返した場合、次候補モデルへフォールバックして要約に成功する', () => {
    const articles = [
      { url: 'https://example.com/article1', title: '記事1' },
    ];
    setupXmlServiceMock(articles);

    const triedModels = [];
    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url === mockProps.HATENA_RSS_URL) {
        return {
          getContentText: jest.fn(() => buildRssXml(articles)),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [
              { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
            ]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
        const match = url.match(/models\/([^:]+):generateContent/);
        const model = match ? match[1] : '';
        triedModels.push(model);
        if (model === 'gemini-3.5-flash-lite') {
          return {
            getContentText: jest.fn(() => JSON.stringify({
              error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' }
            })),
            getResponseCode: jest.fn(() => 400),
          };
        }
        return {
          getContentText: jest.fn(() => JSON.stringify({
            candidates: [{ content: { parts: [{ text: '次候補モデルへの400フォールバックで成功' }] } }]
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
    expect(triedModels).toEqual(['gemini-3.5-flash-lite', 'gemini-3.8-flash']);

    const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
    expect(slackCalls.length).toBe(1);
    expect(JSON.parse(slackCalls[0][1].payload).blocks[3].text.text).toContain('次候補モデルへの400フォールバックで成功');
  });

  it('APIキー不正（API_KEY_INVALID）の HTTP 400 エラー時は再試行やフォールバックせず即座にサーキットブレーカーを作動させる', () => {
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
      if (url.includes('models?key=')) {
        return {
          getContentText: jest.fn(() => JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
            ]
          })),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url === articles[0].url || url === articles[1].url) {
        return {
          getContentText: jest.fn(() => '<html><body>' + '十分な長さの記事本文。'.repeat(30) + '</body></html>'),
          getResponseCode: jest.fn(() => 200),
        };
      }
      if (url.includes(':generateContent')) {
        geminiCallCount++;
        return {
          getContentText: jest.fn(() => JSON.stringify({
            error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] }
          })),
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
    expect(geminiCallCount).toBe(1);

    const slackCalls = global.UrlFetchApp.fetch.mock.calls.filter(call => call[0] === mockProps.SLACK_WEBHOOK_URL);
    expect(slackCalls.length).toBe(2);
    expect(JSON.parse(slackCalls[1][1].payload).blocks[3].text.text).toContain('Gemini APIが一時的に利用不可');
  });
});

// ------------------------------------------------------------
// supportsThinkingBudgetZero / isGeminiAuthOrKeyError
// ------------------------------------------------------------
describe('supportsThinkingBudgetZero() & isGeminiAuthOrKeyError()', () => {
  it('gemini-2.5系モデルのみ thinkingBudget: 0 の対象と判定する', () => {
    expect(supportsThinkingBudgetZero('gemini-2.5-flash-lite')).toBe(true);
    expect(supportsThinkingBudgetZero('gemini-2.5-flash')).toBe(true);
    expect(supportsThinkingBudgetZero('gemini-2.5-pro')).toBe(true);
    expect(supportsThinkingBudgetZero('gemini-3.5-flash-lite')).toBe(false);
    expect(supportsThinkingBudgetZero('gemini-3.8-flash')).toBe(false);
    expect(supportsThinkingBudgetZero('gemini-omni-1.2-flash')).toBe(false);
    expect(supportsThinkingBudgetZero('gemini-2.0-flash')).toBe(false);
    expect(supportsThinkingBudgetZero('')).toBe(false);
    expect(supportsThinkingBudgetZero(null)).toBe(false);
  });

  it('APIキー不正や権限エラーのレスポンス本文を正しく判定する', () => {
    expect(isGeminiAuthOrKeyError('{"error":{"message":"API key not valid."}}')).toBe(true);
    expect(isGeminiAuthOrKeyError('{"details":[{"reason":"API_KEY_INVALID"}]}')).toBe(true);
    expect(isGeminiAuthOrKeyError('{"error":{"status":"PERMISSION_DENIED"}}')).toBe(true);
    expect(isGeminiAuthOrKeyError('{"error":{"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}')).toBe(false);
    expect(isGeminiAuthOrKeyError('')).toBe(false);
  });
});

// ------------------------------------------------------------
// extractPlainTextFromHtml / isHtmlOrTextContentType
// ------------------------------------------------------------
describe('extractPlainTextFromHtml() & isHtmlOrTextContentType()', () => {
  it('script / style / noscript タグおよびHTMLタグを除去してプレーンテキストを返す', () => {
    const html = '<html><head><style>body{color:red;}</style><script>const x = 1;</script></head><body><h1>タイトル</h1><noscript>JS無効</noscript><p>本文テキストです。</p></body></html>';
    const text = extractPlainTextFromHtml(html);
    expect(text).toBe('タイトル 本文テキストです。');
  });

  it('閉じタグのない不正なscriptタグや巨大HTMLでもバックトラッキングせず安全に上限文字数で切り詰める', () => {
    const hugeBody = '<p>' + 'あ'.repeat(10000) + '</p>';
    const malformedHtml = hugeBody + '<script>' + 'var a = 1;'.repeat(30000); // 閉じタグなし・300KB超
    const start = Date.now();
    const text = extractPlainTextFromHtml(malformedHtml);
    const elapsed = Date.now() - start;

    expect(text.length).toBe(6000);
    expect(text).not.toContain('var a');
    expect(elapsed).toBeLessThan(1000);
  });

  it('Content-Type がHTML/テキスト系かどうかを正しく判定する', () => {
    expect(isHtmlOrTextContentType('text/html; charset=utf-8')).toBe(true);
    expect(isHtmlOrTextContentType('text/plain')).toBe(true);
    expect(isHtmlOrTextContentType('application/xhtml+xml')).toBe(true);
    expect(isHtmlOrTextContentType('')).toBe(true);
    expect(isHtmlOrTextContentType('application/pdf')).toBe(false);
    expect(isHtmlOrTextContentType('image/png')).toBe(false);
    expect(isHtmlOrTextContentType('application/octet-stream')).toBe(false);
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
    // models.list
    if (url.includes('models?key=')) {
      return {
        getContentText: jest.fn(() => JSON.stringify({
          models: [
            { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
          ]
        })),
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

// ------------------------------------------------------------
// GASエラー通知メール監視 & GitHub Issue 自動起票
// ------------------------------------------------------------
describe('GASエラー通知メール監視・解析・GitHub Issue 自動起票', () => {
  const sampleFailureHtml = `
    <html><body>
      <p>Your script, 無題のプロジェクト, has recently failed to finish successfully.</p>
      <table>
        <tr><th>Start</th><th>Function</th><th>Error Message</th><th>Trigger</th><th>End</th></tr>
        <tr>
          <td>11/22/26 3:36:16 PM JST</td>
          <td>runCron</td>
          <td>Exceeded maximum execution time</td>
          <td>time-based</td>
          <td>11/22/26 3:42:17 PM JST</td>
        </tr>
      </table>
    </body></html>
  `;

  const makeMockMessage = ({
    id = 'msg-1',
    from = 'noreply-apps-scripts-notifications@google.com',
    subject = 'Summary of failures for Google Apps Script: 無題のプロジェクト',
    htmlBody = sampleFailureHtml,
    plainBody = 'fallback plain text',
    date = new Date('2026-11-23T06:42:00.000Z'),
  } = {}) => ({
    getId: jest.fn(() => id),
    getFrom: jest.fn(() => from),
    getSubject: jest.fn(() => subject),
    getBody: jest.fn(() => htmlBody),
    getPlainBody: jest.fn(() => plainBody),
    getDate: jest.fn(() => date),
  });

  const makeMockThread = (messages) => ({
    getMessages: jest.fn(() => messages),
    addLabel: jest.fn(),
  });

  it('extractProjectNameFromFailureSubject() は英語・日本語の件名からプロジェクト名を正しく抽出する', () => {
    expect(extractProjectNameFromFailureSubject('Summary of failures for Google Apps Script: 無題のプロジェクト'))
      .toBe('無題のプロジェクト');
    expect(extractProjectNameFromFailureSubject('Summary of failures for Google Apps Script: ai-hatebu-digest'))
      .toBe('ai-hatebu-digest');
    expect(extractProjectNameFromFailureSubject('Google Apps Script のエラーの概要：my-script'))
      .toBe('my-script');
    expect(extractProjectNameFromFailureSubject('コロンなし件名')).toBe('コロンなし件名');
  });

  it('matchesGasFailureProjectFilter() はカンマ区切りフィルタ・全許可ワイルドカードを正しく判定する', () => {
    expect(matchesGasFailureProjectFilter('ai-hatebu-digest', 'ai-hatebu-digest,無題のプロジェクト')).toBe(true);
    expect(matchesGasFailureProjectFilter('無題のプロジェクト', 'ai-hatebu-digest,無題のプロジェクト')).toBe(true);
    expect(matchesGasFailureProjectFilter('AI-HATEBU-DIGEST', 'ai-hatebu-digest,無題のプロジェクト')).toBe(true);
    expect(matchesGasFailureProjectFilter('other-project', 'ai-hatebu-digest,無題のプロジェクト')).toBe(false);
    expect(matchesGasFailureProjectFilter('any-project', '*')).toBe(true);
    expect(matchesGasFailureProjectFilter('any-project', '')).toBe(true);
  });

  it('parseGasFailureEmail() はHTMLテーブルから単一・複数エラー明細を抽出しエンティティをデコードする', () => {
    const multiRowHtml = `
      <table>
        <tr><td>Start</td><td>Function</td><td>Error Message</td><td>Trigger</td><td>End</td></tr>
        <tr>
          <td>11/22/26 3:36:16 PM JST</td>
          <td>runCron</td>
          <td>Exceeded maximum execution time</td>
          <td>time-based</td>
          <td>11/22/26 3:42:17 PM JST</td>
        </tr>
        <tr>
          <td>11/22/26 4:00:00 PM JST</td>
          <td>doGet</td>
          <td>TypeError: Cannot read &lt;prop&gt; &amp; value</td>
          <td>web-app</td>
          <td>11/22/26 4:00:02 PM JST</td>
        </tr>
      </table>
    `;
    const parsed = parseGasFailureEmail(
      'Summary of failures for Google Apps Script: ai-hatebu-digest',
      multiRowHtml,
      ''
    );
    expect(parsed.projectName).toBe('ai-hatebu-digest');
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toEqual({
      start: '11/22/26 3:36:16 PM JST',
      func: 'runCron',
      errorMessage: 'Exceeded maximum execution time',
      trigger: 'time-based',
      end: '11/22/26 3:42:17 PM JST',
    });
    expect(parsed.entries[1].errorMessage).toBe('TypeError: Cannot read <prop> & value');
    expect(parsed.rawExcerpt).toBe('');
  });

  it('parseGasFailureEmail() はHTMLテーブルが無い場合にプレーンテキスト抜粋へフォールバックする', () => {
    const parsed = parseGasFailureEmail(
      'Summary of failures for Google Apps Script: ai-hatebu-digest',
      '<div>テーブルなし形式</div>',
      'Unexpected failure occurred in runCron'
    );
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.rawExcerpt).toBe('Unexpected failure occurred in runCron');
  });

  it('buildGasFailureIssuePayload() はタイトル・Markdownテーブル本文・任意ラベルを正しく生成する', () => {
    const parsed = parseGasFailureEmail(
      'Summary of failures for Google Apps Script: ai-hatebu-digest',
      sampleFailureHtml,
      ''
    );
    const payload = buildGasFailureIssuePayload(parsed, '2026-11-23T06:42:00.000Z', 'bug, gas-error');
    expect(payload.title).toBe('[GAS Error] runCron: Exceeded maximum execution time (11/22/26 3:36:16 PM JST)');
    expect(payload.body).toContain('| 11/22/26 3:36:16 PM JST | `runCron` | Exceeded maximum execution time | time-based | 11/22/26 3:42:17 PM JST |');
    expect(payload.body).toContain('ai-hatebu-digest');
    expect(payload.labels).toEqual(['bug', 'gas-error']);
  });

  it('processGasFailureEmails() は GITHUB_TOKEN 未設定時に安全にスキップする', () => {
    mockPropStore.GITHUB_TOKEN = '';
    const result = processGasFailureEmails();
    expect(result).toEqual({ checkedThreads: 0, createdIssues: 0, skippedCount: 0 });
    expect(global.GmailApp.search).not.toHaveBeenCalled();
    expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
  });

  it('processGasFailureEmails() は対象プロジェクトのエラー通知からIssueを自動起票し、Slack通知・ID記録・ラベル自動作成付与を行う', () => {
    mockPropStore.GITHUB_TOKEN = 'ghp_test_token';
    mockPropStore.GITHUB_REPO = 'lightyield/ai-hatebu-digest';
    mockPropStore.GITHUB_ISSUE_LABELS = 'bug';

    const msg = makeMockMessage({ id: 'msg-101' });
    const thread = makeMockThread([msg]);
    global.GmailApp.search.mockReturnValue([thread]);
    // ラベルが存在しないケース → createLabel が呼ばれることを検証
    global.GmailApp.getUserLabelByName.mockReturnValue(null);

    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url.includes('api.github.com/repos/lightyield/ai-hatebu-digest/issues')) {
        return {
          getResponseCode: jest.fn(() => 201),
          getContentText: jest.fn(() => JSON.stringify({
            number: 99,
            html_url: 'https://github.com/lightyield/ai-hatebu-digest/issues/99',
          })),
        };
      }
      return {
        getResponseCode: jest.fn(() => 200),
        getContentText: jest.fn(() => 'ok'),
      };
    });

    const result = processGasFailureEmails();
    expect(result).toEqual({ checkedThreads: 1, createdIssues: 1, skippedCount: 0 });

    // GitHub API 呼び出しの検証
    const ghCall = global.UrlFetchApp.fetch.mock.calls.find(([u]) => u.includes('api.github.com'));
    expect(ghCall).toBeDefined();
    expect(ghCall[1].headers.Authorization).toBe('Bearer ghp_test_token');
    const ghBody = JSON.parse(ghCall[1].payload);
    expect(ghBody.title).toContain('[GAS Error] runCron: Exceeded maximum execution time');
    expect(ghBody.labels).toEqual(['bug']);

    // Slack 通知の検証
    const slackCall = global.UrlFetchApp.fetch.mock.calls.find(([u]) => u === 'https://hooks.slack.com/test');
    expect(slackCall).toBeDefined();
    expect(slackCall[1].payload).toContain('https://github.com/lightyield/ai-hatebu-digest/issues/99');

    // 重複防止用メッセージID保存とラベル自動作成・付与の検証
    expect(JSON.parse(mockPropStore.REPORTED_GAS_FAILURE_MSG_IDS)).toEqual(['msg-101']);
    expect(global.GmailApp.createLabel).toHaveBeenCalledWith('gas-failure-reported');
    expect(thread.addLabel).toHaveBeenCalledWith(mockGmailLabel);
  });

  it('processGasFailureEmails() は処理済みメッセージIDを重複起票せず、同一スレッドの新着メッセージのみ起票する', () => {
    mockPropStore.GITHUB_TOKEN = 'ghp_test_token';
    mockPropStore.REPORTED_GAS_FAILURE_MSG_IDS = JSON.stringify(['msg-old']);

    const oldMsg = makeMockMessage({ id: 'msg-old' });
    const newMsg = makeMockMessage({ id: 'msg-new' });
    const thread = makeMockThread([oldMsg, newMsg]);
    global.GmailApp.search.mockReturnValue([thread]);

    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url.includes('api.github.com')) {
        return {
          getResponseCode: jest.fn(() => 201),
          getContentText: jest.fn(() => JSON.stringify({
            number: 100,
            html_url: 'https://github.com/lightyield/ai-hatebu-digest/issues/100',
          })),
        };
      }
      return { getResponseCode: jest.fn(() => 200), getContentText: jest.fn(() => 'ok') };
    });

    const result = processGasFailureEmails();
    expect(result).toEqual({ checkedThreads: 1, createdIssues: 1, skippedCount: 1 });
    const ghCalls = global.UrlFetchApp.fetch.mock.calls.filter(([u]) => u.includes('api.github.com'));
    expect(ghCalls).toHaveLength(1);
    expect(JSON.parse(mockPropStore.REPORTED_GAS_FAILURE_MSG_IDS)).toEqual(['msg-old', 'msg-new']);
  });

  it('processGasFailureEmails() はフィルタ対象外プロジェクトのエラー通知をスキップしラベルも付与しない', () => {
    mockPropStore.GITHUB_TOKEN = 'ghp_test_token';
    mockPropStore.GAS_FAILURE_PROJECT_FILTER = 'ai-hatebu-digest,無題のプロジェクト';

    const otherMsg = makeMockMessage({
      id: 'msg-other',
      subject: 'Summary of failures for Google Apps Script: another-unrelated-project',
    });
    const thread = makeMockThread([otherMsg]);
    global.GmailApp.search.mockReturnValue([thread]);

    const result = processGasFailureEmails();
    expect(result).toEqual({ checkedThreads: 1, createdIssues: 0, skippedCount: 1 });
    expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    expect(thread.addLabel).not.toHaveBeenCalled();
  });

  it('processGasFailureEmails() はGitHub API失敗時にメッセージID記録・ラベル付与を行わず次回再試行可能にする', () => {
    mockPropStore.GITHUB_TOKEN = 'ghp_invalid';

    const msg = makeMockMessage({ id: 'msg-fail' });
    const thread = makeMockThread([msg]);
    global.GmailApp.search.mockReturnValue([thread]);

    global.UrlFetchApp.fetch.mockReturnValue({
      getResponseCode: jest.fn(() => 401),
      getContentText: jest.fn(() => '{"message":"Bad credentials"}'),
    });

    const result = processGasFailureEmails();
    expect(result).toEqual({ checkedThreads: 1, createdIssues: 0, skippedCount: 0 });
    expect(mockPropStore.REPORTED_GAS_FAILURE_MSG_IDS).toBeUndefined();
    expect(thread.addLabel).not.toHaveBeenCalled();
  });

  it('watchGasFailureEmails() は内部で例外が発生しても外に伝播しない', () => {
    mockPropStore.GITHUB_TOKEN = 'ghp_test_token';
    global.GmailApp.search.mockImplementation(() => {
      throw new Error('Gmail temporary failure');
    });
    expect(() => watchGasFailureEmails()).not.toThrow();
  });
});

