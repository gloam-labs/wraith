import supertest from "supertest";
import { buildOpenApiDocument } from "./build";

export interface ValidationOptions {
  spec?: any;
  /**
   * If true, requests to routes not present in the OpenAPI spec fail validation.
   * If false (default), undocumented routes are skipped.
   */
  strict?: boolean;
}

export interface ValidateResponseOptions {
  method?: string;
  path?: string;
  status?: number | string;
  body?: unknown;
  headers?: Record<string, unknown>;
  spec?: any;
  strict?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  matchedPath?: string;
}

let cachedSpec: any = null;

function getSpec(customSpec?: any): any {
  if (customSpec) return customSpec;
  if (!cachedSpec) {
    cachedSpec = buildOpenApiDocument();
  }
  return cachedSpec;
}

/**
 * Reset cached OpenAPI document (useful if doc was regenerated during tests).
 */
export function resetSpecCache(): void {
  cachedSpec = null;
}

/**
 * Match an incoming URL path against OpenAPI path templates in spec.paths.
 * Returns the matching template and operation, prioritizing literal matches over parameter matches.
 */
export function matchOpenApiPath(
  spec: any,
  method: string,
  urlPath: string,
): { pathTemplate: string; operation: any } | null {
  const cleanPath = urlPath.split("?")[0].replace(/\/+$/, "") || "/";
  const urlSegments = cleanPath.split("/").filter(Boolean);
  const methodKey = method.toLowerCase();

  const candidates: Array<{
    pathTemplate: string;
    operation: any;
    literalMatches: number;
  }> = [];

  for (const [pathTemplate, pathItem] of Object.entries<any>(spec.paths || {})) {
    const templateClean = pathTemplate.replace(/\/+$/, "") || "/";
    const templateSegments = templateClean.split("/").filter(Boolean);

    if (urlSegments.length !== templateSegments.length) {
      continue;
    }

    let matches = true;
    let literalMatches = 0;

    for (let i = 0; i < urlSegments.length; i++) {
      const tSeg = templateSegments[i];
      const uSeg = urlSegments[i];

      if (tSeg.startsWith("{") && tSeg.endsWith("}")) {
        // Parameter segment matches any non-empty string
        continue;
      } else if (tSeg === uSeg) {
        literalMatches++;
      } else {
        matches = false;
        break;
      }
    }

    if (matches && pathItem && pathItem[methodKey]) {
      candidates.push({
        pathTemplate,
        operation: pathItem[methodKey],
        literalMatches,
      });
    }
  }

  if (candidates.length === 0) return null;

  // Prefer template with the highest number of literal segment matches (e.g. /webhooks/linq over /webhooks/{id})
  candidates.sort((a, b) => b.literalMatches - a.literalMatches);
  return {
    pathTemplate: candidates[0].pathTemplate,
    operation: candidates[0].operation,
  };
}

/**
 * Validate a data value against an OpenAPI 3 schema.
 * Produces readable divergence errors naming the field and direction.
 */
