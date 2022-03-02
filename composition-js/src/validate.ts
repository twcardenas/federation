import {
  assert,
  CompositeType,
  ERRORS,
  Field,
  FieldDefinition,
  FieldSelection,
  firstOf,
  FragmentElement,
  InputType,
  isAbstractType,
  isLeafType,
  isNullableType,
  joinStrings,
  MultiMap,
  newDebugLogger,
  Operation,
  operationToDocument,
  printSubgraphNames,
  Schema,
  SchemaRootKind,
  Selection,
  selectionOfElement,
  SelectionSet,
  sourceASTs,
  typenameFieldName,
  VariableDefinitions
} from "@apollo/federation-internals";
import {
  Edge,
  federatedGraphRootTypeName,
  QueryGraph,
  subgraphEnteringTransition,
  GraphPath,
  RootPath,
  advancePathWithTransition,
  Transition,
  OpGraphPath,
  advanceSimultaneousPathsWithOperation,
  ExcludedEdges,
  QueryGraphState,
  ExcludedConditions,
  Unadvanceables,
  isUnadvanceable,
  Unadvanceable,
  noConditionsResolution,
  ConditionResolution,
  unsatisfiedConditionsResolution,
  ConditionResolver,
  cachingConditionResolver,
  PathContext,
  addConditionExclusion,
  SimultaneousPathsWithLazyIndirectPaths,
  advanceOptionsToString,
} from "@apollo/query-graphs";
import { GraphQLError, print } from "graphql";

const debug = newDebugLogger('validation');

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly supergraphUnsatisfiablePath: RootPath<Transition>,
    readonly subgraphsPaths: RootPath<Transition>[],
    readonly witness: Operation
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}


function satisfiabilityError(
  unsatisfiablePath: RootPath<Transition>,
  subgraphsPaths: RootPath<Transition>[],
  subgraphsPathsUnadvanceables: Unadvanceables[]
): GraphQLError {
  const witness = buildWitnessOperation(unsatisfiablePath);
  const operation = print(operationToDocument(witness));
  const message = `The following supergraph API query:\n${operation}\n`
    + 'cannot be satisfied by the subgraphs because:\n'
    + displayReasons(subgraphsPathsUnadvanceables);
  const error = new ValidationError(message, unsatisfiablePath, subgraphsPaths, witness);
  return ERRORS.SATISFIABILITY_ERROR.err({
    message: error.message,
    originalError: error,
  });
}

function shareableFieldMismatchedRuntimeTypesError(
  invalidState: ValidationState,
  field: FieldDefinition<CompositeType>,
  runtimeTypesToSubgraphs: MultiMap<string, string>,
): GraphQLError {
  const witness = buildWitnessOperation(invalidState.supergraphPath);
  const operation = print(operationToDocument(witness));
  const typeStrings = [...runtimeTypesToSubgraphs].map(([t, subgraphs]) => `runtime types [${t}] in ${printSubgraphNames(subgraphs)}`);
  const message = `For the following supergraph API query:\n${operation}\n`
    + `shared field "${field.coordinate}" return type "${field.type}" has different possible runtime types across subgraphs: it has ${joinStrings(typeStrings, ' and ', ' but ')}.\n`;
    + `This is not allowed as shared fields must resolve the same way in all subgraphs.`;
  const error = new ValidationError(message, invalidState.supergraphPath, invalidState.subgraphPaths, witness);
  return ERRORS.SHAREABLE_WITH_MISMATCHED_RUNTIME_TYPES.err({
    message: error.message,
    nodes: sourceASTs(...invalidState.currentSubgraphsSchema().map((s) => (s.type(field.parent.name) as CompositeType | undefined)?.field(field.name))),
  });
}

