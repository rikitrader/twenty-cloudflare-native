import { readFile, writeFile } from 'node:fs/promises';

// Keep the existing native 10-character signup minimum. Existing passwords
// retain the upstream login validator; no password or session is invalidated.
for (const name of ['SignInUp-CinvB_D3.js','SignInUp-CinvB_D3-v3.js']) {
  const path = new URL(`../frontend/assets/${name}`,import.meta.url);
  let source = await readFile(path,'utf8');
  for(const [before,after] of [
    ['Wt=s=>De({','Wt=(s,m)=>De({'],
    ['Z().regex(gt,X._({id:"BfLK2u"}))','Z().regex(m===O.SignUp?/^.{10,50}$/:gt,m===O.SignUp?"Password must be between 10 and 50 characters":X._({id:"BfLK2u"}))'],
    ['const s=Wt(f(L)),','const s=Wt(f(L),f(At)),'],
    ['text:n._({id:"H8QGSx"})','text:"At least 10 characters long."'],
  ]) {
    if(source.includes(after)) continue;
    if(source.split(before).length!==2) throw new Error(`Unexpected password-policy patch target: ${name}`);
    source=source.replace(before,after);
  }
  await writeFile(path,source);
}
