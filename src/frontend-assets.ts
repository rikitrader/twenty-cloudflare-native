/** The compatibility patches modify these files without rebuilding their Vite
 * content hashes. Revalidate via HTTP policy, never by changing only the HTML
 * module URL: the entry is also imported by chunks that share its atom state. */
export function withFrontendCachePolicy(asset: Response, pathname: string): Response {
  const isHtml = asset.headers.get('content-type')?.includes('text/html');
  const isPatchedModule = pathname === '/assets/index-D6X3OEUa.js'
    || /^\/assets\/SignInUp-CinvB_D3(?:-v\d+)?\.js$/.test(pathname);
  if (!isHtml && !isPatchedModule) return asset;
  const headers = new Headers(asset.headers);
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('pragma', 'no-cache');
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}

/** Workers Static Assets redirects extensionless missing paths to `/` before
 * the Worker sees a 404. Those paths are React Router locations, so returning
 * the redirect destroys route parameters such as password-reset tokens. */
export function shouldServeSpaShell(request: Request, asset: Response): boolean {
  if (request.method !== 'GET') return false;
  const pathname = new URL(request.url).pathname;
  const isStaticAsset = pathname.startsWith('/assets/') || /\.[a-z0-9]{1,12}$/i.test(pathname);
  return !isStaticAsset && (asset.status === 404 || (asset.status >= 300 && asset.status < 400));
}
