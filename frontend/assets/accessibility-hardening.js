const accessibleName = element =>
  element.getAttribute('aria-label') ||
  element.getAttribute('aria-labelledby') ||
  element.getAttribute('title') ||
  element.textContent?.trim();

function inferredLabel(element) {
  const controls = element.getAttribute('aria-controls') || '';
  if (controls.includes('hidden-table-columns')) return 'Choose visible columns';
  if (controls.includes('footer-options')) return 'Choose column calculation';
  if (controls.includes('filter-dropdown')) return 'Filter records';
  if (controls.includes('sort-dropdown')) return 'Sort records';
  if (controls.includes('object-options')) return 'Record options';
  if (element.getAttribute('aria-roledescription') === 'draggable') return 'Reorder item';
  const icon = element.querySelector('svg[class*="icon-"]')?.className?.baseVal || '';
  const token = icon.match(/icon-([a-z0-9-]+)/i)?.[1]?.replaceAll('-', ' ');
  return token ? `${token} action` : 'Action';
}

function harden(root = document) {
  root.querySelectorAll('[role="presentation"][aria-controls], [role="presentation"][aria-expanded], [role="presentation"][aria-haspopup]').forEach(element => {
    element.removeAttribute('aria-controls');
    element.removeAttribute('aria-expanded');
    element.removeAttribute('aria-haspopup');
  });
  root.querySelectorAll('button, [role="button"], [role="link"], [role="menuitem"]').forEach(element => {
    const nested = element.matches('[role="button"]') && element.querySelector('button, a[href], input, select, textarea, [tabindex="0"]');
    if (nested) {
      element.setAttribute('role', 'presentation');
      element.removeAttribute('tabindex');
      element.removeAttribute('aria-haspopup');
      element.removeAttribute('aria-expanded');
      element.removeAttribute('aria-controls');
      return;
    }
    if (!accessibleName(element)) element.setAttribute('aria-label', inferredLabel(element));
  });
}

const style = document.createElement('style');
style.dataset.twentyAccessibility = 'contrast';
style.textContent = `
  .section-title-label,
  .s1oavrdv,
  .s1ahrbok,
  .s1heixcv,
  .sj3hran { color: #595959 !important; }
`;
document.head.append(style);

const observer = new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) harden(node);
  harden();
});
observer.observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('DOMContentLoaded', () => harden(), { once: true });
