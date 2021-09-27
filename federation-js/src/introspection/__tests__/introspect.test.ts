import {
  astSerializer,
  typeSerializer,
  selectionSetSerializer,
  graphqlErrorSerializer,
} from 'apollo-federation-integration-testsuite';
import {
  assertIntrospectionFailure,
  assertIntrospectionSuccess,
} from '../utils';
import { introspect } from '..';

expect.addSnapshotSerializer(astSerializer);
expect.addSnapshotSerializer(typeSerializer);
expect.addSnapshotSerializer(selectionSetSerializer);
expect.addSnapshotSerializer(graphqlErrorSerializer);

describe('introspect', () => {
  it('should introspect correctly on valid sdl', () => {
    const validSDL = `schema
      {
        query: Query
      }

      type Query {
        hello: String
      }
    `;

    const introspectionResult = introspect(validSDL);

    assertIntrospectionSuccess(introspectionResult, JSON.stringify(introspectionResult));
    const { introspectionQueryResult } = introspectionResult;
    expect(introspectionQueryResult).toBeDefined();
  });

  it('should fail introspection correctly on invalid sdl', () => {
    const invalidSDL = "THIS SDL IS DEFINITELY NOT VALID";

    const introspectionResult = introspect(invalidSDL);

    assertIntrospectionFailure(introspectionResult, JSON.stringify(introspectionResult));
    const { errors } = introspectionResult;
    expect(errors).toBeDefined();
    expect(errors?.length).toBeGreaterThan(0);

  });
});
