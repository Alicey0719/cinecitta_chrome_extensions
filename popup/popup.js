'use strict';

const LEGACY_KEY = 'cinecitta_comments_v1'; // 旧 local storage キー（移行用）
const RECORD_PREFIX = 'cc_r_';              // sync storage のレコードキープレフィックス

// ============================================================
// Storage — chrome.storage.sync を使用（Chrome アカウントで端末間同期）
// ============================================================

function loadAllData() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(null, (syncItems) => {
      const records = {};
      for (const [k, v] of Object.entries(syncItems || {})) {
        if (k.startsWith(RECORD_PREFIX)) {
          records[k.slice(RECORD_PREFIX.length)] = v;
        }
      }

      if (Object.keys(records).length > 0) {
        resolve({ version: 1, records });
        return;
      }

      // sync が空 → 旧 local storage からマイグレーション
      chrome.storage.local.get(LEGACY_KEY, (localResult) => {
        const legacy = localResult[LEGACY_KEY];
        if (!legacy?.records || Object.keys(legacy.records).length === 0) {
          resolve({ version: 1, records: {} });
          return;
        }

        const toSet = {};
        for (const [id, rec] of Object.entries(legacy.records)) {
          toSet[`${RECORD_PREFIX}${id}`] = rec;
        }
        chrome.storage.sync.set(toSet, () => {
          if (!chrome.runtime.lastError) {
            chrome.storage.local.remove(LEGACY_KEY);
          }
          resolve({ version: 1, records: legacy.records });
        });
      });
    });
  });
}

// ============================================================
// ユーティリティ
// ============================================================

