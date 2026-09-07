const $ = (id) => document.getElementById(id);
let lastId = 0;
let polling = false;

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

async function refreshHealth() {
  try {
    const health = await api('/health');
    $('health').textContent = `online · HMAC ${health.hmacConfigured ? 'verified' : 'off'}`;
    $('health').className = `pill ${health.hmacConfigured ? 'good' : 'bad'}`;
  } catch (error) {
    $('health').textContent = error.message;
    $('health').className = 'pill bad';
  }
}

async function refreshSummary() {
  const summary = await api('/api/summary');
  const root = $('summary');
  root.innerHTML = '';
  if (!summary.length) {
    root.innerHTML = '<div class="muted">No webhooks captured yet.</div>';
    return;
  }
  for (const item of summary) {
    const card = document.createElement('article');
    card.className = 'card';
    const types = Object.entries(item.eventTypes || {}).map(([type, count]) => `${esc(type)} × ${count}`).join('<br>');
    card.innerHTML = `<strong>${esc(item.sessionId || '(no session)')}</strong>
      <div class="meta">total: ${item.total} · dispatcher: ${item.dispatcher} · session-closed: ${item.sessionClosed}<br>
      signatures: <span class="${item.invalidSignatures ? 'bad' : 'ok'}">${item.invalidSignatures ? `${item.invalidSignatures} invalid` : 'all valid'}</span><br>${types}</div>`;
    root.appendChild(card);
  }
}

async function pollEvents() {
  if (polling) return;
  polling = true;
  try {
    const entries = await api(`/api/events?after=${lastId}`);
    const root = $('events');
    const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 70;
    entries.sort((a,b) => a.id - b.id);
    for (const event of entries) {
      if (event.id <= lastId) continue;
      lastId = event.id;
      const row = document.createElement('div');
      row.className = 'event';
      const sig = event.signatureValid === null ? 'n/a' : (event.signatureValid ? 'valid' : 'INVALID');
      row.textContent = `${new Date(event.receivedAt).toLocaleTimeString()} #${event.id} ${event.kind} ${event.eventType} session=${event.sessionId || '—'} signature=${sig}\n${JSON.stringify(event.body)}`;
      root.appendChild(row);
    }
    $('count').textContent = String(root.children.length);
    if (nearBottom) root.scrollTop = root.scrollHeight;
    if (entries.length) await refreshSummary();
  } finally {
    polling = false;
  }
}

$('clear').onclick = async () => {
  await api('/api/events', { method: 'DELETE' });
  lastId = 0;
  $('events').innerHTML = '';
  $('count').textContent = '0';
  await refreshSummary();
};

await refreshHealth();
await refreshSummary();
await pollEvents();
setInterval(refreshHealth, 3000);
setInterval(pollEvents, 500);