function displayReasons(reasons: Unadvanceables[]): string {
  const bySubgraph = new MultiMap<string, Unadvanceable>();
  for (const reason of reasons) {
    for (const unadvanceable of reason.reasons) {
      bySubgraph.add(unadvanceable.sourceSubgraph, unadvanceable);
    }
  }
  return [...bySubgraph.entries()].map(([subgraph, reasons]) => {
    let msg = `- from subgraph "${subgraph}":`;
    if (reasons.length === 1) {
      msg += ' ' + reasons[0].details + '.';
    } else {
      for (const reason of reasons) {
        msg += '\n  - ' + reason.details + '.';
      }
    }
    return msg;
  }).join('\n');
}

function buildWitnessOperation(witness: RootPath<Transition>): Operation {
  assert(witness.size > 0, "unsatisfiablePath should contain at least one edge/transition");
  const root = witness.root;
  return new Operation(
    root.rootKind,
    buildWitnessNextStep([...witness].map(e => e[0]), 0)!,
    new VariableDefinitions()
  );
}

function buildWitnessNextStep(edges: Edge[], index: number): SelectionSet | undefined  {
  if (index >= edges.length) {
    // We're at the end of our counter-example, meaning that we're at a point of traversing the supergraph where we know
    // there is no valid equivalent subgraph traversals.
    // That said, we may well not be on a terminal vertex (the type may not be a leaf), meaning that returning 'undefined'
    // may be invalid.
    // In that case, we instead return an empty SelectionSet. This is, strictly speaking, equally invalid, but we use
    // this as a convention to means "there is supposed to be a selection but we don't have it" and the code
    // in `SelectionSet.toSelectionNode` handles this an prints an ellipsis (a '...').
    //
    // Note that, as an alternative, we _could_ generate a random valid witness: while the current type is not terminal
    // we would randomly pick a valid choice (if it's an abstract type, we'd "cast" to any implementation; if it's an
    // object, we'd pick the first field and recurse on its type). However, while this would make sure our "witness"
    // is always a fully valid query, this is probably less user friendly in practice because you'd have to follow
    // the query manually to figure out at which point the query stop being satisfied by subgraphs. Putting the
    // ellipsis instead make it immediately clear after which part of the query there is an issue.
    const lastType = edges[edges.length -1].tail.type;
    // Note that vertex types are named type and output ones, so if it's not a leaf it is guaranteed to be selectable.
    return isLeafType(lastType) ? undefined : new SelectionSet(lastType as CompositeType);
  }

  const edge = edges[index];
  let selection: Selection;
  const subSelection = buildWitnessNextStep(edges, index + 1);
  switch (edge.transition.kind) {
    case 'DownCast':
      const type = edge.transition.castedType;
      selection = selectionOfElement(
        new FragmentElement(edge.transition.sourceType, type.name),
        subSelection!
      );
      break;
    case 'FieldCollection':
      const field = edge.transition.definition;
      selection = new FieldSelection(buildWitnessField(field), subSelection);
      break
    case 'SubgraphEnteringTransition':
    case 'KeyResolution':
    case 'RootTypeResolution':
      return subSelection;
  }
  // If we get here, the edge is either a downcast or a field, so the edge head must be selectable.
  const selectionSet = new SelectionSet(edge.head.type as CompositeType);
  selectionSet.add(selection);
  return selectionSet;
}

function buildWitnessField(definition: FieldDefinition<any>): Field {
  const args = Object.create(null);
  for (const argDef of definition.arguments()) {
    args[argDef.name] = generateWitnessValue(argDef.type!);
  }
  return new Field(definition, args, new VariableDefinitions());
}

