/** @module */
declare module "tree-sitter" {
  class Parser {
    /**
     * Parse UTF8 text into a syntax tree.
     *
     * @param input - The text to parse, either as a string or a custom input function
     * that provides text chunks. If providing a function, it should return text chunks
     * based on byte index and position.
     *
     * @param oldTree - An optional previous syntax tree from the same document.
     * If provided and the document has changed, you must first edit this tree using
     * {@link Parser.Tree.edit} to match the new text.
     *
     * @param options - Optional parsing settings:
     * - bufferSize: Size of internal parsing buffer
     * - includedRanges: Array of ranges to parse within the input
     *
     * @returns A syntax tree representing the parsed text
     *
     * @throws May return null or fail if:
     * - No language has been set via {@link Parser.setLanguage}
     * - The parsing timeout (set via {@link Parser.setTimeoutMicros}) was reached
     * - Parsing was cancelled via cancellation flag
     */
    parse(input: string | Parser.Input, oldTree?: Parser.Tree | null, options?: Parser.Options): Parser.Tree;

    /**
     * Get the ranges of text that the parser will include when parsing.
     *
     * @returns An array of ranges that will be included in parsing
     */
    getIncludedRanges(): Parser.Range[];

    /**
     * Get the duration in microseconds that parsing is allowed to take.
     *
     * This timeout can be set via {@link Parser.setTimeoutMicros}.
     *
     * @returns The parsing timeout in microseconds
     */
    getTimeoutMicros(): number;

    /**
     * Set the maximum duration that parsing is allowed to take before halting.
     *
     * If parsing takes longer than this, it will halt early, returning null.
     *
     * @param timeout - The maximum parsing duration in microseconds
     */
    setTimeoutMicros(timeout: number): void;

    /**
     * Instruct the parser to start the next parse from the beginning.
     *
     * If the parser previously failed because of a timeout or cancellation,
     * it will resume where it left off on the next parse by default.
     * Call this method if you want to parse a different document instead
     * of resuming.
     */
    reset(): void;

    /**
     * Get the parser's current language
     */
    getLanguage(): Parser.Language;

    /**
     * Set the language that the parser should use for parsing.
     *
     * The language must be compatible with the version of tree-sitter
     * being used. A version mismatch will prevent the language from
     * being assigned successfully.
     *
     * @param language - The language to use for parsing
     */
    setLanguage(language?: Parser.Language): void;

    /**
     * Get the parser's current logger
     *
     * @returns The current logging callback
     */
    getLogger(): Parser.Logger;

    /**
     * Set the logging callback that the parser should use during parsing.
     *
     * @param logFunc - The logging callback to use, or null/false to disable logging
     */
    setLogger(logFunc?: Parser.Logger | string | false | null): void;

    /**
     * Set the destination to which the parser should write debugging graphs during parsing.
     *
     * The graphs are formatted in the DOT language. You may want to pipe these graphs
     * directly to a 'dot' process to generate SVG output.
     *
     * @param enabled - Whether to enable or disable graph output
     * @param fd - Optional file descriptor for the output
     */
    printDotGraphs(enabled?: boolean, fd?: number): void;
  }

  namespace Parser {
    /** Configuration options for parsing */
    export type Options = {
      /** Size of the internal parsing buffer */
      bufferSize?: number;

      /** Array of ranges to include when parsing the input */
      includedRanges?: Range[];
    };

    /**
     * A position in a multi-line text document, in terms of rows and columns.
     * Both values are zero-based.
     */
    export type Point = {
      /** Zero-based row number */
      row: number;

      /** Zero-based column number */
      column: number;
    };

    /**
     * A range of positions in a multi-line text document, specified both in
     * terms of byte offsets and row/column positions.
     */
    export type Range = {
      /** The byte offset of the start of the range */
      startIndex: number;

      /** The byte offset of the end of the range */
      endIndex: number;

      /** The row and column where the range starts */
      startPosition: Point;

      /** The row and column where the range ends */
      endPosition: Point;
    };

