const DEFAULT_TIMEOUT_MS = 5000;

let timeoutId = null;

function ensureNotificationElement() {
    let element = document.getElementById('lab-notification');
    if (element) return element;

    element = document.createElement('div');
    element.id = 'lab-notification';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    element.className = 'lab-notification hidden';
    document.body.appendChild(element);
    return element;
}

export function notifyLab(message, options = {}) {
    const text = String(message || '').trim();
    if (!text) return;

    const element = ensureNotificationElement();
    element.textContent = text;
    element.classList.remove('hidden');
    element.classList.add('is-visible');

    const statusText = document.getElementById('status-text');
    if (statusText && options.updateStatus !== false) {
        statusText.textContent = text.split('\n')[0];
    }

    window.clearTimeout(timeoutId);
    const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (timeoutMs > 0) {
        timeoutId = window.setTimeout(() => {
            element.classList.remove('is-visible');
            element.classList.add('hidden');
        }, timeoutMs);
    }
}

window.notifyLab = notifyLab;