function generateWitnessValue(type: InputType): any {
  switch (type.kind) {
    case 'ScalarType':
      switch (type.name) {
        case 'Int':
          return 0;
        case 'Float':
          return 3.14;
        case 'Boolean':
          return true;
        case 'String':
          return 'A string value';
        case 'ID':
          // Users probably expect a particular format of ID at any particular place, but we have zero info on
          // the context, so we just throw a string that hopefully make things clear.
          return '<any id>';
        default:
          // It's a custom scalar, but we don't know anything about that scalar so providing some random string. This
          // will technically probably not be a valid value for that scalar, but hopefully that won't be enough to
          // throw users off.
          return '<some value>';
      }
    case 'EnumType':
      return type.values[0].name;
    case 'InputObjectType':
      const obj = Object.create(null);
      for (const field of type.fields()) {
        // We don't bother with non-mandatory fields.
        if (field.defaultValue || isNullableType(field.type!)) {
          continue;
        }
        obj[field.name] = generateWitnessValue(field.type!);
      }
      return obj;
    case 'ListType':
      return [];
    case 'NonNullType':
      // None of our generated witness values are null so...
      return generateWitnessValue(type.ofType);
    default:
      assert(false, `Unhandled input type ${type}`);
  }
}

export function validateGraphComposition(supergraph: QueryGraph, subgraphs: QueryGraph): {errors? : GraphQLError[]} {
  const errors = new ValidationTraversal(supergraph, subgraphs).validate();
  return errors.length > 0 ? {errors} : {};
}

export function computeSubgraphPaths(supergraphPath: RootPath<Transition>, subgraphs: QueryGraph): {traversal?: ValidationState, isComplete?: boolean, error?: GraphQLError} {
  try {
    assert(!supergraphPath.hasAnyEdgeConditions(), () => `A supergraph path should not have edge condition paths (as supergraph edges should not have conditions): ${supergraphPath}`);
    const supergraphSchema = firstOf(supergraphPath.graph.sources.values())!;
    const initialState = ValidationState.initial(supergraphPath.graph, supergraphPath.root.rootKind, subgraphs);
    const conditionResolver = new ConditionValidationResolver(supergraphSchema, subgraphs);
    let state = initialState;
    let isIncomplete = false;
    for (const [edge] of supergraphPath) {
      const updated = state.validateTransition(supergraphSchema, edge, conditionResolver);
      if (!updated) {
        isIncomplete = true;
        break;
      }
      if (updated instanceof GraphQLError) {
        throw updated;
      }
      state = updated;
    }
    return {traversal: state, isComplete: !isIncomplete};
  } catch (error) {
    if (error instanceof GraphQLError) {
      return {error};
    }
    throw error;
  }
}

function initialSubgraphPaths(kind: SchemaRootKind, subgraphs: QueryGraph): RootPath<Transition>[] {
  const root = subgraphs.root(kind);
  assert(root, () => `The supergraph shouldn't have a ${kind} root if no subgraphs have one`);
  assert(
    root.type.name == federatedGraphRootTypeName(kind),
    () => `Unexpected type ${root.type} for subgraphs root type (expected ${federatedGraphRootTypeName(kind)}`);
  const initialState = GraphPath.fromGraphRoot<Transition>(subgraphs, kind)!;
  return subgraphs.outEdges(root).map(e => initialState.add(subgraphEnteringTransition, e, noConditionsResolution));
}

function possibleRuntimeTypeNamesSorted(path: RootPath<Transition>): string[] {
  const types = path.tailPossibleRuntimeTypes().map((o) => o.name);
  types.sort((a, b) => a.localeCompare(b));
  return types;
}

export function extractValidationError(error: any): ValidationError | undefined {
  if (!(error instanceof GraphQLError) || !(error.originalError instanceof ValidationError)) {
    return undefined;
  }
  return error.originalError;
}

export class ValidationState {
  constructor(
    // Path in the supergraph corresponding to the current state.
    public readonly supergraphPath: RootPath<Transition>,
    // All the possible paths we could be in the subgraph.
    public readonly subgraphPaths: RootPath<Transition>[]
  ) {
  }

  static initial(supergraph: QueryGraph, kind: SchemaRootKind, subgraphs: QueryGraph) {
    return new ValidationState(GraphPath.fromGraphRoot(supergraph, kind)!, initialSubgraphPaths(kind, subgraphs));
  }

