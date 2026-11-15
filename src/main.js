import { forgetEverything } from './autosave.js';
import { start } from './app.js';

// Ways out when FreeFlow's saved data itself goes wrong, set up before the
// app so they work even if it does not start: "?reset" in the address, the
// footer's "Clear FreeFlow's saved data", and a bar offering the same on an
// unexpected error. Each clears only FreeFlow's own data in this browser
// (see forgetEverything) and reloads.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function clearAndReload() {
  await forgetEverything();
  const url = new URL(location.href);
  url.searchParams.delete('reset');
  location.replace(url.toString());
}

// The first click on a clear button asks; a second within a few seconds clears.
function armClear(button, ask) {
  if (button.dataset.armed === '1') {
    button.disabled = true;
    button.textContent = 'Clearing…';
    clearAndReload();
    return;
  }
  const text = button.textContent;
  button.dataset.armed = '1';
  button.textContent = ask;
  button.classList.add('is-confirm');
  setTimeout(() => {
    if (!button.isConnected || button.dataset.armed !== '1') return;
    button.dataset.armed = '';
    button.textContent = text;
    button.classList.remove('is-confirm');
  }, 5000);
}

const seen = new Set();

function showTrouble(message) {
  const msg = String(message || '').trim();
  // The browser's resize-loop notice is harmless.
  if (!msg || /ResizeObserver loop/i.test(msg) || seen.has(msg)) return;
  seen.add(msg);
  let bar = document.getElementById('trouble-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'trouble-bar';
    bar.className = 'trouble-bar';
    bar.setAttribute('role', 'alert');
    document.body.append(bar);
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b?.dataset.act === 'trouble-close') bar.remove();
      if (b?.dataset.act === 'trouble-clear') armClear(b, 'Click again: clear and reload');
    });
  }
  bar.innerHTML = `<p><strong>Something went wrong:</strong> ${esc(msg)}</p>
    <p>If it keeps happening after reloading, clearing FreeFlow's saved data in this browser usually fixes it. Your files are not changed; work since your last saved bundle is lost.</p>
    <div class="btn-row"><button class="btn btn-small btn-warn" data-act="trouble-clear">Clear saved data and reload</button>
      <button class="btn btn-quiet btn-small" data-act="trouble-close">Dismiss</button></div>`;
}

async function boot() {
  window.addEventListener('error', (e) => showTrouble(e.message || e.error?.message));
  window.addEventListener('unhandledrejection', (e) => showTrouble(e.reason?.message || e.reason));
  document.getElementById('clear-data')?.addEventListener('click', (e) => armClear(e.currentTarget, 'Click again to clear FreeFlow’s saved session and settings'));
  if (new URLSearchParams(location.search).has('reset')) {
    await forgetEverything({ keepSaving: true });
    try {
      const url = new URL(location.href);
      url.searchParams.delete('reset');
      history.replaceState(null, '', url);
    } catch { /* the address stays as it is */ }
  }
  start();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
