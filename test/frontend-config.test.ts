import { describe, expect, it } from 'vitest';
import { frontendClientConfig } from '../src/frontend-config';

describe('frontend client configuration', () => {
  it('identifies the deployed application as a production instance', () => {
    const config = frontendClientConfig(new URL('https://twenty-crm.observatorio-publico.workers.dev/client-config'));

    expect(config.enterpriseInstanceType).toBe('PRODUCTION');
  });
});