  // Either return an error (we've found a path that cannot be validated), a new state (we've successfully handled the edge
  // and can continue validation from this new state) or 'undefined' if we can handle that edge by returning no results
  // as it gets us in a (valid) situation where we can guarantee there will be no results (in other words, the edge correspond
  // to a type condition for which there cannot be any runtime types, and so no point in continuing this "branch").
  validateTransition(
    supergraphSchema: Schema,
    supergraphEdge: Edge,
    conditionResolver: ConditionValidationResolver
  ): ValidationState | undefined | GraphQLError {
    assert(!supergraphEdge.conditions, () => `Supergraph edges should not have conditions (${supergraphEdge})`);

    const transition = supergraphEdge.transition;
    const targetType = supergraphEdge.tail.type;
    const newSubgraphPaths: RootPath<Transition>[] = [];
    const deadEnds: Unadvanceables[] = [];
    for (const path of this.subgraphPaths) {
      const options = advancePathWithTransition(
        supergraphSchema,
        path,
        transition,
        targetType,
        conditionResolver.resolver
      );
      if (isUnadvanceable(options)) {
        deadEnds.push(options);
        continue;
      }
      if (options.length === 0) {
        // This means that the edge is a type condition and that if we follow the path to this subgraph, we're guaranteed that handling that
        // type condition give us no matching results, and so we can handle whatever comes next really.
        return undefined;
      }
      newSubgraphPaths.push(...options);
    }
    const newPath = this.supergraphPath.add(transition, supergraphEdge, noConditionsResolution);
    if (newSubgraphPaths.length === 0) {
      return satisfiabilityError(newPath, this.subgraphPaths, deadEnds);
    }

    const updatedState = new ValidationState(newPath, newSubgraphPaths);

    // We also ensure that all options have the same set or possible runtime types. If that's not the case, this
    // would essentially mean that we can resolve a shared field from multiple subgraphs, but not all those subgraphs
    // have the same possible runtime implementations for that field return type. But as a shardd field *must* be
    // resolved the same way in all subgraphs, this is a red flag. Let's illustrate with an example:
    // - subgraph S1:
    //     Query {
    //       e: E!
    //     }
    //
    //     type E @key(fields: "id") {
    //       id: ID!
    //       s: U! @shareable
    //     }
    //
    //     union U = A | B
    //
    //     type A {
    //       a: Int
    //     }
    //
    //     type B {
    //       b: Int
    //     }
    // - subgraph S2:
    //     type E @key(fields: "id") {
    //       id: ID!
    //       s: U! @shareable
    //     }
    //
    //     union U = A | C
    //
    //     type A {
    //       a: Int
    //     }
    //
    //     type C {
    //       c: Int
    //     }
    // In this case, both subgraph should only ever resolve `s` into an object of type `A`. Because if S1 resolves `s` into an object of
    // type B, there is no way S2 could resolve it "the same way" (and vice-versa for S2 resolving `s` into a `C` object).
    // But given the return type of `s` is `U` in both case, this feel like something that is easy to get wrong.
    // And so we reject this example. To be clear, this is a somewhat conservative rejection: it *is* possible to implement this example
    // correctly (by only ever resolving `s` into a `A` object) and users should be aware that shareable field should resolve the
    // same way in all the subgraphs where they are resolved. But allowing it feels fairly error prone and it's not that clear that it
    // is that useful in practice, so we don't allow it for now.
    //
    // Note that if motivated user demand for allowing the example above arises and we're not worried about users getting this wrong, then
    // we could relax this rule. But even then, we should probably at least reject the case where the sets of runtime types for all
    // the sources don't intersect, since there would be no good way to implement such case.
    if (newSubgraphPaths.length > 1 && isAbstractType(newSubgraphPaths[0].tail.type)) {
      const runtimeTypesToSubgraphs = new MultiMap<string, string>();
      for (const path of newSubgraphPaths) {
        // Note: we add spacing between elements because we're going use it if we display an error. This doesn't impact our set equality though
        // since type names can have neither comma or space in graphQL.
        runtimeTypesToSubgraphs.add(possibleRuntimeTypeNamesSorted(path).join(', '), path.tail.source);
      }

      if (runtimeTypesToSubgraphs.size > 1) {
        // The runtime types weren't diverging before this transition (since at the start of a query there is a single runtime type and we run this check
        // on every transition afterwards), and "field collections" is the only transition that can change that (a `DownCast` on the same orignal set must
        // give the same set, `KeyResolution` only applies to object types currently, ....).
        assert(transition.kind === 'FieldCollection', () => `Unexpected runtime types divergence after ${transition}: [${newSubgraphPaths.map((p) => p.toString()).join(', ')}]`)
        return shareableFieldMismatchedRuntimeTypesError(updatedState, transition.definition, runtimeTypesToSubgraphs);
      }
    }

    return updatedState;
  }

