import { buildSchema, graphqlSync, getIntrospectionQuery, GraphQLError } from "graphql";
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

  if (!graphqlSchemaObj) {
    return {
      errors: graphQLErrors
    }
  }

  let introspectionResult;
  try {
    introspectionResult = graphqlSync(graphqlSchemaObj, getIntrospectionQuery());
  } catch (e) {
    graphQLErrors.push(new GraphQLError(`couldn't run introspection query on schema: ${e}. ${e.message}`));
  }

  if (!introspectionResult) {
    return {
      errors: graphQLErrors
    }
  }

  if (introspectionResult.errors) {
    return {
      errors: [...introspectionResult.errors],
    }
  }

  if (!introspectionResult.data) {
    return {
      errors: [new GraphQLError("empty introspection query result")]
    }
  }
  return {
    introspectionQueryResult:  JSON.stringify(introspectionResult.data)
  }
}
