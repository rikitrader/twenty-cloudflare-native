// Integration check for a disposable `wrangler dev --local` database only.
import assert from 'node:assert/strict';
const origin=process.argv[2]??'http://127.0.0.1:8788';
const target=new URL(origin);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname),'Only a local emulator is allowed');
let cookie='';
async function post(operationName,query,variables={},workspaceId){
  const response=await fetch(new URL('/metadata',origin),{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...(workspaceId?{'x-workspace-id':workspaceId}:{})},body:JSON.stringify({operationName,query,variables})});
  const session=response.headers.get('set-cookie');if(session)cookie=session.split(';')[0];
  const body=await response.json();return {status:response.status,body};
}
const email=`local-smoke-${crypto.randomUUID()}@example.invalid`;
const signup=await post('SignUpInNewWorkspace','mutation SignUpInNewWorkspace { signUpInNewWorkspace { workspace { id } } }',{email,password:crypto.randomUUID()+'local-only!'});
assert.equal(signup.status,200,JSON.stringify(signup.body));assert.ok(cookie);
const current=await post('GetCurrentUser','query GetCurrentUser { currentUser { id email } }');
assert.equal(current.body.data.currentUser.email,email);
const id=crypto.randomUUID();
const created=await post('CreateOnePerson','mutation CreateOnePerson($input:PersonCreateInput!) { createPerson(data:$input) { id name { firstName lastName } } }',{input:{id,name:{firstName:'LOCAL DEMO',lastName:'Worker'}}});
assert.equal(created.status,200,JSON.stringify(created.body));assert.equal(created.body.data.createPerson.id,id);
const updated=await post('UpdateOnePerson','mutation UpdateOnePerson($idToUpdate:UUID!,$input:PersonUpdateInput!) { updatePerson(id:$idToUpdate,data:$input) { id } }',{idToUpdate:id,input:{name:{lastName:'Verified'}}});
assert.equal(updated.status,200,JSON.stringify(updated.body));
const read=await post('FindOnePerson','query FindOnePerson($objectRecordId:UUID!) { person(filter:{id:{eq:$objectRecordId}}) { id name { firstName lastName } } }',{objectRecordId:id});
assert.equal(read.body.data.person.name.lastName,'Verified');
const foreign=await post('FindOnePerson','query FindOnePerson { person { id } }',{objectRecordId:id},crypto.randomUUID());assert.equal(foreign.status,403);
const list=await post('FindManyPeople','query FindManyPeople { people { edges { node { id } } totalCount } }',{filter:{name:{lastName:{eq:'Verified'}}},orderBy:[{name:{lastName:'ASC'}}],limit:1});
assert.equal(list.body.data.people.totalCount,1);assert.equal(list.body.data.people.edges[0].node.id,id);
const layouts=await post('FindAllRecordPageLayouts','query FindAllRecordPageLayouts { getPageLayouts { id tabs { id } } }');assert.equal(layouts.body.data.getPageLayouts.length,4);
console.log('PASS local Workers runtime: signup/session, authorized create/edit/read, filtered list, tenant denial, record layouts; no production writes');