  currentSubgraphs(): string[] {
    const subgraphs: string[] = [];
    for (const path of this.subgraphPaths) {
      const source = path.tail.source;
      if (!subgraphs.includes(source)) {
        subgraphs.push(source);
      }
    }
    return subgraphs;
  }

  currentSubgraphsSchema(): Schema[] {
    if (this.subgraphPaths.length === 0) {
      return [];
    }
    const sources = this.subgraphPaths[0].graph.sources;
    return this.currentSubgraphs().map((s) => sources.get(s)!);
  }

  toString(): string {
    return `${this.supergraphPath} <=> [${this.subgraphPaths.map(s => s.toString()).join(', ')}]`;
  }
}

function isSupersetOrEqual(maybeSuperset: string[], other: string[]): boolean {
  // `maybeSuperset` is a superset (or equal) if it contains all of `other`
  return other.every(v => maybeSuperset.includes(v));
}

class ValidationTraversal {
  private readonly supergraphSchema: Schema;
  private readonly conditionResolver: ConditionValidationResolver;
  // The stack contains all states that aren't terminal.
  private readonly stack: ValidationState[] = [];

  // For each vertex in the supergraph, records if we've already visited that vertex and in which subgraphs we were.
  // For a vertex, we may have multiple "sets of subgraphs", hence the double-array.
  private readonly previousVisits: QueryGraphState<string[][]>;

  private readonly validationErrors: GraphQLError[] = [];

  constructor(supergraph: QueryGraph, subgraphs: QueryGraph) {
    this.supergraphSchema = firstOf(supergraph.sources.values())!;
    this.conditionResolver = new ConditionValidationResolver(this.supergraphSchema, subgraphs);
    supergraph.rootKinds().forEach(k => this.stack.push(ValidationState.initial(supergraph, k, subgraphs)));
    this.previousVisits = new QueryGraphState(supergraph);
  }

  validate(): GraphQLError[] {
    while (this.stack.length > 0) {
      this.handleState(this.stack.pop()!);
    }
    return this.validationErrors;
  }

  private handleState(state: ValidationState) {
    debug.group(() => `Validation: ${this.stack.length + 1} open states. Validating ${state}`);
    const vertex = state.supergraphPath.tail;
    const currentSources = state.currentSubgraphs();
    const previousSeenSources = this.previousVisits.getVertexState(vertex);
    if (previousSeenSources) {
      for (const previousSources of previousSeenSources) {
        if (isSupersetOrEqual(currentSources, previousSources)) {
          // This means that we've already seen the type we're currently on in the supergraph, and when saw it we could be in
          // one of `previousSources`, and we validated that we could reach anything from there. We're now on the same
          // type, and have strictly more options regarding subgraphs. So whatever comes next, we can handle in the exact
          // same way we did previously, and there is thus no way to bother.
          debug.groupEnd(`Has already validated this vertex.`);
          return;
        }
      }
      // We're gonna have to validate, but we can save the new set of sources here to hopefully save work later.
      previousSeenSources.push(currentSources);
    } else {
      // We save the current sources but do validate.
      this.previousVisits.setVertexState(vertex, [currentSources]);
    }

    // Note that if supergraphPath is terminal, this method is a no-op, which is expected/desired as
    // it means we've successfully "validate" a path to its end.
    for (const edge of state.supergraphPath.nextEdges()) {
      if (edge.isEdgeForField(typenameFieldName)) {
        // There is no point in validating __typename edges: we know we can always get those.
        continue;
      }

      debug.group(() => `Validating supergraph edge ${edge}`);
      const newState = state.validateTransition(this.supergraphSchema, edge, this.conditionResolver);
      if (newState instanceof GraphQLError) {
        debug.groupEnd(`Validation error!`);
        this.validationErrors.push(newState);
        continue;
      }

      // The check for `isTerminal` is not strictly necessary as if we add a terminal
      // state to the stack this method, `handleState`, will do nothing later. But it's
      // worth checking it now and save some memory/cycles.
      if (newState && !newState.supergraphPath.isTerminal()) {
        this.stack.push(newState);
        debug.groupEnd(() => `Reached new state ${newState}`);
      } else {
        debug.groupEnd(`Reached terminal vertex/cycle`);
      }
    }
    debug.groupEnd();
  }
}

