// Module-boundary rules (D1, Constitution Principle IV).
// Enforced in CI: modules talk only via each other's public index.ts, never another module's
// internals or tables; the api process must not import worker-only or (future) AI code.
module.exports = {
  forbidden: [
    {
      name: 'no-cross-module-internals',
      comment:
        'A module may import another module only through its public index.ts, never its internals.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/.+',
        pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'business-logic-no-framework',
      comment: 'Business modules must not import the HTTP framework directly (Principle IV).',
      severity: 'error',
      from: { path: '^src/modules/' },
      to: { path: '^node_modules/express' },
    },
    {
      name: 'api-not-worker',
      comment: 'The api process must not import worker-only code (D1).',
      severity: 'error',
      from: { path: '^src/api/' },
      to: { path: '^src/worker/' },
    },
    {
      name: 'queue-only-via-port',
      comment:
        'Use the JobQueue port (platform/queue/index.ts); only the worker composition root may construct the pg-boss adapter.',
      severity: 'error',
      from: { pathNot: ['^src/platform/queue/', '^src/worker/index\\.ts$'] },
      to: { path: '^src/platform/queue/pgboss-adapter\\.ts$' },
    },
    {
      name: 'modules-no-queue-adapter',
      comment: 'Business modules must not import pg-boss directly.',
      severity: 'error',
      from: { path: '^src/modules/' },
      to: { path: '^node_modules/pg-boss' },
    },
    {
      name: 'no-orphans',
      comment: 'Unreachable modules are usually a mistake.',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: ['\\.d\\.ts$', '(^|/)index\\.ts$', '^src/migrations/', '^src/(api|worker)/'],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'node'] },
  },
};
