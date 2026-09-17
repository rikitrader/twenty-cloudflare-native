import { copyFile, readFile, writeFile } from 'node:fs/promises';

// The Cloudflare-native Worker intentionally has no CAPTCHA provider configured
// and does not accept CAPTCHA assertions as an authorization signal. The
// upstream bundle otherwise blocks the welcome form before it sends GraphQL.
// Keep the patch deterministic and idempotent until the bundle is rebuilt with
// an explicit CAPTCHA-disabled mode.
const path = new URL('../frontend/assets/SignInUp-CinvB_D3.js', import.meta.url);
const source = await readFile(path, 'utf8');
const needle = 'if(!S)return t({variant:"error",children:o._({id:"Po5MgW"})});';
const patchedMarker = '/* cloudflare-native captcha disabled */';
if (!source.includes(patchedMarker)) {
  const count = source.split(needle).length - 1;
  if (count !== 2) throw new Error(`Expected two CAPTCHA gates, found ${count}`);
  await writeFile(path, source.replaceAll(needle, `${patchedMarker}`));
}

// Bust any browser/service-worker cache for the dynamically imported login
// chunk without changing the upstream bundle's behavior or route structure.
const versionedPath = new URL('../frontend/assets/SignInUp-CinvB_D3-v2.js', import.meta.url);
const mainPath = new URL('../frontend/assets/index-D6X3OEUa.js', import.meta.url);
const mainSource = await readFile(mainPath, 'utf8');
if (!mainSource.includes('./SignInUp-CinvB_D3-v2.js')) {
  const references = mainSource.split('./SignInUp-CinvB_D3.js').length - 1;
  if (references !== 2) throw new Error(`Expected two login chunk references, found ${references}`);
  await copyFile(path, versionedPath);
  await writeFile(mainPath, mainSource.replaceAll('./SignInUp-CinvB_D3.js', './SignInUp-CinvB_D3-v2.js'));
}
