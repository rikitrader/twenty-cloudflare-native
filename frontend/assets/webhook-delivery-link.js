const LINK_ID = 'cloudflare-webhook-deliveries-link';

function syncLink() {
  // Twenty hides the upstream webhook screen when its "Advanced" preference is
  // disabled. Keep the operational delivery ledger discoverable from every
  // settings page; the server endpoint still performs owner/admin authorization.
  const visible = location.pathname === '/settings' || location.pathname.startsWith('/settings/');
  const existing = document.getElementById(LINK_ID);
  if (!visible) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const link = document.createElement('a');
  link.id = LINK_ID;
  link.href = '/_ops/webhooks';
  link.textContent = 'Webhook deliveries';
  link.setAttribute('aria-label', 'Open webhook delivery history and replay controls');
  Object.assign(link.style, {
    position: 'fixed', right: '24px', bottom: '24px', zIndex: '1000',
    padding: '9px 13px', borderRadius: '7px', background: '#141414', color: '#fff',
    font: '500 13px Inter, ui-sans-serif, system-ui, sans-serif', textDecoration: 'none',
    boxShadow: '0 4px 14px rgba(0,0,0,.18)'
  });
  document.body.append(link);
}

new MutationObserver(syncLink).observe(document.documentElement, { childList: true, subtree: true });
addEventListener('popstate', syncLink);
addEventListener('click', () => queueMicrotask(syncLink), true);
syncLink();