    /**
     * A summary of a change to a text document
     */
    export type Edit = {
      /** The byte offset where the edit starts */
      startIndex: number;

      /** The byte offset where the edit ends in the old document */
      oldEndIndex: number;

      /** The byte offset where the edit ends in the new document */
      newEndIndex: number;

      /** The row and column where the edit starts */
      startPosition: Point;

      /** The row and column where the edit ends in the old document */
      oldEndPosition: Point;

      /** The row and column where the edit ends in the new document */
      newEndPosition: Point;
    };

    /**
     * A callback that receives log messages during parser.
     *
     * @param message - The log message
     * @param params - Parameters associated with the log message
     * @param type - The type of log message
     */
    export type Logger = (
      message: string,
      params: { [param: string]: string },
      type: "parse" | "lex"
    ) => void;

    /** A function that provides text content for parsing based on byte index and position */
    export interface Input {
      /**
       * Get a chunk of text at the given byte offset.
       *
       * @param index - The byte index into the text
       * @param position - Optional position in the text as {row, column}
       * @returns A string chunk, or null/undefined if no text at this index
       */
      (index: number, position?: Point): string | null | undefined | {};
    }

    /** The syntax tree that contains this node */
    export interface SyntaxNode {
      /** The syntax tree that contains this node */
      tree: Tree;

      /**
       * A unique numeric identifier for this node.
       * Within a given syntax tree, no two nodes have the same id.
       * If a new tree is created based on an older tree and reuses
       * a node, that node will have the same id in both trees.
       */
      id: number;

      /**
       * This node's type as a numeric id
       */
      typeId: number;

      /**
       * This node's type as a numeric id as it appears in the grammar,
       * ignoring aliases
       */
      grammarId: number;

      /**
       * This node's type as a string
       */
      type: string;

      /**
        * This node's symbol name as it appears in the grammar,
        * ignoring aliases
        */
      grammarType: string;

      /**
       * Whether this node is named.
       * Named nodes correspond to named rules in the grammar,
       * whereas anonymous nodes correspond to string literals in the grammar.
       */
      isNamed: boolean;

      /**
       * Whether this node is missing.
       * Missing nodes are inserted by the parser in order to
       * recover from certain kinds of syntax errors.
       */
      isMissing: boolean;

      /**
        * Whether this node is extra.
        * Extra nodes represent things like comments, which are not
        * required by the grammar but can appear anywhere.
        */
      isExtra: boolean;

      /**
       * Whether this node has been edited
       */
      hasChanges: boolean;

      /**
       * Whether this node represents a syntax error or contains
       * any syntax errors within it
       */
      hasError: boolean;

      /**
       * Whether this node represents a syntax error.
       * Syntax errors represent parts of the code that could not
       * be incorporated into a valid syntax tree.
       */
      isError: boolean;

      /** The text content for this node from the source code */
      text: string;

      /** The parse state of this node */
      parseState: number;

      /** The parse state that follows this node */
      nextParseState: number;

      /** The position where this node starts in terms of rows and columns */
      startPosition: Point;

      /** The position where this node ends in terms of rows and columns */
      endPosition: Point;

      /** The byte offset where this node starts */
      startIndex: number;

      /** The byte offset where this node ends */
      endIndex: number;

      /**
       * This node's immediate parent.
       * For iterating over ancestors, prefer using {@link childWithDescendant}
       */
      parent: SyntaxNode | null;

      /** Array of all child nodes */
      children: Array<SyntaxNode>;

      /** Array of all named child nodes */
      namedChildren: Array<SyntaxNode>;

      /** The number of children this node has */
      childCount: number;

      /**
       * The number of named children this node has.
       * @see {@link isNamed}
       */
      namedChildCount: number;

      /** The first child of this node */
      firstChild: SyntaxNode | null;

      /** The first named child of this node */
      firstNamedChild: SyntaxNode | null;

      /** The last child of this node */
      lastChild: SyntaxNode | null;

      /** The last child of this node */
      lastNamedChild: SyntaxNode | null;

      /** This node's next sibling */
      nextSibling: SyntaxNode | null;

