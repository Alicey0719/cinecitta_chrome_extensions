(function () {
  'use strict';

  const LEGACY_KEY = 'cinecitta_comments_v1'; // 旧 local storage キー（移行用）
  const RECORD_PREFIX = 'cc_r_';              // sync storage のレコードキープレフィックス
  const PROCESSED_ATTR = 'data-cc-processed';

  // ============================================================
  // DOM parsing
  // ============================================================

  /**
   * 購入履歴アイテムを全件探す。
   * 「スクリーン情報」というテキストノードのみを持つ div を起点に
   * 親コンテナを辿る。styled-components のハッシュクラスには依存しない。
   */
  function extractHistoryItems() {
    const results = [];

    for (const div of document.querySelectorAll('div')) {
      // 子要素を持たない（テキストノードのみ）かつ「スクリーン情報」
      if (div.children.length !== 0) continue;
      if (div.textContent.trim() !== 'スクリーン情報') continue;

      const infoContainer = div.parentElement;
      if (!infoContainer) continue;

      // 3階層上が各履歴アイテムのラッパー
      // infoContainer → flex layout → inner wrapper → item wrapper
      const itemWrapper =
        infoContainer.parentElement?.parentElement?.parentElement;
      if (!itemWrapper) continue;
      if (itemWrapper.hasAttribute(PROCESSED_ATTR)) continue;

      const data = parseInfoContainer(infoContainer, div);
      if (!data) continue;

      results.push({ data, itemWrapper });
    }

    return results;
  }

  /**
   * 情報コンテナから映画タイトル・日時・スクリーン・座席を取り出す。
   * @param {Element} infoContainer
   * @param {Element} screenInfoLabel 「スクリーン情報」ラベル要素
   */
  function parseInfoContainer(infoContainer, screenInfoLabel) {
    const children = Array.from(infoContainer.children);
    const labelIdx = children.indexOf(screenInfoLabel);
    if (labelIdx < 1) return null;

    // 「スクリーン情報」の直前の子が映画タイトル
    const movieTitle = children[labelIdx - 1]?.textContent?.trim();
    if (!movieTitle) return null;

    // 「スクリーン情報」の次の子がスクリーン値
    const screen = children[labelIdx + 1]?.textContent?.trim() ?? '';

    // 「座席情報」ラベルの次の子が座席値
    let seat = '';
    for (let i = labelIdx + 2; i < children.length - 1; i++) {
      if (children[i].children.length === 0 &&
          children[i].textContent.trim() === '座席情報') {
        // 値には末尾に空の <span> が入ることがあるので最初のテキストノードを優先
        const valueEl = children[i + 1];
        seat =
          valueEl?.childNodes[0]?.textContent?.trim() ||
          valueEl?.textContent?.trim() ||
          '';
        break;
      }
    }

    // 最初の子要素が日時行（内部に「鑑賞日時」span を含む）
    const viewingDate =
      children[0]?.textContent?.replace('鑑賞日時', '').trim() ?? '';

    return { movieTitle, viewingDate, screen, seat };
  }

  // ============================================================
  // Record ID
  // ============================================================

  function createRecordId({ movieTitle, viewingDate, screen, seat }) {
    const raw = `${viewingDate}|${screen}|${seat}|${movieTitle}`;
    // djb2 ハッシュ（衝突確率は許容できる程度）
    let h = 5381;
    for (let i = 0; i < raw.length; i++) {
      h = Math.imul(h, 33) ^ raw.charCodeAt(i);
    }
    return (h >>> 0).toString(36);
  }

  // ============================================================
  // Storage
  // ============================================================

  // sync storage からレコードを全件読み込む。
  // sync が空なら旧 local storage を確認して自動マイグレーションする。
  function loadAllData() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(null, (syncItems) => {
        if (chrome.runtime.lastError) {
          resolve({ version: 1, records: {} });
          return;
        }
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

  function saveRecord(recordId, recordData, comments) {
    const record = {
      movieTitle: recordData.movieTitle,
      viewingDate: recordData.viewingDate,
      screen: recordData.screen,
      seat: recordData.seat,
      movie: comments.movie,
      screenSeat: comments.screenSeat,
      updatedAt: new Date().toISOString(),
    };
    return new Promise((resolve, reject) => {
      chrome.storage.sync.set({ [`${RECORD_PREFIX}${recordId}`]: record }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }

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

  // ============================================================
  // UI: 星評価ウィジェット
  // ============================================================

  function createStarRating(initialValue) {
    const container = document.createElement('div');
    container.className = 'cc-stars';
    container.dataset.value = String(initialValue);

    function refresh(hoverValue) {
      const v = hoverValue ?? parseInt(container.dataset.value, 10);
      container.querySelectorAll('.cc-star').forEach((s, i) => {
        s.classList.toggle('cc-star--on', i < v);
      });
    }

    for (let i = 1; i <= 5; i++) {
      const star = document.createElement('span');
      star.className = 'cc-star' + (i <= initialValue ? ' cc-star--on' : '');
      star.dataset.v = String(i);
      star.textContent = '★';
      star.addEventListener('click', () => {
        const cur = parseInt(container.dataset.value, 10);
        container.dataset.value = String(cur === i ? 0 : i);
        refresh();
      });
      star.addEventListener('mouseover', () => refresh(i));
      star.addEventListener('mouseout', () => refresh());
      container.appendChild(star);
    }

    return container;
  }

  function getStarValue(starsEl) {
    return parseInt(starsEl.dataset.value, 10) || 0;
  }

  // ============================================================
  // UI: コメントパネル
  // ============================================================

  function createCommentPanel(recordId, recordData, saved) {
    const hasComment = !!(
      saved?.movie?.rating ||
      saved?.movie?.comment ||
      saved?.screenSeat?.seatComfort
    );

    const panel = document.createElement('div');
    panel.className = 'cc-panel';

    // トグルボタン
    const toggle = document.createElement('button');
    toggle.className = 'cc-toggle' + (hasComment ? ' cc-toggle--has-data' : '');
    toggle.innerHTML =
      `<span class="cc-toggle-label">💬 コメントを${hasComment ? '編集' : '追加'}する</span>` +
      `<span class="cc-toggle-arrow">▼</span>`;

    // 本体（折りたたみ）
    const body = document.createElement('div');
    body.className = 'cc-body';

    // ── 映画の評価 ──
    const movieSec = document.createElement('div');
    movieSec.className = 'cc-section';
    movieSec.innerHTML = '<div class="cc-section-title">🎬 映画の評価</div>';

    const movieRatingRow = document.createElement('div');
    movieRatingRow.className = 'cc-row';
    movieRatingRow.innerHTML = '<label class="cc-label">総合評価</label>';
    const movieStars = createStarRating(saved?.movie?.rating ?? 0);
    movieRatingRow.appendChild(movieStars);
    movieSec.appendChild(movieRatingRow);

    const movieTextarea = document.createElement('textarea');
    movieTextarea.className = 'cc-textarea';
    movieTextarea.placeholder = '映画についての感想・メモ...';
    movieTextarea.value = saved?.movie?.comment ?? '';
    movieSec.appendChild(movieTextarea);

    // ── スクリーン・座席の評価 ──
    const screenSec = document.createElement('div');
    screenSec.className = 'cc-section';
    screenSec.innerHTML =
      `<div class="cc-section-title">🎭 ${recordData.screen} 座席: ${recordData.seat}</div>`;

    const screenRatings = {
      seatComfort: createStarRating(saved?.screenSeat?.seatComfort ?? 0),
      soundQuality: createStarRating(saved?.screenSeat?.soundQuality ?? 0),
      imageQuality: createStarRating(saved?.screenSeat?.imageQuality ?? 0),
    };
    const ratingLabels = {
      seatComfort: '座席の快適さ',
      soundQuality: '音質',
      imageQuality: '映像品質',
    };

    for (const [key, label] of Object.entries(ratingLabels)) {
      const row = document.createElement('div');
      row.className = 'cc-row';
      row.innerHTML = `<label class="cc-label">${label}</label>`;
      row.appendChild(screenRatings[key]);
      screenSec.appendChild(row);
    }

    const screenTextarea = document.createElement('textarea');
    screenTextarea.className = 'cc-textarea';
    screenTextarea.placeholder = `${recordData.screen} スクリーンについてのメモ（音響の特性、見やすいエリアなど）...`;
    screenTextarea.value = saved?.screenSeat?.comment ?? '';
    screenSec.appendChild(screenTextarea);

    // ── 保存ボタン & ステータス ──
    const footer = document.createElement('div');
    footer.className = 'cc-footer';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'cc-save-btn';
    saveBtn.textContent = '保存する';

    const statusEl = document.createElement('span');
    statusEl.className = 'cc-status';

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await saveRecord(recordId, recordData, {
          movie: {
            rating: getStarValue(movieStars),
            comment: movieTextarea.value.trim(),
          },
          screenSeat: {
            seatComfort: getStarValue(screenRatings.seatComfort),
            soundQuality: getStarValue(screenRatings.soundQuality),
            imageQuality: getStarValue(screenRatings.imageQuality),
            comment: screenTextarea.value.trim(),
          },
        });
        statusEl.textContent = '✓ 保存しました';
        statusEl.className = 'cc-status cc-status--ok';
        toggle.classList.add('cc-toggle--has-data');
        toggle.querySelector('.cc-toggle-label').textContent =
          '💬 コメントを編集する';
      } catch (err) {
        statusEl.textContent = `保存失敗: ${err.message}`;
        statusEl.className = 'cc-status cc-status--err';
      } finally {
        saveBtn.disabled = false;
        setTimeout(() => {
          statusEl.textContent = '';
          statusEl.className = 'cc-status';
        }, 3000);
      }
    });

    footer.appendChild(saveBtn);
    footer.appendChild(statusEl);

    // 削除ボタン（既存コメントがある場合のみ表示）
    if (hasComment) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'cc-delete-btn';
      deleteBtn.textContent = '削除';
      deleteBtn.addEventListener('click', async () => {
        if (!confirm('このコメントを削除しますか？')) return;
        try {
          await deleteRecord(recordId);
          // フォームをリセット
          [movieStars, ...Object.values(screenRatings)].forEach((s) => {
            s.dataset.value = '0';
            s.querySelectorAll('.cc-star').forEach((el) => el.classList.remove('cc-star--on'));
          });
          movieTextarea.value = '';
          screenTextarea.value = '';
          // トグルを「追加する」状態に戻す
          toggle.classList.remove('cc-toggle--has-data');
          toggle.querySelector('.cc-toggle-label').textContent = '💬 コメントを追加する';
          // パネルを閉じて削除ボタンを消す
          body.classList.remove('cc-body--open');
          toggle.querySelector('.cc-toggle-arrow').textContent = '▼';
          deleteBtn.remove();
        } catch (err) {
          alert('削除に失敗しました: ' + err.message);
        }
      });
      footer.appendChild(deleteBtn);
    }

    body.appendChild(movieSec);
    body.appendChild(screenSec);
    body.appendChild(footer);

    // 開閉トグル
    toggle.addEventListener('click', () => {
      const isOpen = body.classList.contains('cc-body--open');
      body.classList.toggle('cc-body--open', !isOpen);
      toggle.querySelector('.cc-toggle-arrow').textContent = isOpen ? '▼' : '▲';
    });

    panel.appendChild(toggle);
    panel.appendChild(body);
    return panel;
  }

  // ============================================================
  // メイン処理
  // ============================================================

  let processing = false;

  async function processHistoryItems() {
    if (processing) return;
    processing = true;
    try {
      const items = extractHistoryItems();
      if (items.length === 0) return;

      const allData = await loadAllData();

      for (const { data, itemWrapper } of items) {
        const recordId = createRecordId(data);
        const saved = allData.records[recordId] ?? null;

        const panel = createCommentPanel(recordId, data, saved);
        itemWrapper.appendChild(panel);
        itemWrapper.setAttribute(PROCESSED_ATTR, 'true');
      }
    } finally {
      processing = false;
    }
  }

  // ============================================================
  // SPA 対応: 動的レンダリング & ルーティング変化を監視
  // ============================================================

  let debounceTimer = null;

  function isHistoryPage() {
    return window.location.pathname.startsWith('/purchase/history');
  }

  function scheduleProcess() {
    if (!isHistoryPage()) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processHistoryItems, 400);
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((m) => m.addedNodes.length > 0)) {
      scheduleProcess();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // sync データが後から届いたときにパネルを再描画する
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (!Object.keys(changes).some((k) => k.startsWith(RECORD_PREFIX))) return;
    if (!isHistoryPage()) return;
    document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
      el.removeAttribute(PROCESSED_ATTR);
      el.querySelector('.cc-panel')?.remove();
    });
    scheduleProcess();
  });

  // history.pushState を Wrap して SPA ナビゲーションに追随
  const _pushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    _pushState(...args);
    scheduleProcess();
  };
  window.addEventListener('popstate', scheduleProcess);

  scheduleProcess();
})();
