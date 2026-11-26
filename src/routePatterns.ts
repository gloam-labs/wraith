import express, { Application } from "express";

type UseTarget = { use: (...args: unknown[]) => unknown };
const mountedAt = new WeakMap<object, string>();
const routePatternMap = new WeakMap<object, string>();

let instrumented = false;

/**
 * Record every `use(path, router)` mount before routes are registered.
 *
 * Express 5 does not keep the mount path as a string on Layer instances:
 * it is captured inside path-to-regexp closures. Capturing the mount path
 * at registration time allows us to reconstruct the full route pattern
 * from static patterns only, avoiding runtime URL/baseUrl reads.
 */
export function ensureRouterMountTracking(): void {
  if (instrumented) return;
  instrumented = true;

  function recordMounts(target: UseTarget) {
    const original = target.use;
    target.use = function (this: unknown, mountPath: unknown, ...handlers: unknown[]) {
      if (typeof mountPath === "string") {
        for (const handler of handlers) {
          if (
            typeof handler === "function" &&
            Array.isArray((handler as { stack?: unknown }).stack)
          ) {
            mountedAt.set(handler, mountPath);
          }
        }
      }
      return original.apply(this, [mountPath, ...handlers]);
    };
  }

  recordMounts((express as unknown as { application: UseTarget }).application);

  const originalRouterFactory = express.Router as unknown as (...args: unknown[]) => UseTarget;
  (express as unknown as { Router: unknown }).Router = function (
    this: unknown,
    ...args: unknown[]
  ) {
    const router = originalRouterFactory.apply(this, args);
    recordMounts(router);
    return router;
  };
}

// Ensure instrumentation is active upon module load
ensureRouterMountTracking();

export function combinePaths(prefix: string, p: string): string {
  if (!p || p === "/") {
    return prefix || "/";
  }
  if (!prefix || prefix === "/") {
    return p.startsWith("/") ? p : `/${p}`;
  }
  const cleanPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const cleanP = p.startsWith("/") ? p : `/${p}`;
  return cleanPrefix + cleanP;
}

/**
 * Walk the application router tree and map each static Route object
 * to its full route pattern.
 */
export function indexRoutePatterns(app: Application): void {
  function walk(stack: unknown[], prefix: string) {
    for (const layer of stack as Array<{ route?: object & { path: string }; handle?: { stack?: unknown[] } }>) {
      if (layer.route) {
        const full = combinePaths(prefix, layer.route.path);
        routePatternMap.set(layer.route, full);
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        const mount = mountedAt.get(layer.handle) ?? "";
        walk(layer.handle.stack, combinePaths(prefix, mount));
      }
    }
  }

  const router = (app as unknown as { router?: { stack?: unknown[] }; _router?: { stack?: unknown[] } }).router ??
    (app as unknown as { _router?: { stack?: unknown[] } })._router;
  if (router && Array.isArray(router.stack)) {
    walk(router.stack, "");
  }
}

/**
 * Return the full route pattern for the matched Express Route.
 * Returns "unknown" if route is undefined or unmatched.
 */
export function getRoutePattern(route: (object & { path?: string }) | undefined | null): string {
  if (!route) return "unknown";
  return routePatternMap.get(route) ?? route.path ?? "unknown";
}
