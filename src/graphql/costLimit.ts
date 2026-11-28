import type { ApolloServerPlugin, BaseContext } from "@apollo/server";
import { DocumentNode, GraphQLError, Kind, visit } from "graphql";

export interface CostLimitOptions {
  maxDepth?: number;
  maxCost?: number;
  fieldCost?: Record<string, number>;
}

function computeDepth(doc: DocumentNode): number {
  let maxDepth = 0;

  visit(doc, {
    Field(_node, _key, _parent, _path, ancestors) {
      const depth =
        ancestors.filter((ancestor) => {
          if (Array.isArray(ancestor)) {
            return false;
          }

          return (ancestor as { kind?: string }).kind === Kind.FIELD;
        }).length + 1;

      maxDepth = Math.max(maxDepth, depth);
    },
  });

  return maxDepth;
}

function computeCost(doc: DocumentNode, options: CostLimitOptions): number {
  const fieldCost = options.fieldCost ?? {};
  let total = 0;

  visit(doc, {
    Field(node) {
      total += fieldCost[node.name.value] ?? 1;
    },
  });

  return total;
}

export function costLimitPlugin(options: CostLimitOptions = {}): ApolloServerPlugin<BaseContext> {
  const maxDepth = options.maxDepth ?? 10;
  const maxCost = options.maxCost ?? 1000;

  return {
    async requestDidStart() {
      return {
        // Refuse from didResolveOperation, not requestDidStart (#404).
        // Apollo Server treats an error thrown by requestDidStart itself as
        // a server fault — HTTP 500 with the message masked as "Internal
        // server error" — while an error thrown from didResolveOperation is
        // sent to the client as-is, and a GraphQLError carrying
        // extensions.http sets the response status. A refusal is the
        // client's problem to fix, so it answers 400 with a stable code.
        // didResolveOperation runs after parsing and validation and before
        // any resolver, so the limits still refuse before any work is done;
        // the document Apollo parsed is judged, so there is nothing to
        // re-parse here and a syntax error stays validation's problem.
        async didResolveOperation({ document }) {
          if (!document) {
            return;
          }

          const depth = computeDepth(document);
          if (depth > maxDepth) {
            throw new GraphQLError(
              `Query depth ${depth} exceeds the maximum allowed depth of ${maxDepth}`,
              { extensions: { code: "QUERY_TOO_DEEP", http: { status: 400 } } }
            );
          }

          const cost = computeCost(document, options);
          if (cost > maxCost) {
            throw new GraphQLError(
              `Query cost ${cost} exceeds the maximum allowed cost of ${maxCost}`,
              { extensions: { code: "QUERY_TOO_COSTLY", http: { status: 400 } } }
            );
          }
        },
      };
    },
  };
}
