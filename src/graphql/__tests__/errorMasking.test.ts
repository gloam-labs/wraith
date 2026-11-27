/**
 * Error masking at /graphql (#404, review follow-up).
 *
 * The plugins' refusals answer 400 with their real message and a stable
 * code — but that must be the ONLY leak. A genuinely unexpected failure
 * (here a resolver whose database call blows up with a connection string)
 * has to stay masked as "Internal server error": Apollo Server does not
 * mask execution errors by itself, so server.ts installs
 * formatGraphQLError, which masks every error that arrives without a code
 * of its own (Apollo stamps those INTERNAL_SERVER_ERROR) and passes coded,
 * deliberate client errors through untouched.
 *
 * The HTTP-level pin lives in src/__tests__/graphql.test.ts ("still masks
 * a genuinely unexpected failure at /graphql"); this file drives the same
 * server configuration — both plugins plus the formatter — through a real
 * ApolloServer, which needs no database.
 */
import { ApolloServer } from "@apollo/server";
import { GraphQLError } from "graphql";
import { costLimitPlugin } from "../costLimit";
import { formatGraphQLError } from "../formatError";
import { persistedQueryPlugin, resetPersistedQueryCache } from "../persisted";

describe("formatGraphQLError", () => {
  it("masks an error Apollo stamped INTERNAL_SERVER_ERROR", () => {
    const formatted = formatGraphQLError({
      message: "postgres://user:secret@db.internal:5432/wraith",
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    });

    expect(formatted.message).toBe("Internal server error");
    expect(formatted.extensions?.code).toBe("INTERNAL_SERVER_ERROR");
    expect(JSON.stringify(formatted)).not.toContain("secret");
  });

  it("masks an error with no code at all", () => {
    expect(formatGraphQLError({ message: "boom" }).message).toBe("Internal server error");
  });

  it("passes a coded, deliberate client error through untouched", () => {
    const refusal = {
      message: "Persisted query hash is required in production",
      extensions: { code: "PERSISTED_QUERY_REQUIRED" },
    };
    expect(formatGraphQLError(refusal)).toEqual(refusal);

    const badInput = {
      message: 'Invalid cursor: "x". Pass back the nextCursor from a previous page.',
      extensions: { code: "BAD_USER_INPUT" },
    };
    expect(formatGraphQLError(badInput)).toEqual(badInput);
  });
});

describe("masking through a real ApolloServer", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      boom: String
      badInput: String
      health: Boolean
    }
  `;

  const resolvers = {
    Query: {
      boom: () => {
        throw new Error("postgres://user:secret@db.internal:5432/wraith");
      },
      badInput: () => {
        throw new GraphQLError('Invalid cursor: "x".', {
          extensions: { code: "BAD_USER_INPUT" },
        });
      },
      health: () => true,
    },
  };

  // Mirrors createGraphQLMiddleware in server.ts.
  const server = new ApolloServer({
    typeDefs,
    resolvers,
    persistedQueries: false,
    formatError: formatGraphQLError,
    plugins: [persistedQueryPlugin, costLimitPlugin({ maxDepth: 10, maxCost: 1000 })],
  });

  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetPersistedQueryCache();
  });

  it("masks a genuinely unexpected resolver failure", async () => {
    const res = await server.executeOperation({ query: "{ boom }" });

    if (res.body?.kind !== "single") throw new Error("expected a single result");
    const [error] = res.body.singleResult.errors ?? [];
    expect(error?.message).toBe("Internal server error");
    expect(error?.extensions?.code).toBe("INTERNAL_SERVER_ERROR");
    expect(JSON.stringify(res.body.singleResult)).not.toContain("secret");
    expect(JSON.stringify(res.body.singleResult)).not.toContain("db.internal");
  });

  it("keeps a deliberate BAD_USER_INPUT message readable", async () => {
    const res = await server.executeOperation({ query: "{ badInput }" });

    if (res.body?.kind !== "single") throw new Error("expected a single result");
    const [error] = res.body.singleResult.errors ?? [];
    expect(error?.message).toBe('Invalid cursor: "x".');
    expect(error?.extensions?.code).toBe("BAD_USER_INPUT");
  });

  it("still answers a plugin refusal 400 with its real message", async () => {
    process.env.NODE_ENV = "production";

    const res = await server.executeOperation({ query: "{ health }" });

    if (res.body?.kind !== "single") throw new Error("expected a single result");
    expect(res.http.status).toBe(400);
    const [error] = res.body.singleResult.errors ?? [];
    expect(error?.message).toBe("Persisted query hash is required in production");
    expect(error?.extensions?.code).toBe("PERSISTED_QUERY_REQUIRED");
  });

  it("still answers an over-cost query 400 with its real message", async () => {
    const limited = new ApolloServer({
      typeDefs,
      resolvers,
      persistedQueries: false,
      formatError: formatGraphQLError,
      plugins: [costLimitPlugin({ maxDepth: 10, maxCost: 1 })],
    });
    await limited.start();
    try {
      const res = await limited.executeOperation({ query: "{ a: health b: health }" });

      if (res.body?.kind !== "single") throw new Error("expected a single result");
      expect(res.http.status).toBe(400);
      const [error] = res.body.singleResult.errors ?? [];
      expect(error?.message).toBe("Query cost 2 exceeds the maximum allowed cost of 1");
      expect(error?.extensions?.code).toBe("QUERY_TOO_COSTLY");
    } finally {
      await limited.stop();
    }
  });
});
