import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `_name` marks a parameter an interface requires but this implementation ignores.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Guardrail: provider logic stays inside adapters. Only the registry (and
    // tests) may reach into src/payments/adapters.
    files: ['src/**/*.ts'],
    ignores: ['src/payments/adapters/**', 'src/payments/registry.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)adapters(/|$)',
              message:
                'Provider code stays inside adapters. Depend on PaymentProvider from payments/provider instead.',
            },
          ],
        },
      ],
    },
  },
);
