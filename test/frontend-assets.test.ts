import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { withFrontendCachePolicy } from '../src/frontend-assets';

describe('frontend cache policy', () => {
  it.each(['/assets/index-D6X3OEUa.js', '/assets/SignInUp-CinvB_D3-v3.js'])('does not cache patched %s', async (path) => {
    const response = withFrontendCachePolicy(new Response('module', {
      headers: { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=31536000', etag: 'test' },
    }), path);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(response.headers.get('etag')).toBe('test');
    expect(await response.text()).toBe('module');
  });

  it('does not cache navigation HTML', () => {
    expect(withFrontendCachePolicy(new Response('<html></html>', { headers: { 'content-type': 'text/html' } }), '/welcome')
      .headers.get('cache-control')).toBe('no-store, max-age=0');
  });

  it('preserves caching for unchanged hashed assets', () => {
    const response = new Response('asset', { headers: { 'cache-control': 'public, max-age=31536000' } });
    expect(withFrontendCachePolicy(response, '/assets/react-M6yZRsSc.js')).toBe(response);
  });

  it('hard-resets expired sessions to welcome instead of racing into not-found', () => {
    const bundle = readFileSync(new URL('../frontend/assets/index-D6X3OEUa.js', import.meta.url), 'utf8');
    expect(bundle).toContain('b!==be.NotFound&&i2(b)&&f(b),window.location.replace(be.SignInUp)');
    expect(bundle).not.toContain('i2(b)&&f(b),n(be.SignInUp)');
  });
});
