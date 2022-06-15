import {
  CoreFeature,
  CoreImport,
  didYouMean,
  DirectiveDefinition,
  ERRORS,
  federationIdentity,
  Subgraphs,
  suggestionList,
  type SubtypingRule,
} from "@apollo/federation-internals";
import { GraphQLError } from 'graphql';

export type CompositionOptions = {
  mergeDirectives?: string[],
  allowedFieldTypeMergingSubtypingRules?: SubtypingRule[],
};

export const validateCompositionOptions = (toMerge: Subgraphs, options?: CompositionOptions): GraphQLError[] => {
  // for mergeDirectives, we want to validate that every directive specified starts with a '@'
  // and exists on some subgraph. Also ensure that non of the directives are builtin or federation directives
  const subgraphs = toMerge.values();
  const mergeDirectives = options?.mergeDirectives ?? [];
  const errors: GraphQLError[] = [];
  mergeDirectives.forEach(directiveName => {
    if (directiveName[0] !== '@') {
      errors.push(ERRORS.MERGE_DIRECTIVES_NO_LEADING_AT.err({ message: `Directive "${directiveName}" in "mergeDirectives" argument does not begin with a "@"` }));
    } else {
      const directiveNameWithoutAt = directiveName.slice(1);

      // for the directive specified, get the DirectiveDefinition for each subgraph it appears in
      const subgraphDirectives = subgraphs
        .map(sg => sg.schema.directive(directiveNameWithoutAt))
        .filter((directive): directive is DirectiveDefinition => directive !== undefined);

      if (subgraphDirectives.length === 0) {
        // If the directive does not appear in any subgraph, throw an error. Provide a suggestion if we think it's a typo.
        const allDirectives = new Set<string>();
        subgraphs.forEach(sg => {
          sg.schema.allDirectives().forEach(directive => {
            allDirectives.add(`@${directive.name}`);
          });
        });

        const suggestions = suggestionList(directiveNameWithoutAt, Array.from(allDirectives));
        errors.push(ERRORS.MERGE_DIRECTIVES_DIRECTIVE_DOES_NOT_EXIST.err({ message: `Directive "${directiveName}" in "mergeDirectives" argument does not exist in any subgraph. ${didYouMean(suggestions)}` }));
      } else if (subgraphDirectives.some(directive => directive.isBuiltIn)) {
        errors.push(ERRORS.MERGE_DIRECTIVES_BUILT_IN_DIRECTIVE.err({ message: `Directive "${directiveName}" cannot be specified in "mergeDirectives" argument because it is a built in directive` }));
      } else {
        // we want to block composition if they use a fed 2 directive, but allow it if they've renamed it in all subgraphs it's used in
        // NOTE: @link does not exist as a CoreImport on the CoreFeature defined at `linkIdentity`, so we hardcode it
        const federationDirectiveNames = new Set<string>(['@link']);
        subgraphs.forEach(sg => {

          // For the current subgraph, collect all CoreImport objects in a single array
          const coreImports = [
            sg.schema.coreFeatures?.getByIdentity(federationIdentity)
          ]
          .filter((feature): feature is CoreFeature => feature !== undefined)
          .reduce((acc: CoreImport[], feature: CoreFeature) => {
            feature.imports.forEach(imp => {
              acc.push(imp);
            });
            return acc;
          }, []);

          // Make sure that we use the directive name as it is used in the subgraph rather than the default name
          coreImports.forEach(({ name, as}) => {
            federationDirectiveNames.add(as ?? name);
          });
        });
        if (federationDirectiveNames.has(directiveName)) {
          errors.push(ERRORS.MERGE_DIRECTIVES_FEDERATION_NAME_CONFLICT.err({ message: `Directive "${directiveName}" cannot be specified in "mergeDirectives" argument because it conflicts with a Federation directive` }));
        }
    }
    }
  });
  return errors;
};