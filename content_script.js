// ==================================================================
// == X/Twitter List Tab Navigator
// ==================================================================

(function() {
  'use strict';

  // --- 設定項目 ---
  const SELECTORS = {
    main: 'main[role="main"]',
    timeline: 'div[aria-label^="タイムライン:"]',
    tweetArticle: "article[data-testid='tweet']",
    navigation: 'main[role="main"] nav[role="navigation"]',
    navigationMobile: 'div[data-testid="TopNavBar"] nav[role="navigation"]',
    activeTab: 'a[role="tab"][aria-selected="true"] span',
    userAvatar: "div[data-testid='Tweet-User-Avatar']",
    anchor: 'a[href*="/status/"]',
    timestamp: 'a[href*="/status/"] > time',
    retweet: 'a[role="link"] > span'
  };

  let navigationNode = null;
  let timelineNode = null;
  let currentListName = null;
  let domMutationTimeout = null;
  let intersectionObserver = null;
  let timelineObserver = null;
  let timelineMutationTimeout = null;
  let saveTweetTimeout = null;
  let isScrollingToSaved = false;
  let isInitializing = false;

  let debugMode = false;

  function debugOut(msg) {
    if (debugMode) {
      console.log("[ListNav] " + msg);
    }
  }

  debugOut("拡張機能が読み込まれました");

  // --- ストレージ管理 ---

  async function saveLastTweetIdAndTime(listName, tweetId, tweetTime) {
    debugOut(`🔴 保存処理開始: listName=${listName}, tweetId=${tweetId}, tweetTime=${tweetTime}`);
    // tweetTimeはnull許容(初回を除く)
    if (!listName || !tweetId) {
      debugOut("❗ listNameまたはtweetIdが不正なため保存をスキップ");
      return;
    }
    const key = `list-name-${listName}-time`;
    const result = await browser.storage.sync.get(key);
    const savedTweetIdAndTime = result[key];
    if (!savedTweetIdAndTime) {
      if (!tweetTime) {
        debugOut("❗ 初回はtweetTimeが必須なため保存をスキップ");
        return;
      }
      await browser.storage.sync.set({ [key]: `${tweetTime},${tweetId}` });
      debugOut(`✅ 初回保存完了: リスト名「${listName}」の既読時刻「${tweetTime}」、ID「${tweetId}」を保存しました`);
    } else {
      const splitted = savedTweetIdAndTime.split(',');
      const savedTweetTime = splitted.shift();
      const savedTweetId = splitted.shift();
      // 1. 保存が不要なケースを最初に弾く (ガード節)
      //  - 新しい時刻があり、かつ時刻もIDも前回と全く同じ場合は何もしない
      if (tweetTime && savedTweetTime === tweetTime && savedTweetId === tweetId) {
        debugOut("✅ 前回と同じリスト、時刻のため保存をスキップ");
        return;
      }
      // 2. 保存する値を決定する
      //  - 新しい時刻(tweetTime)があればそれを使い、なければ古い時刻(savedTweetTime)を維持する
      const timeToSave = tweetTime || savedTweetTime;
      // 3. 保存を実行する
      await browser.storage.sync.set({ [key]: `${timeToSave},${tweetId}` });
      // 4. 保存内容に応じたログを出力する
      if (tweetTime) {
        debugOut(`✅ 保存完了: リスト名「${listName}」の既読時刻「${tweetTime}」、ID「${tweetId}」を保存しました`);
      } else {
        debugOut(`✅ 保存完了: リスト名「${listName}」の既読時刻は既存の「${savedTweetTime}」のまま、IDは「${tweetId}」を保存しました`);
      }
    }
  }

  async function getSavedTweetIdAndTime(listName) {
    debugOut(`🔵 取得処理開始: listName=${listName}`);
    const key = `list-name-${listName}-time`;
    const result = await browser.storage.sync.get(key);
    const savedTweetIdAndTime = result[key];
    if (savedTweetIdAndTime) {
      const splitted = savedTweetIdAndTime.split(',');
      const savedTweetTime = splitted.shift();
      const savedTweetId = splitted.shift();
      debugOut(`✅ 取得成功: リスト名「${listName}」の保存済み時刻は「${savedTweetTime}」、IDは「${savedTweetId}」です`);
      return {
        time: savedTweetTime,
        id: savedTweetId
      };
    } else {
      debugOut(`ℹ️ 取得失敗: リスト名「${listName}」の保存済み時刻は見つかりませんでした`);
      return null;
    }
  }

  // --- ユーティリティ関数 ---
  
  function isPromotedTweet(article) {
    const s = article.querySelectorAll("span");
    if (s.length > 0) {
      if (s[s.length - 1].textContent.endsWith("プロモーション")) {
        debugOut("isPromotedTweet: " + s[s.length - 1].textContent + " = true");
        return true;
      }
    }
    return false;
  }

  function isRetweet(article) {
    const s = article.querySelector(SELECTORS.retweet);
    if (s) {
      debugOut("isRetweet: " + s.textContent + " = " + s.textContent.endsWith("リポスト"));
      return s.textContent.endsWith("リポスト");
    } else {
      return false;
    }
  }

  function isParentTweet(article) {
    const c = article.querySelector(SELECTORS.userAvatar).parentNode.childElementCount;
    if (c > 1) {
      debugOut("isParentTweet: true");
      return true;
    }
    return false;
  }

  function getTweetTimestamp(article) {
    const timeElement = article.querySelector(SELECTORS.timestamp);
    if (timeElement) {
      debugOut("timestamp = " + timeElement.getAttribute('datetime'));
      return timeElement.getAttribute('datetime');
    }
    return null;
  }

  function getTweetId(article) {
    const anchorElement = article.querySelector(SELECTORS.anchor);
    if (anchorElement) {
      const m = anchorElement.href && anchorElement.href.match(/\/status\/(\d+)/);
      const id = m ? m[1] : null;
      debugOut("tweet id = " + id);
      return id;
    }
    return null;
  }

  /**
   * IntersectionObserverのコールバック。画面に見えているツイートを検知して保存
   */
  function intersectionCallback(entries) {
    debugOut('intersectionの変化を検知');
    if (isScrollingToSaved) {
      debugOut("➡️ スクロール中のため監視処理をスキップ");
      return;
    }
    
    // 見えているentriesをtopの位置でソートしてから処理する
    const sortedEntries = entries.filter(entry => entry.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

    let topMostValidEntry = null;
    for (const entry of sortedEntries) {
      // プロモーション、親ツイート以外が保存対象
      if (!isPromotedTweet(entry.target) && !isParentTweet(entry.target)) {
        topMostValidEntry = entry;
        break; // 最初の有効なツイートを見つけたらループを抜ける
      }
    }
    
    if (topMostValidEntry) {
      if (currentListName !== getCurrentListNameFromDOM()) {
        debugOut("➡️ タブ切り替え中のため保存処理をスキップ");
        return;
      }
      const listName = currentListName; // debounceに備える
      const tweetId = getTweetId(topMostValidEntry.target);
      let tweetTime = null;
      // Retweetでない場合にのみ時刻を記録
      if (!isRetweet(topMostValidEntry.target)) {
        tweetTime = getTweetTimestamp(topMostValidEntry.target);
      }
      if (listName && tweetId) {
        debugOut(`👀 画面上部に表示されている最も新しい有効なツイートのIDと時刻: ${tweetId},${tweetTime}`);
        clearTimeout(saveTweetTimeout);
        saveTweetTimeout = setTimeout(() => {
          saveLastTweetIdAndTime(listName, tweetId, tweetTime);
        }, 500); // 頻繁な保存を防ぐためのdebounce
      }
    }
  }

  /**
   * タイムラインに新しいツイートが読み込まれた際の処理
   */
  function handleTimelineMutations() {
    debugOut("タイムラインのDOM変更を検知");
    if (timelineNode && timelineNode.isConnected && intersectionObserver) {
      // intersectionObserverをreset
      intersectionObserver.disconnect();
      timelineNode.querySelectorAll(SELECTORS.tweetArticle)
        .forEach(article => intersectionObserver.observe(article));
    }
  }

  /**
   * 特定のリストタブが表示された時に、各種監視を開始する初期化関数
   * @param {string} listName 
   */
  async function initializeForList(listName) {
    debugOut(`🚀 リスト「${listName}」の初期化処理を開始します`);
    
    // 既存のObserverを破棄し、新しいインスタンスを作成する
    if (timelineObserver) {
      timelineObserver.disconnect();
      timelineObserver = null;
    }
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }

    const targetNode = document.querySelector(SELECTORS.main) || document.body;

    try {
      await waitForTimelineToLoad(targetNode);

      // 1. 保存位置までスクロール
      const savedTweet = await getSavedTweetIdAndTime(listName);
      await scrollToTime(savedTweet);

      // 2. IntersectionObserverをセットアップ(observeはまだしない)
      const options = { root: null, rootMargin: '0px', threshold: 0.4 };
      intersectionObserver = new IntersectionObserver(intersectionCallback, options);
      debugOut("✅ IntersectionObserverをセットアップしました");

      // 3. currentListName更新
      currentListName = listName;

      // 4. タイムラインのDOM変更監視をセットアップ(intersection observeも開始)
      timelineNode = targetNode.querySelector(SELECTORS.timeline);
      if (timelineNode) {
        timelineObserver = new MutationObserver(() => {
          // debounce
          clearTimeout(timelineMutationTimeout);
          timelineMutationTimeout = setTimeout(handleTimelineMutations, 300);
        });
        timelineObserver.observe(timelineNode, { childList: true, subtree: true });
        debugOut("✅ タイムラインのDOM変更監視を開始しました");
      }
    } catch (error) {
      console.error(`[ListNav] ❗ リスト初期化処理でエラー: ${error.message}`);
    }
  }

  /**
   * 目的のツイートまでスクロール
   */
  async function scrollToTime(targetTweet) {
    if (!targetTweet) {
      debugOut('ℹ️ 保存された時刻が見つからないため、スクロールをスキップします');
      return;
    }

    debugOut(`⬇️ スクロール処理開始: 目的のID=${targetTweet.id}、時刻=${targetTweet.time}`);
    
    isScrollingToSaved = true;
    debugOut(`🔍 目的のID「${targetTweet.id}」、および時刻「${targetTweet.time}」を検索中...`);

    let found = false;
    let retries = 0;
    const maxRetries = 100;
    const retryInterval = 500;
    
    const targetDate = new Date(targetTweet.time);
    const targetNode = document.querySelector(SELECTORS.main) || document.body;

    while (!found && retries < maxRetries) {
      const articles = targetNode.querySelectorAll(SELECTORS.tweetArticle);
      let foundArticle = null;
      
      for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        if (!isPromotedTweet(article)) {
          const articleId = getTweetId(article);
          if (articleId === targetTweet.id) {
            foundArticle = article;
            break;
          }
          if (!isRetweet(article) && !isParentTweet(article)) {
            const articleTime = getTweetTimestamp(article);
            if (articleTime) {
              const articleDate = new Date(articleTime);
              if (articleDate.getTime() === targetDate.getTime()) {
                foundArticle = article;
                break;
              } else if (articleDate.getTime() < targetDate.getTime()) {
                foundArticle = articles[i > 0 ? i - 1 : 0];
                break;
              }
            }
          }
        }
      }
      
      if (foundArticle) {
        debugOut('✅ 目的の地点に到達しました。画面内までスクロールします');
        const targetPosition = foundArticle.getBoundingClientRect().top + window.scrollY - 150;
        window.scrollTo({ top: targetPosition, behavior: 'smooth' });
        foundArticle.style.boxShadow = "inset 0 0 10px 5px white";
        setTimeout(() => { foundArticle.style.boxShadow = "none"; }, 1500);
        found = true;
      } else {
        debugOut(`🔄 見つかりません。下へスクロールしてさらに読み込みます... (試行回数: ${retries + 1}/${maxRetries})`);
        articles[articles.length - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
        retries++;
        await new Promise(resolve => setTimeout(resolve, retryInterval));
      }
    }

    if (!found) {
      debugOut('⚠️ 指定された時刻のツイートが見つかりませんでした');
    }
    
    isScrollingToSaved = false;
  }

  // --- 初期化とDOM監視 ---
  
  function waitForTimelineToLoad(baseNode) {
    debugOut(`⬇️ タイムラインの読み込み待ち……`);
    return new Promise((resolve, reject) => {
      let checkAttempts = 0;
      const maxAttempts = 30;
      const interval = 500;
      
      const check = () => {
        const timeline = baseNode.querySelector(SELECTORS.timeline);
        const articles = baseNode.querySelectorAll(SELECTORS.tweetArticle);
        if (timeline && articles.length > 0) {
          debugOut("✅ タイムラインの読み込みを確認しました");
          resolve();
        } else if (checkAttempts >= maxAttempts) {
          debugOut("❗ タイムラインの読み込みがタイムアウトしました");
          reject(new Error('Timeline load timeout.'));
        } else {
          checkAttempts++;
          setTimeout(check, interval);
        }
      };
      check();
    });
  }

  function getCurrentListNameFromDOM() {
    if (!window.location.pathname.startsWith('/home')) {
      debugOut("ℹ️ ホームではありません");
      return null;
    }

    if (!navigationNode || !navigationNode.isConnected) {
      navigationNode = document.querySelector(SELECTORS.navigation);
      if (!navigationNode) {
        navigationNode = document.querySelector(SELECTORS.navigationMobile);
        if (!navigationNode) {
          debugOut("ℹ️ ナビゲーションタブが見つかりません");
          return null;
        }
      }
    }

    const activeTabSpan = navigationNode.querySelector(SELECTORS.activeTab);
    if (!activeTabSpan) {
      debugOut("ℹ️ アクティブなタブが見つかりません");
      return null;
    }
    
    const tabName = activeTabSpan.textContent;
    if (tabName) {
      debugOut(`✅ アクティブなタブ名を特定: ${tabName}`);
      return tabName;
    }
    
    debugOut('❗ リストタブではないか、タブ名が特定できませんでした');
    return null;
  }

  /**
   * 全体の監視役。主にタブの切り替えを検知する
   */
  async function runCheck() {
    debugOut(`🔄 runCheck実行...`);
    const listName = getCurrentListNameFromDOM();

    if (listName) {
      // 新しいリストタブに切り替わった場合
      if (listName !== currentListName && !isInitializing) {
        isInitializing = true;
        debugOut(`✅ リストタブの切り替えを検出: ${currentListName || 'なし'} -> ${listName}`);
        // 一旦監視を止める
        mainObserver.disconnect();
        // 既読点復帰
        try {
          await initializeForList(listName);
        } finally {
          isInitializing = false;
        }
        // mainNodeの監視を再開
        const mainNode = document.querySelector(SELECTORS.main) || document.body;
        mainObserver.observe(mainNode, { childList: true, subtree: true });
        debugOut(`DOM変更監視を再開しました。対象: ${mainNode.tagName}`);
      }
    } else {
      // リスト以外のページに移動した場合
      if (currentListName) {
        debugOut(`ℹ️ リスト表示が終了したため、各種監視を停止します`);
        currentListName = null;
        if (intersectionObserver) {
          intersectionObserver.disconnect();
          intersectionObserver = null;
        }
        if (timelineObserver) {
          timelineObserver.disconnect();
          timelineObserver = null;
        }
      }
    }
  }

  // 監視を開始
  const mainObserver = new MutationObserver(() => {
    // debounce処理
    clearTimeout(domMutationTimeout);
    domMutationTimeout = setTimeout(runCheck, 250);
  });

  // 少し待ってから監視対象を探す
  setTimeout(() => {
    const mainNode = document.querySelector(SELECTORS.main) || document.body;
    mainObserver.observe(mainNode, { childList: true, subtree: true });
    debugOut(`DOM変更監視を開始しました。対象: ${mainNode.tagName}`);
    
    // 初回実行
    runCheck();
  }, 1500);

})();
