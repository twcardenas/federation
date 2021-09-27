import { buildSchema, GraphQLError, printIntrospectionSchema } from "graphql";
import { IntrospectionResult } from "./utils";

export function introspect(
  sdl: string,
): IntrospectionResult {

  const graphQLErrors: GraphQLError[] = [];
  let graphqlSchemaObj;
  try {
    graphqlSchemaObj = buildSchema(sdl);
  } catch (e) {
    graphQLErrors.push(new GraphQLError(`couldn't build schema from sdl: ${e}. ${e.message}`));
  }

  if (graphQLErrors.length > 0) {
    return {
      errors: graphQLErrors
    };
  }
  if (!graphqlSchemaObj) {
    return {
      errors: [new GraphQLError("couldn't build a valid schema from sdl.")]
    };
  }

  return {
    introspectionQueryResult: printIntrospectionSchema(graphqlSchemaObj)
  };
}
