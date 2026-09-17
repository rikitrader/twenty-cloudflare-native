/** Stable UUIDv8 for virtual metadata/composite membership identifiers.
 * Never used to replace a persisted CRM record ID or an authorization subject. */
export async function compatibilityId(key:string):Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`twenty-cf:${key}`))).slice(0,16);
  bytes[6]=(bytes[6]&15)|128;
  bytes[8]=(bytes[8]&63)|128;
  const hex=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
