module.exports = {
    // stop at this folder: do not merge a parent checkout's config (git worktrees)
    root: true,
    parser: '@typescript-eslint/parser',
    extends: ['plugin:@typescript-eslint/recommended', 'plugin:prettier/recommended', 'prettier'],
    parserOptions: {
        ecmaVersion: 2018,
        sourceType: 'module',
    },
    rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/explicit-function-return-type': 'off',
        '@typescript-eslint/camelcase': 'off',
        '@typescript-eslint/no-empty-interface': 'off',
        '@typescript-eslint/no-use-before-define': 'off',
        // Added after upgrade eslint v8
        'prefer-rest-params': 'off',
        '@typescript-eslint/no-inferrable-types': 'off',
        '@typescript-eslint/no-empty-function': 'off',
        '@typescript-eslint/no-this-alias': 'off',
        //* v5 B17: `_`-prefixed names mark intentionally unused params / omitted fields (e.g. `{ data: _data, ...rest }`).
        '@typescript-eslint/no-unused-vars': [
            'warn',
            { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
        ],
    },
};
