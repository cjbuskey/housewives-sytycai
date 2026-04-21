const form = document.getElementById('transcribe-form');
const submitBtn = document.getElementById('submit-btn');
const btnText = submitBtn.querySelector('.btn-text');
const btnLoading = submitBtn.querySelector('.btn-loading');
const errorCard = document.getElementById('error-card');
const errorMsg = document.getElementById('error-message');
const successCard = document.getElementById('success-card');
const resetBtn = document.getElementById('reset-btn');

function setLoading(on) {
  submitBtn.disabled = on;
  submitBtn.classList.toggle('loading', on);
  btnText.classList.toggle('hidden', on);
  btnLoading.classList.toggle('hidden', !on);
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorCard.classList.remove('hidden');
  successCard.classList.add('hidden');
  errorCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showSuccess(data) {
  document.getElementById('result-filename').textContent = data.filename;
  document.getElementById('result-gcs').textContent = data.gcsPath;
  document.getElementById('result-words').textContent = data.wordCount.toLocaleString() + ' words';
  document.getElementById('result-preview').textContent = `"${data.preview}…"`;
  successCard.classList.remove('hidden');
  errorCard.classList.add('hidden');
  successCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorCard.classList.add('hidden');
  successCard.classList.add('hidden');
  setLoading(true);

  const body = {
    url: document.getElementById('url').value.trim(),
    showName: document.getElementById('showName').value.trim(),
    season: document.getElementById('season').value.trim(),
    episodeTitle: document.getElementById('episodeTitle').value.trim(),
    cast: document.getElementById('cast').value.trim(),
    notes: document.getElementById('notes').value.trim(),
  };

  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    showSuccess(data);
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
});

resetBtn.addEventListener('click', () => {
  form.reset();
  successCard.classList.add('hidden');
  errorCard.classList.add('hidden');
  document.getElementById('url').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
