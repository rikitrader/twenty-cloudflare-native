export type LockClaimDisposition = "acquire" | "renew" | "busy";

export function lockClaimDisposition(
  existingOwner: string | undefined,
  requestedOwner: string,
): LockClaimDisposition {
  if (existingOwner === undefined) return "acquire";
  return existingOwner === requestedOwner ? "renew" : "busy";
}