      /** This node's next named sibling */
      nextNamedSibling: SyntaxNode | null;

      /** This node's previous sibling */
      previousSibling: SyntaxNode | null;

      /** This node's previous named sibling */
      previousNamedSibling: SyntaxNode | null;

      /**
       * The number of descendants this node has, including itself
       */
      descendantCount: number;

      /**
       * Convert this node to its string representation
       */
      toString(): string;

      /**
       * Get the node's child at the given index, where zero represents the first child.
       *
       * Note: While fairly fast, this method's cost is technically log(i).
       * For iterating over many children, prefer using the children array.
       *
       * @param index - Zero-based index of the child to retrieve
       * @returns The child node, or null if none exists at the given index
       */
      child(index: number): SyntaxNode | null;

      /**
       * Get this node's named child at the given index.
       *
       * Note: While fairly fast, this method's cost is technically log(i).
       * For iterating over many children, prefer using the namedChildren array.
       *
       * @param index - Zero-based index of the named child to retrieve
       * @returns The named child node, or null if none exists at the given index
       */
      namedChild(index: number): SyntaxNode | null;

      /**
       * Get the first child with the given field name.
       *
       * For fields that may have multiple children, use childrenForFieldName instead.
       *
       * @param fieldName - The field name to search for
       * @returns The child node, or null if no child has the given field name
       */
      childForFieldName(fieldName: string): SyntaxNode | null;

      /**
       * Get this node's child with the given numerical field id.
       *
       * Field IDs can be obtained from field names using the parser's language object.
       *
       * @param fieldId - The field ID to search for
       * @returns The child node, or null if no child has the given field ID
       */
      childForFieldId(fieldId: number): SyntaxNode | null;

      /**
       * Get the field name of the child at the given index
       *
       * @param childIndex - Zero-based index of the child
       * @returns The field name, or null if the child has no field name
       */
      fieldNameForChild(childIndex: number): string | null;

      /**
       * Get the field name of the named child at the given index
       *
       * @param namedChildIndex - Zero-based index of the named child
       * @returns The field name, or null if the named child has no field name
       */
      fieldNameForNamedChild(namedChildIndex: number): string | null;

      /**
       * Get all children that have the given field name
       *
       * @param fieldName - The field name to search for
       * @returns Array of child nodes with the given field name
       */
      childrenForFieldName(fieldName: string): Array<SyntaxNode>;

      /**
       * Get all children that have the given field ID
       *
       * @param fieldId - The field ID to search for
       * @returns Array of child nodes with the given field ID
       */
      childrenForFieldId(fieldId: number): Array<SyntaxNode>;

      /**
       * Get the node's first child that extends beyond the given byte offset
       *
       * @param index - The byte offset to search from
       * @returns The first child extending beyond the offset, or null if none found
       */
      firstChildForIndex(index: number): SyntaxNode | null;

      /**
       * Get the node's first named child that extends beyond the given byte offset
       *
       * @param index - The byte offset to search from
       * @returns The first named child extending beyond the offset, or null if none found
       */
      firstNamedChildForIndex(index: number): SyntaxNode | null;

      /**
       * Get the immediate child that contains the given descendant node.
       * Note that this can return the descendant itself if it is an immediate child.
       *
       * @param descendant - The descendant node to find the parent of
       * @returns The child containing the descendant, or null if not found
       */
      childWithDescendant(descendant: SyntaxNode): SyntaxNode | null;

      /**
       * Get the smallest node within this node that spans the given byte offset.
       *
       * @param index - The byte offset to search for
       * @returns The smallest node spanning the offset
       */
      descendantForIndex(index: number): SyntaxNode;

      /**
       * Get the smallest node within this node that spans the given byte range.
       *
       * @param startIndex - The starting byte offset
       * @param endIndex - The ending byte offset
       * @returns The smallest node spanning the range
       */
      descendantForIndex(startIndex: number, endIndex: number): SyntaxNode;

      /**
       * Get the smallest named node within this node that spans the given byte offset.
       *
       * @param index - The byte offset to search for
       * @returns The smallest named node spanning the offset
       */
      namedDescendantForIndex(index: number): SyntaxNode;

