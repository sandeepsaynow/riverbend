import express from 'express';
import { openApiDocument } from './openapi.js';

/**
 * OpenAPI JSON + Swagger UI (009 FR-007). Mounted only when docs are enabled (non-production, or
 * DOCS_ENABLED=true) so the interactive, admin-labelled documentation is never public in production.
 * Swagger UI is loaded from cdnjs; a route-scoped CSP permits it (overriding the global strict CSP).
 */
export function registerDocsRoutes(app: express.Express): void {
  app.get('/openapi.json', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(openApiDocument);
  });

  app.get('/docs', (_req, res) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data:; connect-src 'self'",
    );
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Riverbend API — Swagger UI</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui.min.css">
</head><body><div id="ui"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui-bundle.min.js"></script>
<script>window.onload=function(){SwaggerUIBundle({url:'/openapi.json',dom_id:'#ui',deepLinking:true});};</script>
</body></html>`);
  });
}
