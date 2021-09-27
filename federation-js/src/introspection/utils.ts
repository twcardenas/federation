import {
  GraphQLError,
} from 'graphql';

export type IntrospectionResult = IntrospectionFailure | IntrospectionSuccess;

export interface IntrospectionFailure {
  errors: GraphQLError[];
  introspectionQueryResult?: undefined;
}

export interface IntrospectionSuccess {
  introspectionQueryResult: string;
  errors?: undefined;
}


export function introspectionHasErrors(
  introspectionResult: IntrospectionResult,
): introspectionResult is IntrospectionFailure {
  return 'errors' in introspectionResult && !!introspectionResult.errors;
}

// This assertion function should be used for the sake of convenient type refinement.
// It should not be depended on for causing a test to fail. If an error is thrown
// from here, its use should be reconsidered.
export function assertIntrospectionSuccess(
  introspectionResult: IntrospectionResult,
  message?: string,
): asserts introspectionResult is IntrospectionSuccess {
  if (introspectionHasErrors(introspectionResult)) {
    throw new Error(message || 'Unexpected test failure');
  }
}

// This assertion function should be used for the sake of convenient type refinement.
// It should not be depended on for causing a test to fail. If an error is thrown
// from here, its use should be reconsidered.
export function assertIntrospectionFailure(
  introspectionResult: IntrospectionResult,
  message?: string,
): asserts introspectionResult is IntrospectionFailure {
  if (!introspectionHasErrors(introspectionResult)) {
    throw new Error(message || 'Unexpected test failure');
  }
}