      /**
       * Get the smallest named node within this node that spans the given byte range.
       *
       * @param startIndex - The starting byte offset
       * @param endIndex - The ending byte offset
       * @returns The smallest named node spanning the range
       */
      namedDescendantForIndex(startIndex: number, endIndex: number): SyntaxNode;

      /**
       * Get the smallest node within this node that spans the given position.
       * When only one position is provided, it's used as both start and end.
       *
       * @param position - The point to search for
       * @returns The smallest node spanning the position
       */
      descendantForPosition(position: Point): SyntaxNode;

      /**
       * Get the smallest node within this node that spans the given position range.
       *
       * @param startPosition - The starting position
       * @param endPosition - The ending position
       * @returns The smallest node spanning the range
       */
      descendantForPosition(startPosition: Point, endPosition: Point): SyntaxNode;

      /**
       * Get the smallest named node within this node that spans the given position.
       * When only one position is provided, it's used as both start and end.
       *
       * @param position - The point to search for
       * @returns The smallest named node spanning the position
       */
      namedDescendantForPosition(position: Point): SyntaxNode;

      /**
       * Get the smallest named node within this node that spans the given position range.
       *
       * @param startPosition - The starting position
       * @param endPosition - The ending position
       * @returns The smallest named node spanning the range
       */
      namedDescendantForPosition(startPosition: Point, endPosition: Point): SyntaxNode;

      /**
       * Get all descendants of this node that have the given type(s)
       *
       * @param types - A string or array of strings of node types to find
       * @param startPosition - Optional starting position to search from
       * @param endPosition - Optional ending position to search to
       * @returns Array of descendant nodes matching the given types
       */
      descendantsOfType(types: String | Array<String>, startPosition?: Point, endPosition?: Point): Array<SyntaxNode>;

      /**
       * Find the closest ancestor of the current node that matches the given type(s).
       *
       * Starting from the node's parent, walks up the tree until it finds a node
       * whose type matches any of the given types.
       *
       * @example
       * const property = tree.rootNode.descendantForIndex(5);
       * // Find closest unary expression ancestor
       * const unary = property.closest('unary_expression');
       * // Find closest binary or call expression ancestor
       * const expr = property.closest(['binary_expression', 'call_expression']);
       *
       * @param types - A string or array of strings representing the node types to search for
       * @returns The closest matching ancestor node, or null if none found
       * @throws If the argument is not a string or array of strings
       */
      closest(types: String | Array<String>): SyntaxNode | null;

      /**
       * Create a new TreeCursor starting from this node.
       *
       * @returns A new cursor positioned at this node
       */
      walk(): TreeCursor;
    }

    /** A stateful object for walking a syntax {@link Tree} efficiently */
    export interface TreeCursor {
      /** The type of the current node as a string */
      nodeType: string;

      /** The type of the current node as a numeric ID */
      nodeTypeId: number;

      /** The parse state of the current node */
      nodeStateId: number;

      /** The text of the current node */
      nodeText: string;

      /** Whether the current node is named */
      nodeIsNamed: boolean;

      /** Whether the current node is missing from the source code */
      nodeIsMissing: boolean;

      /** The start position of the current node */
      startPosition: Point;

      /** The end position of the current node */
      endPosition: Point;

      /** The start byte index of the current node */
      startIndex: number;

      /** The end byte index of the current node */
      endIndex: number;

      /** The current node that the cursor is pointing to */
      readonly currentNode: SyntaxNode;

      /** The field name of the current node */
      readonly currentFieldName: string;

      /** The numerical field ID of the current node */
      readonly currentFieldId: number;

      /** The depth of the current node relative to the node where the cursor was created */
      readonly currentDepth: number;

      /** The index of the current node among all descendants of the original node */
      readonly currentDescendantIndex: number;

      /**
       * Re-initialize this cursor to start at a new node
       *
       * @param node - The node to start from
       */
      reset(node: SyntaxNode): void;

