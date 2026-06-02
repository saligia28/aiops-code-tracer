// Compile-time contract checks for the Java graph-model extensions.
// Validated by `pnpm typecheck` (this package has no test runner) — see tsconfig.check.json include.
import type { NodeType, EdgeType, RepoConfig } from '../src/index.js';

type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

type _Class = Assert<Extends<'class', NodeType>>;
type _Interface = Assert<Extends<'interface', NodeType>>;
type _Injects = Assert<Extends<'injects', EdgeType>>;
type _Extends = Assert<Extends<'extends', EdgeType>>;
type _Implements = Assert<Extends<'implements', EdgeType>>;
type _HasParsers = Assert<Extends<'parsers', keyof RepoConfig>>;
