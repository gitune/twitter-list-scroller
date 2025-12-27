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
    activeTab: 'div[role="tab"][aria-selected="true"] span',
    userAvatar: "div[data-testid='Tweet-User-Avatar']",
    anchor: 'a[href*="/status/"]',
    timestamp: 'a[href*="/status/"] > time',
    retweet: 'a[role="link"] > span'
  };
  // 除外するタブ名
  const EXCLUDED_TABS = [ "おすすめ" ];

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

  // スクロール中断制御用
  let scrollAbortController = null;

  let debugMode = true;

  function debugOut(msg) {
    if (debugMode) {
      console.log("[ListNav] " + msg);
    }
  }

  debugOut("拡張機能が読み込まれました");

  // --- ストレージ管理 ---

  async function saveLastTweetIdAndTime(listName, tweetId, tweetTime) {
    debugOut(`🔴 保存処理開始: listName=${listName}, tweetId=${tweetId}, tweetTime=${tweetTime}`);
    if (!listName || !tweetId) {
      debugOut("❗ listNameまたはtweetIdが不正なため保存をスキップ");
      return;
    }
    const key = `list-name-${listName}-time`;
    const result = await browser.storage.sync.get(key);
    const savedTweetIdAndTime = result[key];
    if (!savedTweetIdAndTime) {
      // まだ保存されていない場合
      if (!tweetTime) {
        debugOut("❗ 初回はtweetTimeが必須なため保存をスキップ");
        return;
      }
      await browser.storage.sync.set({ [key]: `${tweetTime},${tweetId}` });
      debugOut(`✅ 初回保存完了: リスト名「${listName}」の既読時刻「${tweetTime}」、ID「${tweetId}」を保存しました`);
    } else {
      // 既に保存されている場合
      const splitted = savedTweetIdAndTime.split(',');
      const savedTweetTime = splitted.shift();
      const savedTweetId = splitted.shift();
      // 内容が同じならスキップ
      if (tweetTime && savedTweetTime === tweetTime && savedTweetId === tweetId) {
        debugOut("✅ 前回と同じリスト、時刻のため保存をスキップ");
        return;
      }
      // 時刻が取れない（リポストなど）場合は、既存の時刻を維持してIDだけ更新する
      const timeToSave = tweetTime || savedTweetTime;
      await browser.storage.sync.set({ [key]: `${timeToSave},${tweetId}` });
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
    const s = Array.from(article.querySelectorAll("span")).find(span => span.textContent.trim() === '広告');
    if (s != null) {
      debugOut("isPromotedTweet: " + s.textContent + " = true");
      return true;
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
    const avatar = article.querySelector(SELECTORS.userAvatar);
    if (avatar && avatar.parentNode) {
      const c = avatar.parentNode.childElementCount;
      if (c > 1) {
        debugOut("isParentTweet: true");
        return true;
      }
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

  // 手動操作による中断を検知するリスナー
  function setupManualScrollAbort() {
    const abortOnUserAction = () => {
      if (scrollAbortController) {
        debugOut("✋ ユーザー操作（スクロール/キー入力）を検知したため、自動スクロールを中断します");
        scrollAbortController.abort();
      }
      // 一度検知したらイベントリスナーを削除
      window.removeEventListener('wheel', abortOnUserAction);
      window.removeEventListener('touchmove', abortOnUserAction);
      window.removeEventListener('keydown', abortOnUserAction);
    };

    window.addEventListener('wheel', abortOnUserAction, { passive: true });
    window.addEventListener('touchmove', abortOnUserAction, { passive: true });
    window.addEventListener('keydown', abortOnUserAction, { passive: true });
  }

  function intersectionCallback(entries) {
    debugOut('intersectionの変化を検知');
    if (isScrollingToSaved) {
      debugOut("➡️ スクロール中のため監視処理をスキップ");
      return;
    }
    
    // 画面内にあり、かつ一定以上の割合が表示されているツイートを抽出
    const sortedEntries = entries
      .filter(entry => entry.isIntersecting && entry.intersectionRatio >= 0.8)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

    // 有効な（広告やリプライ親でない）ツイートのうち、最も上にあるものを探す
    let topMostValidEntry = null;
    for (const entry of sortedEntries) {
      if (!isPromotedTweet(entry.target) && !isParentTweet(entry.target)) {
        topMostValidEntry = entry;
        break;
      }
    }
    
    if (topMostValidEntry) {
      // 念のため、現在のタブ名と一致するか確認
      if (currentListName !== getCurrentListNameFromDOM()) {
        debugOut("➡️ タブ切り替え中のため保存処理をスキップ");
        return;
      }
      const listName = currentListName;
      const tweetId = getTweetId(topMostValidEntry.target);
      let tweetTime = null;
      // リポストの場合は時刻を更新しない（取得しない）
      if (!isRetweet(topMostValidEntry.target)) {
        tweetTime = getTweetTimestamp(topMostValidEntry.target);
      }
      if (listName && tweetId) {
        debugOut(`👀 画面上部に表示されている最も新しい有効なツイートのIDと時刻: ${tweetId},${tweetTime}`);
        // 短時間に何度も保存しないようdebounce
        clearTimeout(saveTweetTimeout);
        saveTweetTimeout = setTimeout(() => {
          saveLastTweetIdAndTime(listName, tweetId, tweetTime);
        }, 500);
      }
    }
  }

  function handleTimelineMutations() {
    debugOut("タイムラインのDOM変更を検知");
    if (timelineNode && timelineNode.isConnected && intersectionObserver) {
      // タイムラインの内容が変わったら監視対象を更新する
      intersectionObserver.disconnect();
      timelineNode.querySelectorAll(SELECTORS.tweetArticle)
        .forEach(article => intersectionObserver.observe(article));
    }
  }

  async function initializeForList(listName, targetNode) {
    debugOut(`🚀 リスト「${listName}」の初期化処理を開始します`);
    try {
      // タイムラインの読み込みを待つ
      await waitForTimelineToLoad(targetNode);
      // 保存された情報を取得
      const savedTweet = await getSavedTweetIdAndTime(listName);
      // スクロール実行
      await scrollToTime(savedTweet, targetNode);
      // 初期化が終わったリスト名を保持
      currentListName = listName;
    } catch (error) {
      console.error(`[ListNav] ❗ リスト初期化処理でエラー: ${error.message}`);
    }
  }

  function stopObservers() {
    // スクロール処理を中断
    if (scrollAbortController) {
      debugOut("ℹ️ オブザーバー停止に伴いスクロール処理を中断します");
      scrollAbortController.abort();
      scrollAbortController = null;
    }
    if (timelineObserver) {
      timelineObserver.disconnect();
      timelineObserver = null;
    }
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }
  }

  function startObservers(targetNode) {
    const options = { root: null, rootMargin: '0px', threshold: 0.8 };
    intersectionObserver = new IntersectionObserver(intersectionCallback, options);
    debugOut("✅ IntersectionObserverをセットアップしました (閾値:0.8)");

    timelineNode = targetNode.querySelector(SELECTORS.timeline);
    if (timelineNode) {
      timelineObserver = new MutationObserver(() => {
        // 頻繁な発生を抑えるためdebounce
        clearTimeout(timelineMutationTimeout);
        timelineMutationTimeout = setTimeout(handleTimelineMutations, 300);
      });
      timelineObserver.observe(timelineNode, { childList: true, subtree: true });
      debugOut("✅ タイムラインのDOM変更監視を開始しました");
    }
  }

  /**
   * 目的のツイートまでスクロール（無限ループ・中断対応版）
   */
  async function scrollToTime(targetTweet, targetNode) {
    if (!targetTweet) {
      debugOut('ℹ️ 保存された時刻が見つからないため、スクロールをスキップします');
      return;
    }

    // 進行中のスクロールがあれば中断
    if (scrollAbortController) {
      scrollAbortController.abort();
    }
    scrollAbortController = new AbortController();
    const signal = scrollAbortController.signal;

    // 手動操作監視の開始
    setupManualScrollAbort();

    debugOut(`⬇️ スクロール処理開始: 目的のID=${targetTweet.id}、時刻=${targetTweet.time}`);
    
    isScrollingToSaved = true;
    debugOut(`🔍 目的のID「${targetTweet.id}」、および時刻「${targetTweet.time}」を検索中...`);

    let found = false;
    let retries = 0; // ログ用（リミットとしては使用しない）
    const retryInterval = 250;
    const targetDate = new Date(targetTweet.time);

    try {
      while (!found) {
        // 中断信号のチェック
        if (signal.aborted) {
          debugOut('🛑 スクロール処理が外部またはユーザー操作により中断されました');
          return;
        }

        const articles = targetNode.querySelectorAll(SELECTORS.tweetArticle);
        let foundArticle = null;

        for (let i = 0; i < articles.length; i++) {
          const article = articles[i];
          if (!isPromotedTweet(article) && !isParentTweet(article)) {
            const articleId = getTweetId(article);
            if (articleId === targetTweet.id) {
              foundArticle = article;
              break;
            }
            if (!isRetweet(article)) {
              const articleTime = getTweetTimestamp(article);
              if (articleTime) {
                const articleDate = new Date(articleTime);
                if (articleDate.getTime() === targetDate.getTime()) {
                  // 保存時刻にピッタリ一致した場合
                  foundArticle = article;
                  break;
                } else if (articleDate.getTime() < targetDate.getTime()) {
                  // 保存時刻を追い越した場合（目的のツイートが消されている可能性など）
                  // 一つ前の記事を目的地とする
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
          // 対象を一時的に強調表示
          foundArticle.classList.add('list-nav-highlight');
          setTimeout(() => {
              foundArticle.classList.remove('list-nav-highlight');
          }, 1500);
          found = true;
        } else {
          // 見つからない場合は下部を読み込ませるために少しスクロールして待つ
          debugOut(`🔄 見つかりません。下へスクロールしてさらに読み込みます... (試行回数: ${retries + 1})`);
          if (articles.length > 0) {
            articles[articles.length - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          retries++;
          await new Promise(resolve => setTimeout(resolve, retryInterval));
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        debugOut('ℹ️ スクロール処理が正常に中断されました');
      } else {
        console.error(`[ListNav] ❗ スクロールエラー: ${err.message}`);
      }
    } finally {
      isScrollingToSaved = false;
      if (scrollAbortController?.signal === signal) {
        scrollAbortController = null;
      }
    }
  }

  function waitForTimelineToLoad(baseNode) {
    debugOut(`⬇️ タイムラインの読み込み待ち……`);
    return new Promise((resolve, reject) => {
      let checkAttempts = 0;
      const maxAttempts = 30; // 15秒程度待つ
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
      navigationNode = document.querySelector(SELECTORS.navigation) || document.querySelector(SELECTORS.navigationMobile);
      if (!navigationNode) {
        debugOut("ℹ️ ナビゲーションタブが見つかりません");
        return null;
      }
    }

    const activeTabSpan = navigationNode.querySelector(SELECTORS.activeTab);
    if (!activeTabSpan) {
      debugOut("ℹ️ アクティブなタブが見つかりません");
      return null;
    }
    
    const tabName = activeTabSpan.textContent;
    // 除外対象のタブなら無視
    if (EXCLUDED_TABS.includes(tabName)) {
      debugOut(`ℹ️ 除外対象タブです: ${tabName}`);
      return null;
    }
    if (tabName) {
      debugOut(`✅ アクティブなタブ名を特定: ${tabName}`);
      return tabName;
    }
    
    debugOut('❗ リストタブではないか、タブ名が特定できませんでした');
    return null;
  }

  async function runCheck() {
    debugOut(`🔄 runCheck実行...`);
    const listName = getCurrentListNameFromDOM();

    if (listName) {
      const targetNode = document.querySelector(SELECTORS.main) || document.body;
      // 新しいリストタブに切り替わった場合
      if (listName !== currentListName && !isInitializing) {
        isInitializing = true;
        debugOut(`✅ リストタブの切り替えを検出: ${currentListName || 'なし'} -> ${listName}`);
        // 一旦監視を止める
        stopObservers();
        mainObserver.disconnect();
        // 既読点復帰
        try {
          await initializeForList(listName, targetNode);
        } finally {
          isInitializing = false;
        }
        // mainNodeの監視を再開
        const mainNode = document.querySelector(SELECTORS.main) || document.body;
        mainObserver.observe(mainNode, { childList: true, subtree: true });
        debugOut(`DOM変更監視を再開しました。対象: ${mainNode.tagName}`);
      }
      // observerが停止していたら再開
      if (!timelineObserver) {
        startObservers(targetNode);
      }
    } else {
      // リスト以外のページに移動した場合
      debugOut(`ℹ️ リスト表示が終了したため、各種監視を停止します`);
      stopObservers();
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
    runCheck();
  }, 1500);

})();
