const coachCard = document.getElementById('coach-card');
const unconfiguredCard = document.getElementById('unconfigured-card');
const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const btnText = sendBtn.querySelector('.btn-text');
const btnLoading = sendBtn.querySelector('.btn-loading');
const errorCard = document.getElementById('error-card');
const errorMsg = document.getElementById('error-message');
const chips = document.getElementById('chat-chips');

let sessionId = null;
let hasStarted = false;

function setSending(on) {
  sendBtn.disabled = on;
  chatInput.disabled = on;
  btnText.classList.toggle('hidden', on);
  btnLoading.classList.toggle('hidden', !on);
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorCard.classList.remove('hidden');
}

function clearError() {
  errorCard.classList.add('hidden');
}

function clearChatLog() {
  while (chatLog.firstChild) chatLog.removeChild(chatLog.firstChild);
}

function appendBubble(role, text) {
  if (!hasStarted) {
    clearChatLog();
    hasStarted = true;
  }
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble chat-bubble-${role}`;
  bubble.textContent = text;
  chatLog.appendChild(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function ask(text) {
  clearError();
  appendBubble('user', text);
  setSending(true);

  try {
    const res = await fetch('/api/agent/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sessionId }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server responded ${res.status}`);

    sessionId = data.sessionId || sessionId;
    if (data.greeting) appendBubble('agent', data.greeting);
    appendBubble('agent', data.reply || '…');
  } catch (err) {
    showError(err.message);
  } finally {
    setSending(false);
    chatInput.focus();
  }
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  ask(text);
});

chips.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  const prompt = btn.dataset.prompt;
  if (prompt) ask(prompt);
});

async function init() {
  try {
    const res = await fetch('/api/agent/config');
    const data = await res.json();
    if (!data.configured) {
      unconfiguredCard.classList.remove('hidden');
      return;
    }
    coachCard.classList.remove('hidden');
    chatInput.focus();
  } catch {
    unconfiguredCard.classList.remove('hidden');
  }
}

init();
