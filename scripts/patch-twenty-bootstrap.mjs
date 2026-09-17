import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../frontend/assets/index-D6X3OEUa.js', import.meta.url);
let source = await readFile(path, 'utf8');
const from = 'u&&(r(u.getPublicWorkspaceDataByDomain.authProviders),a(u.getPublicWorkspaceDataByDomain.authBypassProviders??null),l(u.getPublicWorkspaceDataByDomain))';
const to = 'u&&u.getPublicWorkspaceDataByDomain&&(r(u.getPublicWorkspaceDataByDomain.authProviders??{google:!1,magicLink:!1,password:!0,microsoft:!1,sso:[]}),a(u.getPublicWorkspaceDataByDomain.authBypassProviders??null),l(u.getPublicWorkspaceDataByDomain))';
if (!source.includes(to)) {
  if (!source.includes(from)) throw new Error('Twenty bootstrap expression not found');
  source = source.replace(from, to);
}

// Multiple Apollo clients can report an expired cookie at the same time. A
// soft router transition races workspace route guards and can strand the UI on
// /not-found. Reset the document at the public welcome route and never retain
// /not-found as the post-authentication return path.
const expiredSessionFrom = 'i2(b)&&f(b),n(be.SignInUp)';
const expiredSessionTo = 'b!==be.NotFound&&i2(b)&&f(b),window.location.replace(be.SignInUp)';
if (!source.includes(expiredSessionTo)) {
  if (!source.includes(expiredSessionFrom)) throw new Error('Twenty expired-session redirect expression not found');
  source = source.replace(expiredSessionFrom, expiredSessionTo);
}

await writeFile(path, source);