      /**
       * Re-initialize this cursor to the same position as another cursor.
       * Unlike reset(), this will not lose parent information and allows
       * reusing already created cursors.
       *
       * @param cursor - The cursor to copy the position from
       */
      resetTo(cursor: TreeCursor): void;

      /**
       * Move this cursor to the parent of its current node.
       *
       * @returns true if cursor successfully moved, false if there was no parent
       * (cursor was already at the root node)
       */
      gotoParent(): boolean;

      /**
       * Move this cursor to the first child of its current node.
       *
       * @returns true if cursor successfully moved, false if there were no children
       */
      gotoFirstChild(): boolean;

      /**
       * Move this cursor to the last child of its current node.
       * Note: This may be slower than gotoFirstChild() as it needs to iterate 
       * through all children to compute the position.
       *
       * @returns true if cursor successfully moved, false if there were no children
       */
      gotoLastChild(): boolean;

      /**
       * Move this cursor to the first child that extends beyond the given byte offset
       *
       * @param goalIndex - The byte offset to search for
       * @returns true if a child was found and cursor moved, false otherwise
       */
      gotoFirstChildForIndex(goalIndex: number): boolean;

      /**
       * Move this cursor to the first child that extends beyond the given position
       *
       * @param goalPosition - The position to search for
       * @returns true if a child was found and cursor moved, false otherwise
       */
      gotoFirstChildForPosition(goalPosition: Point): boolean;

      /**
       * Move this cursor to the next sibling of its current node
       *
       * @returns true if cursor successfully moved, false if there was no next sibling
       */
      gotoNextSibling(): boolean;

      /**
       * Move this cursor to the previous sibling of its current node.
       * Note: This may be slower than gotoNextSibling() due to how node positions
       * are stored. In the worst case, it will need to iterate through all previous
       * siblings to recalculate positions.
       *
       * @returns true if cursor successfully moved, false if there was no previous sibling
       */
      gotoPreviousSibling(): boolean;

      /**
       * Move the cursor to the descendant node at the given index, where zero
       * represents the original node the cursor was created with.
       *
       * @param goalDescendantIndex - The index of the descendant to move to
       */
      gotoDescendant(goalDescendantIndex: number): void;
    }

    /**
     * A tree that represents the syntactic structure of a source code file.
     */
    export interface Tree {
      /**
       * The root node of the syntax tree
       */
      readonly rootNode: SyntaxNode;

      /**
       * Get the root node of the syntax tree, but with its position shifted
       * forward by the given offset.
       *
       * @param offsetBytes - The number of bytes to shift by
       * @param offsetExtent - The number of rows/columns to shift by
       * @returns The root node with its position offset
       */
      rootNodeWithOffset(offsetBytes: number, offsetExtent: Point): SyntaxNode;

      /**
       * Edit the syntax tree to keep it in sync with source code that has been edited.
       * The edit must be described both in terms of byte offsets and in terms of 
       * row/column coordinates.
       *
       * @param edit - The edit to apply to the tree
       * @returns The edited tree
       */
      edit(edit: Edit): Tree;

      /**
       * Create a new TreeCursor starting from the root of the tree.
       *
       * @returns A new cursor positioned at the root node
       */
      walk(): TreeCursor;

      /**
       * Get the text for a node within this tree
       *
       * @param node - The syntax node to get text for
       * @returns The source text for the node
       */
      getText(node: SyntaxNode): string;

      /**
       * Compare this edited syntax tree to a new syntax tree representing the 
       * same document, returning ranges whose syntactic structure has changed.
       *
       * For this to work correctly, this tree must have been edited to match
       * the new tree's ranges. Generally, you'll want to call this right after 
       * parsing, using the old tree that was passed to parse and the new tree
       * that was returned.
       *
       * @param other - The new tree to compare against
       * @returns Array of ranges that have changed
       */
      getChangedRanges(other: Tree): Range[];

      /**
       * Get the ranges that were included when parsing this syntax tree
       *
       * @returns Array of included ranges
       */
      getIncludedRanges(): Range[];

