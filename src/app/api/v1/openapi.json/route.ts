/**
 * GET /api/v1/openapi.json — OpenAPI 3.1 spec for the Aweb Agent public API.
 */
import { json, preflight } from '@/lib/api/http';

export const runtime = 'nodejs';

export function OPTIONS() {
  return preflight();
}

export function GET() {
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'Aweb Agent API',
      version: '1.0.0',
      description:
        'Governance + verifiable, on-chain-anchored receipts for the verified-human agent economy on World. World proves a human is behind the agent; Aweb proves the agent behaved.',
      license: { name: 'Apache-2.0' },
    },
    servers: [{ url: 'https://agent.aweblabs.ai' }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
    paths: {
      '/api/v1/missions': {
        post: {
          summary: 'Create + plan a governed mission',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['goal'], properties: { goal: { type: 'string' } } } } },
          },
          responses: { '201': { description: 'Mission planned (returns plan, planHash, needsApproval).' }, '401': { description: 'Unauthorized' }, '422': { description: 'Plan blocked by policy' } },
        },
      },
      '/api/v1/missions/{id}': {
        get: { summary: 'Mission status', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Status + plan' }, '404': { description: 'Not found' } } },
      },
      '/api/v1/missions/{id}/execute': {
        post: {
          summary: 'Execute to a sealed + anchored receipt',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { proof: { type: 'object' }, walletAddress: { type: 'string' } } } } } },
          responses: { '200': { description: 'Receipt' }, '401': { description: 'Unauthorized' }, '428': { description: 'World ID approval required (returns signal)' } },
        },
      },
      '/api/v1/receipts/{id}': {
        get: {
          summary: 'Full verifiable receipt + attestation',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'onchain', in: 'query', required: false, schema: { type: 'string', enum: ['1'] }, description: 'Verify anchor calldata on World Chain.' },
          ],
          responses: { '200': { description: 'Receipt + attestation' }, '404': { description: 'Not found' } },
        },
      },
      '/api/v1/receipts/{id}/verify': {
        get: {
          summary: 'Attestation only (integrity ∧ authenticity ∧ anchor)',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'onchain', in: 'query', required: false, schema: { type: 'string', enum: ['1'] } },
          ],
          responses: { '200': { description: 'Attestation' }, '404': { description: 'Not found' } },
        },
      },
    },
  };
  return json(spec);
}
