/** This deployment serves login AND the workspace app on one Worker origin.
 * Twenty's multi-domain mode puts the default hostname into an auth-only router
 * with no CRM routes. Workspace authorization remains server-side in D1. */
export function frontendDomain(hostname: string) {
  const [defaultSubdomain] = hostname.split('.');
  return {
    defaultSubdomain,
    frontDomain: hostname,
    isMultiWorkspaceEnabled: false,
  };
}
