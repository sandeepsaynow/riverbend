import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';

/** Router factory so business modules never import `express` directly (Principle IV boundary). */
export function createRouter(): Router {
  return express.Router();
}
export type { Router, Request, Response, NextFunction } from 'express';

/**
 * Minimal typed-route helper (D12). Every endpoint declares Zod schemas for its input and a
 * response schema, and is recorded in a registry so a CI contract test can fail the build if any
 * mounted route lacks schemas (tasks T054). Business handlers never touch Express response objects
 * directly — they return a plain { status, body }.
 */
export interface RouteSchemas<P, Q, B, R> {
  params?: z.ZodType<P>;
  query?: z.ZodType<Q>;
  body?: z.ZodType<B>;
  response: z.ZodType<R>;
}

export interface RouteContext<P, Q, B> {
  params: P;
  query: Q;
  body: B;
  req: Request;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

export interface RouteDef<P, Q, B, R> {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  schemas: RouteSchemas<P, Q, B, R>;
  handler: (ctx: RouteContext<P, Q, B>) => Promise<RouteResult> | RouteResult;
}

export interface RegisteredRoute {
  method: string;
  path: string;
  hasParams: boolean;
  hasBody: boolean;
  hasResponse: boolean;
}

const registry: RegisteredRoute[] = [];
/** All routes declared via defineRoute, for the route-schema contract test. */
export function registeredRoutes(): readonly RegisteredRoute[] {
  return registry;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export function defineRoute<P = unknown, Q = unknown, B = unknown, R = unknown>(
  router: Router,
  def: RouteDef<P, Q, B, R>,
): void {
  registry.push({
    method: def.method.toUpperCase(),
    path: def.path,
    hasParams: def.schemas.params !== undefined,
    hasBody: def.schemas.body !== undefined,
    hasResponse: def.schemas.response !== undefined,
  });

  router[def.method](def.path, async (req: Request, res: Response) => {
    const ctx: RouteContext<P, Q, B> = {
      params: (def.schemas.params ? def.schemas.params.parse(req.params) : (req.params as P)),
      query: (def.schemas.query ? def.schemas.query.parse(req.query) : (req.query as Q)),
      body: (def.schemas.body ? def.schemas.body.parse(req.body) : (req.body as B)),
      req,
    };
    const result = await def.handler(ctx);
    if (result.status === 204 || result.body === undefined) {
      res.status(result.status).end();
      return;
    }
    res.status(result.status).json(result.body);
  });
}