class ConditionValidationState {
  constructor(
    // Selection that belongs to the condition we're validating.
    readonly selection: Selection,
    // All the possible "simultaneous paths" we could be in the subgraph when we reach this state selection.
    readonly subgraphOptions: SimultaneousPathsWithLazyIndirectPaths[]
  ) {}

  toString(): string {
    return `${this.selection} <=> ${advanceOptionsToString(this.subgraphOptions)}`;
  }
}

class ConditionValidationResolver {
  readonly resolver: ConditionResolver;

  constructor(
    private readonly supergraphSchema: Schema,
    private readonly federatedQueryGraph: QueryGraph
  ) {
    this.resolver = cachingConditionResolver(
      federatedQueryGraph,
      (
        edge: Edge,
        context: PathContext,
        excludedEdges: ExcludedEdges,
        excludedConditions: ExcludedConditions
      ) => this.validateConditions(edge, context, excludedEdges, excludedConditions)
    );
  }

  private validateConditions(
    edge: Edge,
    context: PathContext,
    excludedEdges: ExcludedEdges,
    excludedConditions: ExcludedConditions
  ): ConditionResolution {
    const conditions = edge.conditions!;
    excludedConditions = addConditionExclusion(excludedConditions, conditions);

    const initialPath: OpGraphPath = GraphPath.create(this.federatedQueryGraph, edge.head);
    const initialOptions = [new SimultaneousPathsWithLazyIndirectPaths([initialPath], context, this.resolver, excludedEdges, excludedConditions)];

    const stack: ConditionValidationState[] = [];
    for (const selection of conditions.selections()) {
      stack.push(new ConditionValidationState(selection, initialOptions));
    }

    while (stack.length > 0) {
      const state = stack.pop()!;
      const newStates = this.advanceState(state);
      if (newStates === null) {
        return unsatisfiedConditionsResolution;
      }
      newStates.forEach(s => stack.push(s));
    }
    // If we exhaust the stack, it means we've been able to find "some" path for every possible selection in the condition, so the
    // condition is validated. Note that we use a cost of 1 for all conditions as we don't care about efficiency.
    return { satisfied: true, cost: 1 };
  }

  private advanceState(state: ConditionValidationState): ConditionValidationState[] | null {
    let newOptions: SimultaneousPathsWithLazyIndirectPaths[] = [];
    for (const paths of state.subgraphOptions) {
      const pathsOptions = advanceSimultaneousPathsWithOperation(
        this.supergraphSchema,
        paths,
        state.selection.element(),
      );
      if (!pathsOptions) {
        continue;
      }
      newOptions = newOptions.concat(pathsOptions);
    }

    // If we got no options, it means that particular selection of the conditions cannot be satisfied, so the
    // overall condition cannot.
    if (newOptions.length === 0) {
      return null;
    }
    return state.selection.selectionSet ? state.selection.selectionSet.selections().map(s => new ConditionValidationState(s, newOptions)) : [];
  }
}