function avg(nums) {
  const valid = nums.filter((n) => n > 0);
  if (!valid.length) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function starsHtml(value) {
  if (!value) return '<span class="p-no-data">－</span>';
  const rounded = Math.round(value);
  return (
    '<span class="p-stars">' +
    '★'.repeat(rounded) +
    '☆'.repeat(5 - rounded) +
    `</span> <span class="p-avg">${value.toFixed(1)}</span>`
  );
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// 統計タブ: スクリーン × 座席の集計
// ============================================================

function buildScreenStats(records) {
  /** { [screen]: { [seat]: { seatComfort[], soundQuality[], imageQuality[], comments[] } } } */
  const byScreen = {};

  for (const rec of Object.values(records)) {
    const { screen, seat, screenSeat } = rec;
    if (!screen || !seat) continue;

    byScreen[screen] ??= {};
    byScreen[screen][seat] ??= {
      seatComfort: [],
      soundQuality: [],
      imageQuality: [],
      comments: [],
      count: 0,
    };

    const entry = byScreen[screen][seat];
    entry.count += 1;

    if (screenSeat) {
      if (screenSeat.seatComfort) entry.seatComfort.push(screenSeat.seatComfort);
      if (screenSeat.soundQuality) entry.soundQuality.push(screenSeat.soundQuality);
      if (screenSeat.imageQuality) entry.imageQuality.push(screenSeat.imageQuality);
      if (screenSeat.comment) entry.comments.push(screenSeat.comment);
    }
  }

  return byScreen;
}

function renderStats(records, screenFilter) {
  const container = document.getElementById('stats-container');
  container.innerHTML = '';

  const byScreen = buildScreenStats(records);
  const screens = Object.keys(byScreen).sort();

  if (!screens.length) {
    container.innerHTML =
      '<p class="p-empty"><span class="p-empty-icon">🎭</span>まだデータがありません。<br>購入履歴ページでコメントを追加してください。</p>';
    return;
  }

  // スクリーンフィルター選択肢を更新
  const select = document.getElementById('screen-filter');
  const prev = select.value;
  select.innerHTML = '<option value="">すべて</option>';
  for (const s of screens) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    if (s === prev) opt.selected = true;
    select.appendChild(opt);
  }

  const filtered = screenFilter ? screens.filter((s) => s === screenFilter) : screens;

  for (const screen of filtered) {
    const seatMap = byScreen[screen];
    const seats = Object.keys(seatMap).sort();

    const section = document.createElement('div');
    section.className = 'p-stats-section';

    const heading = document.createElement('h2');
    heading.className = 'p-screen-name';
    heading.textContent = screen;
    section.appendChild(heading);

    const table = document.createElement('table');
    table.className = 'p-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>座席</th>
          <th>訪問</th>
          <th>座席快適さ</th>
          <th>音質</th>
          <th>映像</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector('tbody');
    for (const seat of seats) {
      const d = seatMap[seat];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="p-seat">${escHtml(seat)}</td>
        <td>${d.count}回</td>
        <td>${starsHtml(avg(d.seatComfort))}</td>
        <td>${starsHtml(avg(d.soundQuality))}</td>
        <td>${starsHtml(avg(d.imageQuality))}</td>
      `;
      tbody.appendChild(tr);

      // コメントがあれば次行に展開
      if (d.comments.length) {
        const commentRow = document.createElement('tr');
        commentRow.className = 'p-comment-row';
        const td = document.createElement('td');
        td.colSpan = 5;
        td.innerHTML = d.comments
          .map((c) => `<div class="p-comment-text">💬 ${escHtml(c)}</div>`)
          .join('');
        commentRow.appendChild(td);
        tbody.appendChild(commentRow);
      }
    }

    section.appendChild(table);
    container.appendChild(section);
  }
}

// ============================================================
// 記録タブ: 映画ごとの評価一覧
// ============================================================

function deleteRecord(recordId) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.remove(`${RECORD_PREFIX}${recordId}`, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

function renderRecords(records) {
  const container = document.getElementById('records-container');
  container.innerHTML = '';

  const list = Object.entries(records).sort(
    ([, a], [, b]) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0)
  );

  if (!list.length) {
    container.innerHTML =
      '<p class="p-empty"><span class="p-empty-icon">🎟️</span>まだ記録がありません。</p>';
    return;
  }

  for (const [recordId, rec] of list) {
    const item = document.createElement('div');
    item.className = 'p-record';

    const movieRating = rec.movie?.rating ?? 0;
    const movieStars = movieRating
      ? '★'.repeat(movieRating) + '☆'.repeat(5 - movieRating)
      : '未評価';

    item.innerHTML = `
      <div class="p-record-header">
        <div class="p-record-title">${escHtml(rec.movieTitle ?? '不明')}</div>
        <button class="p-record-delete" title="削除">🗑</button>
      </div>
      <div class="p-record-meta">
        ${escHtml(rec.viewingDate ?? '')}
        ${rec.screen ? `　${escHtml(rec.screen)}` : ''}
        ${rec.seat ? `　${escHtml(rec.seat)}` : ''}
      </div>
      <div class="p-record-rating">映画評価: <span class="p-stars-small">${escHtml(movieStars)}</span></div>
      ${rec.movie?.comment
        ? `<div class="p-record-comment">${escHtml(rec.movie.comment)}</div>`
        : ''}
    `;

    item.querySelector('.p-record-delete').addEventListener('click', async () => {
      if (!confirm(`「${rec.movieTitle ?? '不明'}」のコメントを削除しますか？`)) return;
      try {
        await deleteRecord(recordId);
        item.remove();
        if (!container.querySelector('.p-record')) {
          container.innerHTML =
            '<p class="p-empty"><span class="p-empty-icon">🎟️</span>まだ記録がありません。</p>';
        }
      } catch (err) {
        showDataStatus(`削除失敗: ${err.message}`, true);
      }
    });

    container.appendChild(item);
  }
}

// ============================================================
// データ管理タブ
// ============================================================

function showDataStatus(msg, isError = false) {
  const el = document.getElementById('data-status');
  el.textContent = msg;
  el.className = 'p-data-status ' + (isError ? 'p-data-status--err' : 'p-data-status--ok');
  setTimeout(() => {
    el.textContent = '';
    el.className = 'p-data-status';
  }, 4000);
}

function exportData(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cinecitta_comments_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        if (!imported?.records || typeof imported.records !== 'object') {
          throw new Error('無効なデータ形式です（"records" フィールドが必要です）');
        }

        // 各レコードを sync storage に個別キーで書き込む
        const toSet = {};
        for (const [id, rec] of Object.entries(imported.records)) {
          toSet[`${RECORD_PREFIX}${id}`] = rec;
        }

        chrome.storage.sync.set(toSet, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(Object.keys(imported.records).length);
          }
        });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
    reader.readAsText(file);
  });
}

function clearAllData() {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(null, (items) => {
      const keys = Object.keys(items).filter((k) => k.startsWith(RECORD_PREFIX));
      if (keys.length === 0) { resolve(); return; }
      chrome.storage.sync.remove(keys, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  });
}

// ============================================================
// タブ切り替え
// ============================================================

function initTabs() {
  document.querySelectorAll('.p-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.p-tab').forEach((t) =>
        t.classList.remove('p-tab--active')
      );
      document.querySelectorAll('.p-tab-content').forEach((c) =>
        c.classList.remove('p-tab-content--active')
      );
      tab.classList.add('p-tab--active');
      document.getElementById(`tab-${tab.dataset.tab}`)
        .classList.add('p-tab-content--active');
    });
  });
}

// ============================================================
// 初期化
// ============================================================

async function init() {
  initTabs();

  const data = await loadAllData();
  const records = data.records;

  renderStats(records, '');
  renderRecords(records);

  document.getElementById('screen-filter').addEventListener('change', (e) => {
    renderStats(records, e.target.value);
  });

  document.getElementById('export-btn').addEventListener('click', () => {
    exportData(data);
  });

  document.getElementById('import-btn').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });

  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const count = await importData(file);
      showDataStatus(`✓ ${count}件のデータをインポートしました`);
    } catch (err) {
      showDataStatus(`エラー: ${err.message}`, true);
    }
    e.target.value = '';
  });

  document.getElementById('clear-btn').addEventListener('click', async () => {
    if (
      !confirm(
        'すべてのコメントデータを削除しますか？\nこの操作は元に戻せません。'
      )
    )
      return;
    try {
      await clearAllData();
      showDataStatus('✓ データを削除しました');
    } catch (err) {
      showDataStatus(`エラー: ${err.message}`, true);
    }
  });
}

init();
