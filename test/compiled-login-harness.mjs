// Executes the shipped React modules in jsdom against the real resolver and
// an ephemeral SQLite database. This is not browser/layout/E2E verification.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { seedSql } from '../scripts/seed-crm-sample.mjs';

const project = new URL('../', import.meta.url);
const crm = process.argv[2] === 'crm';
const restore = process.argv[2] === 'saved-session' || crm;
const existing = restore || process.argv[2]?.includes('existing');
const submit = process.argv[2]?.startsWith('submit-');
const shortPassword = process.argv[2] === 'submit-short';
const password = shortPassword ? 'Short123!' : 'Local regression test 123!';
const fixtureUserId = '41cd96ce-6ac3-436c-8069-ef3c3d4d118a';
const fixtureWorkspaceId = '94a6b72c-f47a-4a60-979e-e191aeabf01b';
const origin = 'https://twenty-crm.observatorio-publico.workers.dev';
const bundle = await build({
  stdin: { contents: "export {handleGraphql} from './src/graphql-compat'; export {frontendClientConfig} from './src/frontend-config'; export {hashPassword,createNativeSession} from './src/native-auth';", resolveDir: fileURLToPath(project) },
  bundle:true, write:false, platform:'node', format:'esm',
});
const { handleGraphql, frontendClientConfig, hashPassword, createNativeSession } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text+'\n//# sourceURL=twenty-login-resolver.mjs').toString('base64')}`);
const db = new DatabaseSync(':memory:');
for (const name of readdirSync(new URL('migrations/',project)).filter(n=>n.endsWith('.sql')).sort()) {
  db.exec(readFileSync(new URL(`migrations/${name}`, project), 'utf8'));
}
if (existing) {
  const encoded = await hashPassword(password);
  db.prepare('INSERT INTO native_users VALUES (?, ?, ?, ?, ?, ?)')
    .run(fixtureUserId, 'module-check@example.invalid', encoded.hash, encoded.salt, '2026-01-01', '2026-01-01');
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run(fixtureWorkspaceId, 'Test workspace', '2026-01-01');
  db.prepare("INSERT INTO workspace_members VALUES (?, ?, 'owner', 'active', ?)").run(fixtureWorkspaceId, `user:${fixtureUserId}`, '2026-01-01');
}
if (crm) db.exec(seedSql(fixtureWorkspaceId,`user:${fixtureUserId}`));
const queries = [];
const env = { ACCESS_REQUIRED:'true', CRM_DB:{ prepare(sql) { return { bind(...values) {
  return { first:async() => db.prepare(sql).get(...values) ?? null,
    all:async() => ({results:db.prepare(sql).all(...values)}),
    run:async() => ({success:true,meta:db.prepare(sql).run(...values)}) };
} }; }, async batch(statements) {
  db.exec('BEGIN');
  try { const results=[]; for(const s of statements) results.push(await s.run()); db.exec('COMMIT'); return results; }
  catch(error) { db.exec('ROLLBACK'); throw error; }
} } };
let sessionCookie = '';
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url:origin, pretendToBeVisual:true });
const { window } = dom;
if(restore) {
  const session = await createNativeSession(env,fixtureUserId,fixtureWorkspaceId);
  sessionCookie = `twenty_session=${session.id}`;
  window.localStorage.setItem('isCookieAuthActiveState','true');
}
const redirects = [];
window.open = (url,target) => { redirects.push({url,target}); return null; };
for (const name of Object.getOwnPropertyNames(window)) {
  if (!(name in globalThis) || ['navigator','Event','CustomEvent','EventTarget','localStorage','sessionStorage','location','history'].includes(name)) {
    try { Object.defineProperty(globalThis, name, { configurable:true, writable:true, value:window[name] }); } catch {}
  }
}
globalThis.window = window;
globalThis.document = window.document;
// Keep Node Request's AbortSignal realm, but bridge it for real jsdom DOM
// listeners used by drag-and-drop. This does not replace application handlers.
const domAddEventListener=window.EventTarget.prototype.addEventListener;
const signalBridges=new WeakMap();
window.EventTarget.prototype.addEventListener=function(type,listener,options) {
  if(options?.signal && !(options.signal instanceof window.AbortSignal)) {
    let bridge=signalBridges.get(options.signal);
    if(!bridge) {
      bridge=new window.AbortController();signalBridges.set(options.signal,bridge);
      if(options.signal.aborted) bridge.abort();
      else options.signal.addEventListener('abort',()=>bridge.abort(),{once:true});
    }
    options={...options,signal:bridge.signal};
  }
  return domAddEventListener.call(this,type,listener,options);
};
window._env_ = {};
window.matchMedia = () => ({ matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
// jsdom has no layout engine. Provide deterministic non-zero dimensions so
// measured toolbar actions mount; this is not responsive-layout verification.
window.ResizeObserver = globalThis.ResizeObserver = class {
  constructor(callback){this.callback=callback;this.timers=new Set();}
  observe(target){const timer=setTimeout(()=>this.callback([{target,contentRect:{width:1200,height:40},borderBoxSize:[{inlineSize:1200,blockSize:40}]}]),0);this.timers.add(timer);}
  unobserve(){} disconnect(){for(const timer of this.timers)clearTimeout(timer);}
};
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
const errors = [];
window.addEventListener('error', e => errors.push(String(e.error?.stack || e.message)));
process.on('unhandledRejection', e => errors.push(String(e?.stack ?? e)));
globalThis.fetch = window.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url, origin);
  assert.equal(url.origin, origin, 'No external network requests permitted');
  if (url.pathname.startsWith('/assets/')) return new Response('');
  if (url.pathname === '/client-config') return Response.json(frontendClientConfig(url));
  assert.ok(['/metadata','/graphql'].includes(url.pathname), 'Unexpected endpoint');
  const payload = JSON.parse(options?.body ?? '{}');
  // Explicit submit modes may create only ephemeral SQLite fixtures.
  // Disabled analytics is handled by the real resolver, with no persistence.
  assert.ok(!/\bmutation\b/.test(payload.query) || submit || crm || payload.operationName === 'TrackAnalytics', 'Unexpected account mutation');
  const headers = new Headers(options?.headers);
  if(sessionCookie) headers.set('cookie',sessionCookie);
  // DOM listeners require jsdom AbortSignal; Node's Request requires its own
  // realm. Abort behavior is not under test, so omit it at this offline bridge.
  const response = await handleGraphql(new Request(url, {...options,headers,signal:undefined}), env);
  const setCookie = response.headers.get('set-cookie');
  if(setCookie) sessionCookie = setCookie.split(';')[0];
  const result = await response.clone().json();
  queries.push({ operation:payload.operationName, query:payload.query, variables:crm&&/^FindMany|^Aggregate/.test(payload.operationName)?payload.variables:undefined, status:response.status, errors:result.errors, responseKeys:Object.keys(result.data??{}) });
  return response;
};
// jsdom does not load stylesheets. Satisfy Vite's link-load wait only; this
// intentionally makes no claims about CSS or responsive layout.
const append = document.head.appendChild.bind(document.head);
document.head.appendChild = node => {
  const result = append(node);
  if (node.tagName === 'LINK') setTimeout(() => node.dispatchEvent(new window.Event('load')), 0);
  return result;
};
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 8000;
  while (!predicate() && Date.now() < deadline) await tick();
  assert.ok(predicate(), `${label}: ${document.body.textContent}`);
};
const buttons = () => [...document.querySelectorAll('button')];
const button = text => buttons().find(b => text.test(b.textContent));
const fillInput = async (field,value) => {
  assert.ok(field,'Expected input');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(field,value);
  field.dispatchEvent(new window.Event('input',{bubbles:true}));
  field.dispatchEvent(new window.Event('change',{bubbles:true}));
  await tick();
};
const key = (target,value,code=value) => {
  target.dispatchEvent(new window.KeyboardEvent('keydown',{key:value,code,bubbles:true,cancelable:true,keyCode:value==='Enter'?13:27}));
  target.dispatchEvent(new window.KeyboardEvent('keyup',{key:value,code,bubbles:true,cancelable:true,keyCode:value==='Enter'?13:27}));
};
const workspaceVisible = () => document.body.textContent.includes('People')
  && button(/^(?:Filter|Filtro)$/) && button(/^(?:Sort|Ordenar)$/)
  && !document.querySelector('input[type="password"]');
const assertWorkspace = async () => {
  await waitFor(workspaceVisible, 'Authenticated People workspace');
  assert.match(window.location.pathname, /^\/objects\/people(?:\/|$)/);
  assert.deepEqual(errors, []);
  assert.ok(!queries.some(q => q.status >= 400 || q.errors?.length));
  assert.ok(queries.some(q => q.operation === 'GetCurrentUser' && q.responseKeys.includes('currentUser')));
  assert.ok(queries.some(q => q.operation === 'ObjectMetadataItems' && q.responseKeys.includes('objects')));
  assert.equal(redirects.length, 0, 'Single-origin workspace uses SPA navigation');
};
const clickText = text => {
  const item=[...document.querySelectorAll('a,button,[role="button"],div')].filter(el=>el.textContent.trim()===text && !el.querySelector('a,button,[role="button"]')).at(-1);
  assert.ok(item, `Missing UI action ${text}`);
  if(process.env.DEBUG_CRM_QUERIES==='1') console.log('Click target:',item.outerHTML,item.parentElement?.outerHTML.slice(0,1800));
  item.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true,button:0}));
  item.dispatchEvent(new window.MouseEvent('mouseup',{bubbles:true,button:0}));
  item.click();
};
try {
  const html = readFileSync(new URL('frontend/index.html', project), 'utf8');
  const entry = html.match(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/)[1];
  await import(new URL(`frontend${entry}`, project).href);
  if(restore) {
    await assertWorkspace();
    if(crm) {
      await waitFor(()=>document.body.textContent.includes('DEMO Alex'),'Seeded People table');
      clickText('Activities');
      await waitFor(()=>document.body.textContent.includes('DEMO · Read this sample note'),'Seeded activity table');
      clickText('Companies');
      await waitFor(()=>window.location.pathname.includes('/objects/companies') && document.body.textContent.includes('DEMO · Aurora Labs'),'Companies sidebar and table');
      clickText('People');
      await waitFor(()=>window.location.pathname.includes('/objects/people') && document.body.textContent.includes('DEMO Alex'),'People sidebar and table');
      clickText('Opportunities');
      await waitFor(()=>window.location.pathname.includes('/objects/opportunities') && document.body.textContent.includes('DEMO · Discovery project'),'Opportunity sidebar and table');
      clickText('People');
      await waitFor(()=>window.location.pathname.includes('/objects/people') && document.body.textContent.includes('New Person'),'People creation action');
      clickText('New Person');
      await waitFor(()=>queries.some(q=>q.operation==='CreateOnePerson'),'New Person mutation');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contacts').get().count,6,'New Person persists a real row');
      await new Promise(resolve=>setTimeout(resolve,1200));
      if(document.body.textContent.includes('Untitled')) clickText('Untitled');
      await waitFor(()=>document.querySelector('input:not([type="checkbox"]):not([type="file"]),textarea'),'Editable record name');
      const nameInputs=[...document.querySelectorAll('input')].filter(el=>el.placeholder.replace(/[\u200c\u200d]/g,'').endsWith('name'));
      await fillInput(nameInputs[0],'DEMO UI');
      await fillInput(nameInputs[1],'Verified');
      nameInputs[1].focus();key(nameInputs[1],'Enter');
      await waitFor(()=>db.prepare("SELECT id FROM contacts WHERE first_name='DEMO UI' AND last_name='Verified'").get(),'Inline name edit persisted');
      assert.ok(queries.some(q=>q.operation==='UpdateOnePerson'&&q.status===200));
      clickText('Companies');
      await waitFor(()=>window.location.pathname.includes('/objects/companies')&&document.body.textContent.includes('All Companies'),'Navigate away after editing');
      clickText('People');
      await waitFor(()=>window.location.pathname.includes('/objects/people')&&document.body.textContent.includes('All People'),'Return to People table');
      await waitFor(()=>[...document.querySelectorAll('[data-testid="tooltip"]')].filter(el=>el.textContent==='DEMO UI Verified').length>0,'Edited person remains visible after navigation');
      clickText(button(/^(?:Sort|Ordenar)$/).textContent.trim());await tick();
      await waitFor(()=>/(?:Ascending|Ascendente)/.test(document.body.textContent),'Sort menu opens');
      clickText('Name');
      await waitFor(()=>queries.some(q=>q.operation==='FindManyPeople'&&JSON.stringify(q.variables?.orderBy).includes('name')),'Name sort invokes real query');
      clickText(button(/^(?:Filter|Filtro)$/).textContent.trim());await tick();
      await waitFor(()=>/(?:Advanced filter|Filtro avanzado)/.test(document.body.textContent),'Filter field menu opens');
      clickText('Email');await tick();
      await waitFor(()=>document.querySelector('input[placeholder="Email"]'),'Email filter editor');
      await fillInput(document.querySelector('input[placeholder="Email"]'),'demo-0@');
      key(document.querySelector('input[placeholder="Email"]'),'Enter');
      await waitFor(()=>queries.some(q=>q.operation==='FindManyPeople'&&JSON.stringify(q.variables?.filter).includes('demo-0@')),'Email filter invokes real query');
      await waitFor(()=>document.body.textContent.includes('All People· 1'),'Filtered count is one matching person');
      clickText(document.body.textContent.includes('Guardar como nueva vista')?'Guardar como nueva vista':'Save as new view');await tick();
      await waitFor(()=>/(?:Create view|Crear vista)/.test(document.body.textContent),'Save-view dialog opens');
      await fillInput([...document.querySelectorAll('input')].find(el=>el.value==='All People'),'DEMO filtered people');
      clickText(document.body.textContent.includes('Crear')?'Crear':'Create');
      await waitFor(()=>db.prepare("SELECT id FROM saved_views WHERE name='DEMO filtered people'").get(),'Saved view persists');
      await waitFor(()=>document.body.textContent.includes('DEMO filtered people· 1'),'Saved filtered view activates');
      assert.deepEqual(errors,[]);
      assert.ok(!queries.some(q=>q.status>=400 || q.errors?.length),JSON.stringify(queries.map(({query,...q})=>q)));
      console.log('PASS compiled CRM navigation, seeded tables, New Person insert, inline name save, sorting, email filtering and saved view');
    }
    console.log('PASS saved session -> authenticated People workspace');
    dom.window.close();db.close();process.exit(0);
  }
  await waitFor(() => button(/^Continue with Email$/) || document.querySelector('input[placeholder="Email"]'), 'Welcome page');
  button(/^Continue with Email$/)?.click();
  await waitFor(() => document.querySelector('input[placeholder="Email"]'), 'Email form');
  const email = document.querySelector('input[placeholder="Email"]');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(email,'module-check@example.invalid');
  email.dispatchEvent(new window.Event('input',{bubbles:true}));
  email.dispatchEvent(new window.Event('change',{bubbles:true}));
  await tick();
  button(/^Continue$/).click();
  await waitFor(() => [...document.querySelectorAll('input')].some(x => x.type === 'password'), 'Password step');
  const expected = existing ? /^Log in$|^Sign in$/i : /^Sign up$/i;
  assert.ok(button(expected), `Expected ${existing ? 'login' : 'signup'} button`);
  assert.ok(queries.some(q => q.operation === 'CheckUserExists' && q.query.includes('__typename') && q.status === 200));
  assert.deepEqual(errors, []);
  if (submit) {
    const field = document.querySelector('input[type="password"]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(field,password);
    field.dispatchEvent(new window.Event('input',{bubbles:true}));
    field.dispatchEvent(new window.Event('change',{bubbles:true}));
    await tick();
    button(expected).click();
    if (shortPassword) {
      await waitFor(() => button(expected)?.disabled, 'Signup disabled for short password');
      assert.ok(document.body.textContent.includes('At least 10 characters long.'));
      assert.ok(!queries.some(q => /SignUpIn/.test(q.operation)), 'Invalid password must not submit');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM native_users').get().count, 0);
      assert.deepEqual(errors, []);
      console.log('PASS short signup password rejected without account creation');
      dom.window.close(); db.close(); process.exit(0);
    }
    await waitFor(() => queries.some(q => /GetCurrentUser/i.test(q.operation)) || queries.some(q=>q.status>=400), 'Credential submission');
    await new Promise(resolve=>setTimeout(resolve,1000));
    console.log('Credential trace:', JSON.stringify(queries.map(({query,...q})=>q)));
    assert.ok(!queries.some(q=>q.status>=400), JSON.stringify(queries.map(({query,...q})=>q)));
    assert.deepEqual(errors, []);
    assert.ok(queries.some(q=>q.operation==='GetCurrentUser' && q.responseKeys.includes('currentUser')));
    assert.ok(!document.body.textContent.includes('No current user result'));
    await assertWorkspace();
    console.log('PASS credentials -> authenticated People workspace');
  }
  console.log(`PASS ${existing ? 'known email -> login' : 'unknown email -> signup'} (compiled UI + SQLite resolver, no network)`);
  dom.window.close();
  db.close();
  process.exit(0);
} catch (error) {
  console.error(error);
  console.error('Captured errors:', errors);
  console.error('Request trace:', JSON.stringify(queries.map(({query,...q})=>q)));
  if(process.env.DEBUG_CRM_QUERIES==='1') console.error('Query roots:',JSON.stringify(queries.map(q=>({op:q.operation,query:q.query}))));
  dom.window.close();
  db.close();
  process.exit(1);
}
