import { Parser, Language } from 'web-tree-sitter';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the precompiled tree-sitter-java grammar.
 *
 * The .wasm ships with the package (committed under packages/parser/assets) and is
 * loaded at runtime by absolute path, so it works regardless of cwd. See
 * scripts/build-wasm.md for how this file was produced and the version lock.
 */
const WASM_PATH = path.resolve(__dirname, '../../../assets/tree-sitter-java.wasm');

// Cache the *promises* (not the resolved values) so that concurrent first-calls
// — e.g. indexing parses many files in parallel — collapse into a single
// `Parser.init()` and a single `Language.load()` instead of double-running them.
let initPromise: Promise<void> | null = null;
let langPromise: Promise<Language> | null = null;

/**
 * Load a tree-sitter parser configured for the Java grammar.
 *
 * `Parser.init()` (the Emscripten/WASM runtime bootstrap) and the grammar
 * `Language.load()` are each run at most once and shared across all callers,
 * so repeated and concurrent invocations are cheap. A fresh `Parser` instance
 * is returned each time because parsers are stateful and not safe to share
 * concurrently.
 */
export async function loadJavaParser(): Promise<Parser> {
  initPromise ??= Parser.init();
  await initPromise;

  langPromise ??= Language.load(WASM_PATH).catch((err) => {
    langPromise = null; // allow retry after a transient/failed load
    throw new Error(
      `PARSER_WASM_LOAD_FAILED: ${WASM_PATH} ` +
        `(检查 web-tree-sitter 与 wasm 构建 CLI 版本是否匹配) — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  });
  const lang = await langPromise;

  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}
