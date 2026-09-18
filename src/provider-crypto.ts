import type { Env } from './types';

const encoder=new TextEncoder();const decoder=new TextDecoder();
const base64url=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const fromBase64=(value:string)=>{const normalized=value.replace(/-/g,'+').replace(/_/g,'/');const padded=normalized+'='.repeat((4-normalized.length%4)%4);return Uint8Array.from(atob(padded),char=>char.charCodeAt(0));};

async function key(env:Env):Promise<CryptoKey>{
  if(!env.INTEGRATION_ENCRYPTION_KEY)throw new Error('integration encryption key is not configured');
  let raw:Uint8Array;try{raw=fromBase64(env.INTEGRATION_ENCRYPTION_KEY);}catch{throw new Error('integration encryption key is invalid');}
  if(raw.byteLength!==32)throw new Error('integration encryption key must decode to exactly 32 bytes');
  return crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
export async function encryptProviderValue(env:Env,value:unknown,aad:string):Promise<{ciphertext:string;iv:string}>{
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(aad),tagLength:128},await key(env),encoder.encode(JSON.stringify(value)));
  return{ciphertext:base64url(new Uint8Array(encrypted)),iv:base64url(iv)};
}
export async function decryptProviderValue<T>(env:Env,ciphertext:string,iv:string,aad:string):Promise<T>{
  const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64(iv),additionalData:encoder.encode(aad),tagLength:128},await key(env),fromBase64(ciphertext));
  return JSON.parse(decoder.decode(clear)) as T;
}
export const randomProviderSecret=(bytes=32)=>base64url(crypto.getRandomValues(new Uint8Array(bytes)));
export async function providerDigest(value:string){return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))));}
