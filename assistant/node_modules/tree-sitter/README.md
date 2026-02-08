# Node Tree-sitter

[![CI][ci]](https://github.com/tree-sitter/node-tree-sitter/actions/workflows/ci.yml)
[![npm][npm]](https://npmjs.com/package/tree-sitter)
[![docs][docs]](https://tree-sitter.github.io/node-tree-sitter)

This module provides Node.js bindings to the [tree-sitter] parsing library.

## Installation

```sh
npm install tree-sitter
```

## Basic Usage

### Prerequisites

First, you'll need a Tree-sitter grammar for the language you want to parse. There are many [existing grammars][grammars],
such as [tree-sitter-javascript][javascript]. These grammars can typically be installed with a package manager like NPM,
so long as the author has published them.

```sh
npm install tree-sitter-javascript
```

You can also develop a new grammar by using the [Tree-sitter CLI][cli] and following the [docs][ts docs].

### Parsing Source Code

Once you've got your grammar, create a parser with that grammar.

```javascript
const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');

const parser = new Parser();
parser.setLanguage(JavaScript);
```

Then you can parse some source code,

```javascript
const sourceCode = 'let x = 1; console.log(x);';
const tree = parser.parse(sourceCode);
```

and inspect the syntax tree.

```javascript
console.log(tree.rootNode.toString());

// (program
//   (lexical_declaration
//     (variable_declarator (identifier) (number)))
//   (expression_statement
//     (call_expression
//       (member_expression (identifier) (property_identifier))
//       (arguments (identifier)))))

const callExpression = tree.rootNode.child(1).firstChild;
console.log(callExpression);

// {
//   type: 'call_expression',
//   startPosition: {row: 0, column: 16},
//   endPosition: {row: 0, column: 30},
//   startIndex: 0,
//   endIndex: 30
// }
```

If your source code *changes*, you can update the syntax tree. This is much faster than the first parse.

```javascript
// In the code, we replaced 'let' with 'const'.
// So, we set our old end index to 3, and our new end index to 5.
// Note that the end index is exclusive.
const newSourceCode = 'const x = 1; console.log(x);';
//                        ^ ^
// indices:               3 5
// points:            (0,3) (0,5)

tree.edit({
  startIndex: 0,
  oldEndIndex: 3,
  newEndIndex: 5,
  startPosition: {row: 0, column: 0},
  oldEndPosition: {row: 0, column: 3},
  newEndPosition: {row: 0, column: 5},
});

const newTree = parser.parse(newSourceCode, tree);
```

### Parsing Text From a Custom Data Structure

If your text is stored in a data structure other than a single string, such as a rope or array, you can parse it by supplying
a callback to `parse` instead of a string:

```javascript
const sourceLines = [
  'let x = 1;',
  'console.log(x);'
];

const tree = parser.parse((index, position) => {
  let line = sourceLines[position.row];
  if (line) {
    return line.slice(position.column);
  }
});
```

### Further Reading

It's recommended that you read the [Tree-sitter documentation][usage docs] on using parsers to get a higher-level overview
of the API. Once you're comfortable with the basics, you can explore the [full API documentation](https://tree-sitter.github.io/node-tree-sitter),
which should map closely to the C API, though there are some differences.

[ci]: https://img.shields.io/github/actions/workflow/status/tree-sitter/node-tree-sitter/ci.yml?logo=github&label=CI
[cli]: https://github.com/tree-sitter/tree-sitter/tree/master/cli
[docs]: https://img.shields.io/badge/docs-website-blue
[npm]: https://img.shields.io/npm/v/tree-sitter?logo=npm
[grammars]: https://github.com/tree-sitter/tree-sitter/wiki/List-of-parsers
[javascript]: http://github.com/tree-sitter/tree-sitter-javascript
[ts docs]: https://tree-sitter.github.io/tree-sitter/creating-parsers
[usage docs]: https://tree-sitter.github.io/tree-sitter/using-parsers