      /**
       * Get the range that was edited in this tree
       *
       * @returns The edited range
       */
      getEditedRange(): Range;

      /**
       * Print a graph of the tree in the DOT language.
       * You may want to pipe this to a 'dot' process to generate SVG output.
       *
       * @param fd - Optional file descriptor for the output
       */
      printDotGraph(fd?: number): void;
    }

    /**
     * A particular syntax node that was captured by a named pattern in a query.
     */
    export interface QueryCapture {
      /** The name that was used to capture the node in the query */
      name: string;

      /** The captured syntax node */
      node: SyntaxNode;
    }

    /**
     * A match of a {@link Query} to a particular set of {@link SyntaxNode}s.
     */
    export interface QueryMatch {
      /** 
       * The index of the pattern that was matched.
       * Each pattern in a query is assigned a numeric index in sequence.
       */
      pattern: number;

      /** Array of nodes that were captured in the pattern match */
      captures: QueryCapture[];
    }

    export type QueryOptions = {
      /** The starting row/column position in which the query will be executed. */
      startPosition?: Point;

      /** The ending row/column position in which the query will be executed. */
      endPosition?: Point;

      /** The starting byte offset in which the query will be executed. */
      startIndex?: number;

      /** The ending byte offset in which the query will be executed. */
      endIndex?: number;

      /** The maximum number of in-progress matches for this cursor. The limit must be > 0 and <= 65536. */
      matchLimit?: number;

      /**
       * The maximum start depth for a query cursor.
       *
       * This prevents cursors from exploring children nodes at a certain depth.
       * Note if a pattern includes many children, then they will still be
       * checked.
       *
       * The zero max start depth value can be used as a special behavior and
       * it helps to destructure a subtree by staying on a node and using
       * captures for interested parts. Note that the zero max start depth
       * only limit a search depth for a pattern's root node but other nodes
       * that are parts of the pattern may be searched at any depth what
       * defined by the pattern structure.
       */
      maxStartDepth?: number;

      /**
       * The maximum duration in microseconds that query execution should be allowed to
       * take before halting.
       *
       * If query execution takes longer than this, it will halt early, returning None.
       */
      timeoutMicros?: number;
    };

    export class Query {
      /** The maximum number of in-progress matches for this cursor. */
      readonly matchLimit: number;

      /**
       * Create a new query from a string containing one or more S-expression
       * patterns.
       *
       * The query is associated with a particular language, and can only be run
       * on syntax nodes parsed with that language. References to Queries can be
       * shared between multiple threads.
       */
      constructor(language: Language, source: string | Buffer);

      /**
       * Iterate over all of the individual captures in the order that they
       * appear.
       *
       * This is useful if you don't care about which pattern matched, and just
       * want a single, ordered sequence of captures.
       *
       * @param node - The syntax node to query
       * @param options - Optional query options
       *
       * @returns An array of captures
       */
      captures(node: SyntaxNode, options?: QueryOptions): QueryCapture[];

      /**
       * Iterate over all of the matches in the order that they were found.
       *
       * Each match contains the index of the pattern that matched, and a list of
       * captures. Because multiple patterns can match the same set of nodes,
       * one match may contain captures that appear *before* some of the
       * captures from a previous match.
       *
       * @param node - The syntax node to query
       * @param options - Optional query options
       *
       * @returns An array of matches
       */
      matches(node: SyntaxNode, options?: QueryOptions): QueryMatch[];

      /**
       * Disable a certain capture within a query.
       *
       * This prevents the capture from being returned in matches, and also
       * avoids any resource usage associated with recording the capture.
       *
       * @param captureName - The name of the capture to disable
       */
      disableCapture(captureName: string): void;

      /**
       * Disable a certain pattern within a query.
       *
       * This prevents the pattern from matching, and also avoids any resource
       * usage associated with the pattern.
       *
       * @param patternIndex - The index of the pattern to disable
       */
      disablePattern(patternIndex: number): void;

      /**
       * Check if a given step in a query is 'definite'.
       *
       * A query step is 'definite' if its parent pattern will be guaranteed to
       * match successfully once it reaches the step.
       *
       * @param byteOffset - The byte offset of the step to check
       */
      isPatternGuaranteedAtStep(byteOffset: number): boolean;

