import {defineConfig} from 'eslint/config'
import js from '@eslint/js'
import globals from 'globals'

export default defineConfig([
    js.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.node,
            },
            ecmaVersion: 2023,
            sourceType: 'module',
        },

        rules: {
            'no-unused-vars': [
                'error',
                {
                    vars: 'all',
                    args: 'none',
                    ignoreRestSiblings: false,
                },
            ],
        },
    },
])
