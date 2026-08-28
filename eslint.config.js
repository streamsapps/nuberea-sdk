import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],
    },
  },
);