export function validateSchema(schema: any, data: unknown, currentPath: string): string[] {
  if (!schema || typeof schema !== "object") return [];

  // Nullable handling (OpenAPI 3.0 keyword)
  if (data === null) {
    if (schema.nullable === true) {
      return [];
    }
    return [
      currentPath
        ? `response field ${currentPath} is null, but schema is not nullable`
        : "response is null, but schema is not nullable",
    ];
  }

  if (data === undefined) {
    return [
      currentPath
        ? `response field ${currentPath} is undefined`
        : "response body is undefined",
    ];
  }

  // Type: object
  if (schema.type === "object" || (schema.properties && !schema.type)) {
    if (typeof data !== "object" || Array.isArray(data)) {
      const actualType = Array.isArray(data) ? "array" : typeof data;
      return [
        currentPath
          ? `response field ${currentPath} expected object, got ${actualType}`
          : `response expected object, got ${actualType}`,
      ];
    }

    const errors: string[] = [];
    const dataObj = data as Record<string, unknown>;
    const required: string[] = schema.required || [];
    const properties: Record<string, any> = schema.properties || {};

    // Check required fields (missing field)
    for (const reqKey of required) {
      if (!(reqKey in dataObj) || dataObj[reqKey] === undefined) {
        errors.push(
          currentPath
            ? `response.${currentPath} is missing required field ${reqKey}`
            : `response is missing required field ${reqKey}`,
        );
      }
    }

    // Check extra fields unless additionalProperties is explicitly allowed
    const allowsExtra =
      schema.additionalProperties === true ||
      (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null);

    if (!allowsExtra) {
      for (const key of Object.keys(dataObj)) {
        if (!(key in properties)) {
          errors.push(
            currentPath
              ? `response.${currentPath} has an extra field ${key}`
              : `response has an extra field ${key}`,
          );
        }
      }
    }

    // Recurse into properties
    for (const [propKey, propSchema] of Object.entries(properties)) {
      if (propKey in dataObj && dataObj[propKey] !== undefined) {
        const nextPath = currentPath ? `${currentPath}.${propKey}` : propKey;
        errors.push(...validateSchema(propSchema, dataObj[propKey], nextPath));
      }
    }

    return errors;
  }

  // Type: array
  if (schema.type === "array") {
    if (!Array.isArray(data)) {
      return [
        currentPath
          ? `response field ${currentPath} expected array, got ${typeof data}`
          : `response expected array, got ${typeof data}`,
      ];
    }

    const errors: string[] = [];
    if (schema.items) {
      for (let i = 0; i < data.length; i++) {
        const itemPath = currentPath ? `${currentPath}[${i}]` : `[${i}]`;
        errors.push(...validateSchema(schema.items, data[i], itemPath));
      }
    }
    return errors;
  }

  // Type: string
  if (schema.type === "string") {
    if (typeof data !== "string") {
      return [
        currentPath
          ? `response field ${currentPath} expected string, got ${typeof data}`
          : `response expected string, got ${typeof data}`,
      ];
    }

    if (schema.enum && !schema.enum.includes(data)) {
      return [
        currentPath
          ? `response field ${currentPath} expected one of [${schema.enum.join(", ")}], got "${data}"`
          : `response expected one of [${schema.enum.join(", ")}], got "${data}"`,
      ];
    }
    return [];
  }

  // Type: number
  if (schema.type === "number") {
    if (typeof data !== "number" || isNaN(data)) {
      return [
        currentPath
          ? `response field ${currentPath} expected number, got ${typeof data}`
          : `response expected number, got ${typeof data}`,
      ];
    }
    return [];
  }

  // Type: integer
  if (schema.type === "integer") {
    if (typeof data !== "number" || !Number.isInteger(data)) {
      const desc = typeof data === "number" ? "floating-point number" : typeof data;
      return [
        currentPath
          ? `response field ${currentPath} expected integer, got ${desc}`
          : `response expected integer, got ${desc}`,
      ];
    }
    return [];
  }

  // Type: boolean
  if (schema.type === "boolean") {
    if (typeof data !== "boolean") {
      return [
        currentPath
          ? `response field ${currentPath} expected boolean, got ${typeof data}`
          : `response expected boolean, got ${typeof data}`,
      ];
    }
    return [];
  }

  // Enum without type
  if (schema.enum && !schema.enum.includes(data)) {
    return [
      currentPath
        ? `response field ${currentPath} expected one of [${schema.enum.join(", ")}], got "${data}"`
        : `response expected one of [${schema.enum.join(", ")}], got "${data}"`,
    ];
  }

  return [];
}

/**
 * Validate a response against the OpenAPI specification.
 *
 * Can be called with (method, path, status, body, spec?) or with an options object.
 */
