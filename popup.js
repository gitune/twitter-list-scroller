document.getElementById("openOptions").addEventListener("click", () => {
  if (browser.runtime.openOptionsPage) {
    // デスクトップ版では標準のオプションページ呼び出し
    browser.runtime.openOptionsPage();
  } else {
    // Androidなど対応していない場合は自前でタブを開く
    browser.tabs.create({
      url: browser.runtime.getURL("options.html")
    });
  }
});
