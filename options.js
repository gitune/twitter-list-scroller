document.addEventListener('DOMContentLoaded', () => {
  const clearDataButton = document.getElementById('clear-data-button');
  const statusMessage = document.getElementById('status-message');

  clearDataButton.addEventListener('click', async () => {
    // ユーザーに確認を求める
    const confirmDelete = confirm('本当にすべてのデータを削除しますか？この操作は元に戻せません。');

    if (confirmDelete) {
      try {
        await browser.storage.local.clear(); // 今はlocal利用していないが念のため
        await browser.storage.sync.clear();
        statusMessage.textContent = '✅ データが正常に削除されました。';
        statusMessage.style.color = 'green';
      } catch (error) {
        statusMessage.textContent = `❌ データの削除に失敗しました: ${error.message}`;
        statusMessage.style.color = 'red';
        console.error('Error clearing data:', error);
      }
    } else {
      statusMessage.textContent = 'データの削除はキャンセルされました。';
      statusMessage.style.color = 'blue';
    }
  });
});
