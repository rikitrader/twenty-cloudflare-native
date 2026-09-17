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
let patchedSource = source;
if (!patchedSource.includes(patchedMarker)) {
  const count = source.split(needle).length - 1;
  if (count !== 2) throw new Error(`Expected two CAPTCHA gates, found ${count}`);
  patchedSource = patchedSource.replaceAll(needle, `${patchedMarker}`);
}

// Twenty normally discovers sign-up only after the email existence check. On
// a fresh native D1 deployment there may be no account to check, so expose a
// first-class sign-up action on the welcome screen while preserving Twenty's
// existing form, validation, and mutation flow.
const signupHookNeedle = 'continueWithEmail:b,submitCredentials:';
const signupHookReplacement = 'continueWithEmail:b,startSignUp:(0,h.useCallback)(()=>{i(O.SignUp),l(c.Email)},[i,l]),submitCredentials:';
if (!patchedSource.includes('startSignUp:(0,h.useCallback)')) {
  if (patchedSource.split(signupHookNeedle).length - 1 !== 1) throw new Error('Expected one sign-up hook insertion point');
  patchedSource = patchedSource.replace(signupHookNeedle, signupHookReplacement);
}
const signupComponentNeedle = 'signInUpMode:k,continueWithEmail:g,continueWithCredentials:j,submitCredentials:x';
const signupComponentReplacement = 'signInUpMode:k,continueWithEmail:g,startSignUp:C,continueWithCredentials:j,submitCredentials:x';
if (!patchedSource.includes('startSignUp:C')) {
  if (patchedSource.split(signupComponentNeedle).length - 1 !== 1) throw new Error('Expected one sign-up component insertion point');
  patchedSource = patchedSource.replace(signupComponentNeedle, signupComponentReplacement);
}
const signupButtonNeedle = '}),T&&(0,e.jsx)(ce,{})';
const signupButtonReplacement = '}),a===c.Init&&(0,e.jsx)(V,{title:o._({id:"e+RpCP"}),type:"button",variant:"secondary",onClick:C,fullWidth:!0}),T&&(0,e.jsx)(ce,{})';
if (!patchedSource.includes('onClick:C,fullWidth:!0')) {
  if (patchedSource.split(signupButtonNeedle).length - 1 !== 1) throw new Error('Expected one sign-up button insertion point');
  patchedSource = patchedSource.replace(signupButtonNeedle, signupButtonReplacement);
}
if (patchedSource !== source) await writeFile(path, patchedSource);

// Bust any browser/service-worker cache for the dynamically imported login
// chunk without changing the upstream bundle's behavior or route structure.
const versionedPath = new URL('../frontend/assets/SignInUp-CinvB_D3-v2.js', import.meta.url);
const mainPath = new URL('../frontend/assets/index-D6X3OEUa.js', import.meta.url);
const mainSource = await readFile(mainPath, 'utf8');
if (!mainSource.includes('./SignInUp-CinvB_D3-v2.js')) {
  const references = mainSource.split('./SignInUp-CinvB_D3.js').length - 1;
  if (references !== 2) throw new Error(`Expected two login chunk references, found ${references}`);
  await writeFile(mainPath, mainSource.replaceAll('./SignInUp-CinvB_D3.js', './SignInUp-CinvB_D3-v2.js'));
}
// Keep the cache-busted chunk synchronized whenever this patch script runs.
await copyFile(path, versionedPath);
