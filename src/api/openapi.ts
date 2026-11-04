/**
 * Hand-written OpenAPI 3 document for the Riverbend API (009). Kept in sync with the typed routes.
 * Served (with Swagger UI) only in non-production, and never contains a secret.
 *
 * Three credential kinds — do not confuse them:
 *  - **Admin credential** (`rb_admin_bootstrap.<ADMIN_BOOTSTRAP_TOKEN>`): platform operator; /admin only.
 *  - **Shop API key** (`rb_shop_<prefix>.<secret>`): one tenant; /v1 routes; scoped + optionally expiring.
 *  - **LiteLLM virtual key**: internal, per-shop, for the model proxy — NEVER returned by any endpoint.
 */
const bearerErr = {
  description: 'Error',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
};

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Riverbend Cycles — Work-Order Intake API',
    version: '1.0.0',
    description:
      'Multi-tenant work-order intake. Auth is a Bearer **shop API key** for `/v1`, or the **admin** ' +
      'credential for `/admin`. Shop identity always comes from the credential (never the body/URL). ' +
      'Tenant isolation is enforced by PostgreSQL RLS. LiteLLM virtual keys are internal and never exposed.',
  },
  servers: [{ url: 'http://localhost:8080', description: 'Local' }],
  tags: [
    { name: 'Intake', description: 'Customer message intake (idempotent)' },
    { name: 'Status', description: 'Request status tracking' },
    { name: 'Orders', description: 'Tenant-scoped staff reads (scope: orders:read)' },
    { name: 'Catalog', description: 'Shared 12-service catalog' },
    { name: 'Admin', description: 'Operator-only: shop + credential provisioning' },
  ],
  components: {
    securitySchemes: {
      shopKey: { type: 'http', scheme: 'bearer', description: 'Shop API key: `rb_shop_<prefix>.<secret>`' },
      adminKey: { type: 'http', scheme: 'bearer', description: 'Admin credential: `rb_admin_bootstrap.<token>` (operator only)' },
    },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } }, required: ['error'] },
      SubmitMessage: {
        type: 'object', required: ['source', 'submission_id', 'content'],
        properties: {
          source: { type: 'string', enum: ['email', 'web', 'api'] },
          submission_id: { type: 'string', description: 'Stable per-source id; idempotency key is (shop, source, submission_id). Max 20000 chars of content.' },
          content: { type: 'string', maxLength: 20000 },
          customer_email: { type: 'string', description: 'Reply path (mandatory for web).' },
        },
      },
      RequestStatus: {
        type: 'object',
        properties: {
          request_id: { type: 'string' },
          state: { type: 'string', enum: ['received', 'awaiting_pipeline', 'processing', 'extracted', 'ordered', 'answered', 'awaiting_customer', 'needs_review', 'held_budget', 'cancelled'], description: '`held_budget` = AI budget exhausted or paused (fail-closed, no charge).' },
          source: { type: 'string' }, submission_id: { type: 'string' }, received_at: { type: 'string' },
        },
      },
      IssuedCredential: {
        type: 'object',
        description: 'The plaintext `secret` is shown ONCE and never retrievable afterwards.',
        properties: {
          id: { type: 'string' }, kind: { type: 'string', enum: ['shop'] }, shop_id: { type: 'string' },
          prefix: { type: 'string', description: 'Public masked identifier' }, secret: { type: 'string', description: 'One-time plaintext key' },
          scopes: { type: 'array', items: { type: 'string' } }, expires_at: { type: 'string', nullable: true },
        },
      },
      MaskedCredential: {
        type: 'object', description: 'Never includes the secret.',
        properties: {
          id: { type: 'string' }, kind: { type: 'string' }, prefix: { type: 'string' }, name: { type: 'string', nullable: true },
          scopes: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['active', 'revoked'] },
          created_at: { type: 'string' }, expires_at: { type: 'string', nullable: true }, last_used_at: { type: 'string', nullable: true }, revoked_at: { type: 'string', nullable: true },
        },
      },
    },
  },
  paths: {
    '/healthz': { get: { summary: 'Liveness', security: [], responses: { '200': { description: 'alive' } } } },
    '/readyz': { get: { summary: 'Readiness (migrated + isolation policies forced)', security: [], responses: { '200': { description: 'ready' }, '503': bearerErr } } },
    '/v1/messages': {
      post: {
        tags: ['Intake'], summary: 'Submit a customer message (idempotent)', security: [{ shopKey: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitMessage' } } } },
        responses: {
          '202': { description: 'Accepted — returns request_id + status_url. Re-sending the same (source, submission_id) with identical content replays the same request.' },
          '401': bearerErr, '409': { description: 'Same submission_id reused with DIFFERENT content', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }, '422': bearerErr,
        },
      },
    },
    '/v1/requests/{id}': {
      get: {
        tags: ['Status'], summary: 'Get request status (tenant-scoped)', security: [{ shopKey: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Status', content: { 'application/json': { schema: { $ref: '#/components/schemas/RequestStatus' } } } }, '401': bearerErr, '404': { description: 'Not found or belongs to another shop (isolation)' } },
      },
    },
    '/v1/orders': { get: { tags: ['Orders'], summary: 'Open work orders (scope: orders:read)', security: [{ shopKey: [] }], responses: { '200': { description: 'Orders + shop_total_cents' }, '401': bearerErr, '403': { description: 'insufficient_scope' } } } },
    '/v1/needs-attention': { get: { tags: ['Orders'], summary: 'Needs-attention queue (scope: orders:read)', security: [{ shopKey: [] }], responses: { '200': { description: 'Items' }, '401': bearerErr, '403': bearerErr } } },
    '/v1/catalog': { get: { tags: ['Catalog'], summary: '12-service catalog + version', security: [{ shopKey: [] }], responses: { '200': { description: 'Catalog' }, '401': bearerErr } } },
    '/v1/shop': { get: { tags: ['Status'], summary: "The caller's own shop", security: [{ shopKey: [] }], responses: { '200': { description: 'Shop' }, '401': bearerErr } } },
    '/admin/shops': { post: { tags: ['Admin'], summary: 'Create a shop (operator)', security: [{ adminKey: [] }], responses: { '201': { description: 'Created' }, '401': bearerErr, '403': { description: 'A shop key was used on an admin route' }, '409': bearerErr, '422': bearerErr } } },
    '/admin/shops/{slug}/credentials': {
      post: {
        tags: ['Admin'], summary: 'Issue a shop API key (plaintext shown once)', security: [{ adminKey: [] }],
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } }, expires_in_days: { type: 'integer' } } } } } },
        responses: { '201': { description: 'Issued', content: { 'application/json': { schema: { $ref: '#/components/schemas/IssuedCredential' } } } }, '401': bearerErr, '403': bearerErr, '404': bearerErr },
      },
      get: {
        tags: ['Admin'], summary: "List a shop's credentials (masked — no secret)", security: [{ adminKey: [] }],
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Masked list', content: { 'application/json': { schema: { type: 'object', properties: { credentials: { type: 'array', items: { $ref: '#/components/schemas/MaskedCredential' } } } } } } }, '401': bearerErr, '404': bearerErr },
      },
    },
    '/admin/credentials/{id}/revoke': { post: { tags: ['Admin'], summary: 'Revoke a credential', security: [{ adminKey: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '204': { description: 'Revoked' }, '401': bearerErr, '404': bearerErr } } },
    '/admin/credentials/{id}/rotate': { post: { tags: ['Admin'], summary: 'Rotate a shop key (revoke old, issue new)', security: [{ adminKey: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '201': { description: 'New key (plaintext once)', content: { 'application/json': { schema: { $ref: '#/components/schemas/IssuedCredential' } } } }, '401': bearerErr, '404': bearerErr } } },
  },
} as const;
