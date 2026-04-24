const searchInput = document.getElementById('search');
const listEl = document.getElementById('housewife-list');
const previewWrap = document.getElementById('preview-wrap');
const metaName = document.getElementById('meta-name');
const metaScore = document.getElementById('meta-score');
const metaShow = document.getElementById('meta-show');
const metaEpisode = document.getElementById('meta-episode');
const confessionalText = document.getElementById('confessional-text');
const playBtn = document.getElementById('play-btn');
const btnText = playBtn.querySelector('.btn-text');
const btnLoading = playBtn.querySelector('.btn-loading');
const audio = document.getElementById('audio');
const errorCard = document.getElementById('error-card');
const errorMsg = document.getElementById('error-message');
const emptyCard = document.getElementById('empty-card');

let items = [];
let selectedIdx = null;
let currentAudioUrl = null;
// Client-side audio cache: item index -> blob URL
const audioCache = new Map();

function showError(msg) {
  errorMsg.textContent = msg;
  errorCard.classList.remove('hidden');
}

function setPlayLoading(on) {
  playBtn.disabled = on;
  playBtn.classList.toggle('loading', on);
  btnText.classList.toggle('hidden', on);
  btnLoading.classList.toggle('hidden', !on);
}

function formatEpisode(item) {
  const parts = [];
  if (item.season) parts.push(`Season ${item.season}`);
  if (item.episode_title) parts.push(item.episode_title);
  return parts.join(' — ') || '—';
}

// "Real Housewives of Salt Lake City" → "RHOSLC"
function abbreviateShow(name) {
  if (!name) return '';
  const m = name.match(/Real Housewives of (.+)/i);
  if (!m) return name;
  const initials = m[1]
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return `RHO${initials}`;
}

function rowLabel(item) {
  const show = abbreviateShow(item.show);
  const season = item.season ? `S${item.season}` : '';
  const ep = item.episode_title || '';
  return [show, season, ep].filter(Boolean).join(' — ');
}

function hasScore(item) {
  return item.drama_score !== null && item.drama_score !== undefined;
}

function itemMatchesFilter(item, filter) {
  if (!filter) return true;
  const haystack = [
    item.housewife,
    item.show,
    abbreviateShow(item.show),
    item.episode_title,
    item.season ? `s${item.season} season ${item.season}` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(filter);
}

function renderSelection(idx) {
  const item = items[idx];
  if (!item) {
    previewWrap.classList.add('hidden');
    return;
  }
  selectedIdx = idx;
  metaName.textContent = item.housewife;
  metaScore.textContent = hasScore(item) ? `${item.drama_score} / 100` : '—';
  metaShow.textContent = item.show;
  metaEpisode.textContent = formatEpisode(item);
  confessionalText.textContent = `"${item.confessional}"`;
  previewWrap.classList.remove('hidden');

  // If switching to a different row, stop playback but keep cached blob URLs intact
  if (audioCache.has(idx)) {
    currentAudioUrl = audioCache.get(idx);
    audio.src = currentAudioUrl;
    audio.classList.remove('hidden');
  } else {
    audio.classList.add('hidden');
    audio.removeAttribute('src');
    currentAudioUrl = null;
  }

  // Update highlighted row
  listEl.querySelectorAll('.housewife-row').forEach((row) => {
    row.classList.toggle('selected', Number(row.dataset.idx) === idx);
  });
}

function renderList(filter = '') {
  const f = filter.toLowerCase().trim();
  listEl.innerHTML = '';

  // Group matching items by housewife name
  const groups = new Map();
  items.forEach((item, idx) => {
    if (!itemMatchesFilter(item, f)) return;
    if (!groups.has(item.housewife)) groups.set(item.housewife, []);
    groups.get(item.housewife).push({ idx, item });
  });

  if (groups.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'housewife-list-empty';
    empty.textContent = 'No matches — try a different search.';
    listEl.appendChild(empty);
    return;
  }

  const sortedNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
  sortedNames.forEach((name) => {
    const entries = groups.get(name).sort((a, b) => (a.item.season || 0) - (b.item.season || 0));

    const header = document.createElement('div');
    header.className = 'housewife-group-label';
    header.textContent = name;
    listEl.appendChild(header);

    entries.forEach(({ idx, item }) => {
      const row = document.createElement('div');
      row.className = 'housewife-row';
      row.dataset.idx = String(idx);
      row.setAttribute('role', 'option');
      row.setAttribute('tabindex', '0');
      if (idx === selectedIdx) row.classList.add('selected');

      const meta = document.createElement('span');
      meta.className = 'housewife-row-meta';
      meta.textContent = rowLabel(item);

      const score = document.createElement('span');
      score.className = 'housewife-row-score';
      score.textContent = hasScore(item) ? item.drama_score : '—';

      row.appendChild(meta);
      row.appendChild(score);

      row.addEventListener('click', () => renderSelection(idx));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          renderSelection(idx);
        }
      });

      listEl.appendChild(row);
    });
  });
}

async function loadHousewives() {
  try {
    const res = await fetch('/api/housewives');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load confessionals.');

    items = data.items || [];
    if (items.length === 0) {
      listEl.innerHTML = '';
      emptyCard.classList.remove('hidden');
      return;
    }

    renderList();
    searchInput.disabled = false;

    searchInput.addEventListener('input', (e) => {
      renderList(e.target.value);
    });
  } catch (err) {
    showError(err.message);
  }
}

playBtn.addEventListener('click', async () => {
  const idx = selectedIdx;
  const item = idx === null ? null : items[idx];
  if (!item) return;

  errorCard.classList.add('hidden');

  // Already cached — play immediately without hitting the server
  if (audioCache.has(idx)) {
    audio.src = audioCache.get(idx);
    audio.classList.remove('hidden');
    await audio.play();
    return;
  }

  setPlayLoading(true);

  try {
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: item.confessional, gender: item.gender || 'female' }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server responded ${res.status}`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    audioCache.set(idx, url);
    currentAudioUrl = url;
    audio.src = url;
    audio.classList.remove('hidden');
    await audio.play();
  } catch (err) {
    showError(err.message);
  } finally {
    setPlayLoading(false);
  }
});

loadHousewives();
