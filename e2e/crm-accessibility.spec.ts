import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const appURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:8788';

const mutation = (operationName: string, root: string, variables: Record<string, unknown>) => ({
  operationName,
  query: `mutation ${operationName} { ${root} { id } }`,
  variables,
});

async function graphql(page: Page, body: Record<string, unknown>) {
  const response = await page.request.post('/metadata', { data: body });
  const payload = await response.json();
  expect(response.status(), JSON.stringify(payload)).toBe(200);
  expect(payload.errors, JSON.stringify(payload)).toBeUndefined();
  return { response, payload };
}

async function disposableWorkspace(page: Page, testInfo: TestInfo) {
  const suffix = `${testInfo.project.name}-${crypto.randomUUID()}`.replace(/[^a-z0-9-]/gi, '-');
  const email = `playwright-${suffix}@example.invalid`;
  const password = `Local-${crypto.randomUUID()}!`;
  const signup = await graphql(page, mutation('SignUpInNewWorkspace', 'signUpInNewWorkspace', { email, password }));
  const cookie = signup.response.headers()['set-cookie']?.match(/twenty_session=([^;]+)/)?.[1];
  expect(cookie).toBeTruthy();
  await page.context().addCookies([{ name: 'twenty_session', value: cookie!, domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
  const stored = await page.context().cookies(appURL);
  expect(stored.some(item => item.name === 'twenty_session' && item.value === cookie)).toBe(true);
  await page.addInitScript(() => window.localStorage.setItem('isCookieAuthActiveState', 'true'));
  const current = await graphql(page, { operationName: 'GetCurrentUser', query: 'query GetCurrentUser { currentUser { id email } }', variables: {} });
  expect(current.payload.data?.currentUser, JSON.stringify(current.payload)).toBeTruthy();
  return { email };
}

function collectBrowserFailures(page: Page) {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') failures.push(`console: ${message.text()}`); });
  page.on('requestfailed', request => {
    const errorText = request.failure()?.errorText ?? '';
    // React Router cancels in-flight list queries during a deliberate route
    // transition. Treat browser cancellation as lifecycle, not a network error.
    if (errorText === 'net::ERR_ABORTED') return;
    failures.push(`requestfailed: ${request.method()} ${request.url()} ${errorText}`);
  });
  page.on('response', response => { if (response.status() >= 500) failures.push(`http-${response.status()}: ${response.request().method()} ${response.url()}`); });
  return failures;
}

test('critical CRM surfaces are responsive, accessible, and error-free', async ({ page }, testInfo) => {
  const failures = collectBrowserFailures(page);
  await disposableWorkspace(page, testInfo);
  const personId = crypto.randomUUID();
  const companyId = crypto.randomUUID();
  const opportunityId = crypto.randomUUID();
  const activityId = crypto.randomUUID();
  await graphql(page, mutation('CreateOnePerson', 'createPerson', { input: { id: personId, name: { firstName: 'Playwright', lastName: 'Person' }, email: 'person@example.invalid' } }));
  await graphql(page, mutation('CreateOneCompany', 'createCompany', { input: { id: companyId, name: 'Playwright Company', domain: 'example.invalid' } }));
  await graphql(page, mutation('CreateOneOpportunity', 'createOpportunity', { input: { id: opportunityId, name: 'Playwright Opportunity', companyId, pointOfContactId: personId, stage: 'prospecting' } }));
  await graphql(page, mutation('CreateOneActivity', 'createActivity', { input: { id: activityId, title: 'Playwright Activity', type: 'task', contactId: personId, companyId, opportunityId } }));

  const surfaces = [
    ['/objects/people', /People/i, 'Playwright Person', 'People'],
    ['/objects/companies', /Companies/i, 'Playwright Company', 'Companies'],
    ['/objects/opportunities', /Opportunities/i, 'Playwright Opportunity', 'Opportunities'],
    ['/objects/activities', /Activities/i, 'Playwright Activity', 'Activities'],
    ['/settings/profile', /Profile|Perfil|Cuenta/i, null, 'settings'],
  ] as const;

  await page.goto('/objects/people');
  await expect(page.getByRole('link', { name: 'People', exact: true })).toBeVisible();
  const surfaceHrefs = Object.fromEntries(await Promise.all(
    ['People', 'Companies', 'Opportunities', 'Activities'].map(async name => [
      name,
      await page.getByRole('link', { name, exact: true }).getAttribute('href'),
    ]),
  ));
  for (const [path, heading, record, navigationLink] of surfaces) {
    // Object pages need their generated viewId. Exercise the same sidebar links
    // real users use instead of bypassing that contract with an incomplete URL.
    if (navigationLink === 'settings') {
      const settingsButton = page.getByRole('button', { name: /Configuración|Settings/i });
      if (await settingsButton.isVisible()) {
        await settingsButton.click();
      } else {
        await page.getByRole('button', { name: /Inicio|Home/i }).click();
        await page.getByRole('button', { name: /workspace/i }).click();
        const mobileSettingsEntry = page.getByText(/Configuración|Settings/i).first();
        await expect(mobileSettingsEntry).toBeVisible();
        await mobileSettingsEntry.click();
      }
      await expect(page).toHaveURL(/\/settings\//);
    } else if (navigationLink) {
      const href = surfaceHrefs[navigationLink];
      expect(href, `${navigationLink} must expose an authorized view link`).toBeTruthy();
      const link = page.getByRole('link', { name: navigationLink, exact: true });
      if (!await link.isVisible()) {
        await page.getByRole('button', { name: /Inicio|Home/i }).click();
        await expect(link).toBeVisible();
      }
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${path.replaceAll('/', '\\/')}\\?viewId=`));
    } else {
      await page.goto(path);
    }
    await expect(page.getByText(heading).first()).toBeVisible();
    if (record) await expect(page.getByText(record).first()).toBeVisible();
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    expect(dimensions.width, `${path} overflows the viewport`).toBeLessThanOrEqual(dimensions.viewport + 1);
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    const serious = accessibility.violations.filter(item => item.impact === 'critical' || item.impact === 'serious');
    expect(serious, `${path}: ${JSON.stringify(serious, null, 2)}`).toEqual([]);
    await testInfo.attach(`${path.replaceAll('/', '-') || 'home'}-a11y`, { body: JSON.stringify(accessibility, null, 2), contentType: 'application/json' });
  }

  await page.goto('/objects/people');
  await expect(page.getByText(/People/i).first()).toBeVisible();
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement?.tagName !== 'BODY')) break;
  }
  const focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: (document.activeElement?.textContent ?? '').trim(), aria: document.activeElement?.getAttribute('aria-label') }));
  expect(['A', 'BUTTON', 'INPUT', 'SELECT']).toContain(focus.tag);
  expect(focus.text || focus.aria, 'First keyboard focus target must have an accessible name').toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('critical-crm.png'), fullPage: true });
  await testInfo.attach('browser-failures', { body: JSON.stringify(failures, null, 2), contentType: 'application/json' });
  expect(failures).toEqual([]);
});
