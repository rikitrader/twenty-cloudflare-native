import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../frontend/assets/index-D6X3OEUa.js', import.meta.url);
const source = await readFile(path, 'utf8');
const from = 'u&&(r(u.getPublicWorkspaceDataByDomain.authProviders),a(u.getPublicWorkspaceDataByDomain.authBypassProviders??null),l(u.getPublicWorkspaceDataByDomain))';
const to = 'u&&u.getPublicWorkspaceDataByDomain&&(r(u.getPublicWorkspaceDataByDomain.authProviders??{google:!1,magicLink:!1,password:!0,microsoft:!1,sso:[]}),a(u.getPublicWorkspaceDataByDomain.authBypassProviders??null),l(u.getPublicWorkspaceDataByDomain))';
if (!source.includes(from)) throw new Error('Twenty bootstrap expression not found');
await writeFile(path, source.replace(from, to));
