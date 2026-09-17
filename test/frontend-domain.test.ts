import { expect, it } from 'vitest';
import { frontendDomain } from '../src/frontend-domain';

it.each(['twenty-crm.observatorio-publico.workers.dev', 'preview-twenty.example.com', 'localhost'])('reconstructs the actual login hostname %s', hostname => {
  const config = frontendDomain(hostname);
  const upstreamDefaultDomain = config.isMultiWorkspaceEnabled
    ? `${config.defaultSubdomain}.${config.frontDomain}` : config.frontDomain;
  expect(upstreamDefaultDomain).toBe(hostname);
});