      /**
       * Check if a given pattern within a query has a single root node.
       *
       * @param patternIndex - The index of the pattern to check
       */
      isPatternRooted(patternIndex: number): boolean;

      /**
       * Check if a given pattern within a query has a single root node.
       *
       * @param patternIndex - The index of the pattern to check
       */
      isPatternNonLocal(patternIndex: number): boolean;

      /**
       * Get the byte offset where the given pattern starts in the query's
       * source.
       *
       * @param patternIndex - The index of the pattern to check
       *
       * @returns The byte offset where the pattern starts
       */
      startIndexForPattern(patternIndex: number): number;

      /**
       * Get the byte offset where the given pattern ends in the query's
       * source.
       *
       * @param patternIndex - The index of the pattern to check
       *
       * @returns The byte offset where the pattern ends
       */
      endIndexForPattern(patternIndex: number): number;

      /**
       * Check if, on its last execution, this cursor exceeded its maximum number
       * of in-progress matches.
       *
       * @returns true if the cursor exceeded its match limit
       */
      didExceedMatchLimit(): boolean;
    }

    export class LookaheadIterator {
      /** The current symbol of the lookahead iterator. */
      readonly currentTypeId: number;
      /** The current symbol name of the lookahead iterator. */
      readonly currentType: string;

      /**
       * Create a new lookahead iterator for this language and parse state.
       *
       * This returns `null` if the state is invalid for this language.
       *
       * Iterating {@link LookaheadIterator} will yield valid symbols in the given
       * parse state. Newly created lookahead iterators will have {@link currentType} 
       * populated with the `ERROR` symbol.
       *
       * Lookahead iterators can be useful to generate suggestions and improve
       * syntax error diagnostics. To get symbols valid in an ERROR node, use the
       * lookahead iterator on its first leaf node state. For `MISSING` nodes, a
       * lookahead iterator created on the previous non-extra leaf node may be
       * appropriate.
       *
       * @param language - The language to use for the lookahead iterator
       * @param state - The parse state to use for the lookahead iterator
       */
      constructor(language: Language, state: number);

      /**
       * Reset the lookahead iterator.
       *
       * This returns `true` if the language was set successfully and `false`
       * otherwise.
       *
       * @param language - The language to use for the lookahead iterator
       * @param stateId - The parse state to use for the lookahead iterator
       */
      reset(language: Language, stateId: number): boolean;

      /**
       * Reset the lookahead iterator to another state.
       *
       * This returns `true` if the iterator was reset to the given state and
       * `false` otherwise.
       *
       * @param stateId - The parse state to reset the lookahead iterator to
       */
      resetState(stateId: number): boolean;

      /**
       * Get an iterator for the lookahead iterator.
       *
       * This allows the lookahead iterator to be used in a for-of loop,
       * iterating over the valid symbols in the current parse state.
       *
       * @returns An iterator over the symbol names
       */
      [Symbol.iterator](): Iterator<string>;
    }

    /** The base node type */
    type BaseNode = {
      /** The node's type */
      type: string;
      /** Whether the node is named */
      named: boolean;
    };

    /** A child within a node */
    type ChildNode = {
      /** Whether the child is repeated */
      multiple: boolean;
      /** Whether the child is required */
      required: boolean;
      /** The child's type */
      types: BaseNode[];
    };

    /** Information about a language's node types */
    type NodeInfo =
      | (BaseNode & {
        /** The subtypes of this node if it's a supertype */
        subtypes: BaseNode[];
      })
      | (BaseNode & {
        /** The fields within this node */
        fields: { [name: string]: ChildNode };
        /** The child nodes of this node */
        children: ChildNode[];
      });

    /** Information about a language */
    interface Language {
      /** The name of the language */
      name: string;
      /** The inner language object */
      language: Language;
      /** The node type information of the language */
      nodeTypeInfo: NodeInfo[];
    }
  }

  export = Parser
}