export function validateResponseAgainstSpec(
  methodOrOptions: string | ValidateResponseOptions | any,
  path?: string,
  status?: number | string,
  body?: unknown,
  spec?: any,
): ValidationResult {
  let reqMethod: string;
  let reqPath: string;
  let resStatus: number | string;
  let resBody: unknown;
  let resHeaders: Record<string, unknown> | undefined;
  let doc: any;
  let strict = false;

  if (typeof methodOrOptions === "object" && methodOrOptions !== null) {
    if ("path" in methodOrOptions || "method" in methodOrOptions) {
      // ValidateResponseOptions
      const opts = methodOrOptions as ValidateResponseOptions;
      reqMethod = (opts.method || "GET").toLowerCase();
      reqPath = opts.path || "/";
      resStatus = opts.status ?? 200;
      resBody = opts.body;
      resHeaders = opts.headers;
      doc = getSpec(opts.spec);
      strict = opts.strict ?? false;
    } else if ("status" in methodOrOptions && "body" in methodOrOptions) {
      // Supertest / SuperAgent Response object
      const res = methodOrOptions;
      reqMethod = (res.req?.method || res.request?.method || "GET").toLowerCase();
      reqPath = res.req?.path ? res.req.path.split("?")[0] : "/";
      resStatus = res.status;
      resBody = res.body;
      resHeaders = res.headers || res.header;
      doc = getSpec(spec);
    } else {
      reqMethod = "GET";
      reqPath = "/";
      resStatus = 200;
      resBody = undefined;
      doc = getSpec(spec);
    }
  } else {
    reqMethod = String(methodOrOptions).toLowerCase();
    reqPath = path || "/";
    resStatus = status ?? 200;
    resBody = body;
    doc = getSpec(spec);
  }

  const match = matchOpenApiPath(doc, reqMethod, reqPath);
  if (!match) {
    if (strict) {
      return {
        valid: false,
        errors: [`Route not found in OpenAPI spec: ${reqMethod.toUpperCase()} ${reqPath}`],
      };
    }
    // Undocumented route skipped when not strict
    return { valid: true, errors: [] };
  }

  const { pathTemplate, operation } = match;
  const responses = operation.responses || {};
  const statusStr = String(resStatus);
  const responseDef = responses[statusStr] || responses["default"];

  if (!responseDef) {
    return {
      valid: false,
      errors: [
        `Response status ${statusStr} is not documented in OpenAPI spec for ${reqMethod.toUpperCase()} ${pathTemplate}`,
      ],
      matchedPath: pathTemplate,
    };
  }

  const jsonContent = responseDef.content?.["application/json"];
  if (!jsonContent) {
    // Non-JSON response or empty response definition
    return { valid: true, errors: [], matchedPath: pathTemplate };
  }

  const schema = jsonContent.schema;
  if (!schema) {
    return { valid: true, errors: [], matchedPath: pathTemplate };
  }

  const errors = validateSchema(schema, resBody, "");
  return {
    valid: errors.length === 0,
    errors,
    matchedPath: pathTemplate,
  };
}

/**
 * Assert that a response matches the OpenAPI spec. Throws with informative error message on divergence.
 */
export function assertResponseMatchesSpec(
  methodOrRes: string | any,
  path?: string,
  status?: number | string,
  body?: unknown,
  spec?: any,
): void {
  const result = validateResponseAgainstSpec(methodOrRes, path, status, body, spec);
  if (!result.valid) {
    const method = typeof methodOrRes === "string" ? methodOrRes.toUpperCase() : (methodOrRes.req?.method || "GET").toUpperCase();
    const route = result.matchedPath || path || (typeof methodOrRes === "object" ? methodOrRes.req?.path : "");
    throw new Error(
      `OpenAPI contract violation for ${method} ${route}: ${result.errors.join("; ")}`,
    );
  }
}

let isInstalled = false;
let originalAssert: Function | null = null;

/**
 * Install the OpenAPI response validator into supertest.
 * Once installed, every supertest request in the suite validates its response
 * against the OpenAPI spec automatically, without rewriting test cases.
 */
export function installOpenApiValidator(options: ValidationOptions = {}): void {
  if (isInstalled) return;

  const TestClass = (supertest as any).Test;
  if (!TestClass || !TestClass.prototype || typeof TestClass.prototype.assert !== "function") {
    console.warn("[openapi-validator] Could not find supertest.Test.prototype.assert to hook");
    return;
  }

  originalAssert = TestClass.prototype.assert;

  TestClass.prototype.assert = function (this: any, resError: any, res: any, fn: any) {
    let errorObj = resError;

    // Validate the response against the OpenAPI spec whenever a response was received
    if (res) {
      try {
        const method = (this.method || res.req?.method || "GET").toLowerCase();
        const urlStr = this.url || res.req?.path || "";
        const pathname = urlStr.startsWith("http")
          ? new URL(urlStr).pathname
          : (res.req?.path ? res.req.path.split("?")[0] : urlStr.split("?")[0]);

        const result = validateResponseAgainstSpec({
          method,
          path: pathname,
          status: res.status,
          body: res.body,
          headers: res.headers || res.header,
          spec: options.spec,
          strict: options.strict,
        });

        if (!result.valid) {
          const route = result.matchedPath || pathname;
          errorObj = new Error(
            `OpenAPI contract violation for ${method.toUpperCase()} ${route} (${res.status}): ${result.errors.join("; ")}`,
          );
          (errorObj as any).expected = "OpenAPI compliant response";
          (errorObj as any).actual = result.errors.join("; ");
        }
      } catch (e) {
        errorObj = e;
      }
    }

    return (originalAssert as Function).call(this, errorObj, res, fn);
  };

  isInstalled = true;
}

/**
 * Uninstall the OpenAPI validator and restore supertest's original assertion method.
 */
export function uninstallOpenApiValidator(): void {
  if (!isInstalled || !originalAssert) return;

  const TestClass = (supertest as any).Test;
  if (TestClass && TestClass.prototype) {
    TestClass.prototype.assert = originalAssert;
  }

  isInstalled = false;
  originalAssert = null;
}
