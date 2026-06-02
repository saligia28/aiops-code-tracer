import { it, expectTypeOf } from 'vitest';
import type { JavaParserData } from '../../src/languages/java/types.js';

it('localVarTypes scoped by methodNodeId', () => {
  expectTypeOf<JavaParserData['typeEnv']['localVarTypes']>().toEqualTypeOf<
    Record<string, Record<string, string>>
  >();
});
