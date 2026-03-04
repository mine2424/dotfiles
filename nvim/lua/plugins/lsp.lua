-- ========================================
-- LSP Configuration
-- ========================================
-- Use LazyVim's opts.servers pattern instead of direct lspconfig.setup() calls
-- to avoid double LSP instantiation.

return {
  -- Mason: LSP server manager
  {
    "mason-org/mason.nvim",
    opts = {
      ui = {
        border = "rounded",
        icons = {
          package_installed = "✓",
          package_pending = "➜",
          package_uninstalled = "✗",
        },
      },
    },
  },

  -- Mason-LSPConfig: ensure servers are installed
  {
    "mason-org/mason-lspconfig.nvim",
    opts = {
      ensure_installed = {
        -- Core languages
        "lua_ls",
        "bashls",
        "jsonls",
        "yamlls",
        "marksman",

        -- Web development
        "ts_ls",       -- was tsserver (deprecated)
        "html",
        "cssls",
        "tailwindcss",
        "eslint",

        -- Mobile development
        "kotlin_language_server",

        -- System programming
        "rust_analyzer",
        "gopls",
        "clangd",

        -- Scripting languages
        "pyright",
        "ruff",        -- was ruff_lsp (deprecated)
        "solargraph",
      },
      automatic_installation = true,
    },
  },

  -- nvim-lspconfig: server configuration via LazyVim's opts.servers pattern
  -- LazyVim's config function processes opts.servers via mason-lspconfig handlers.
  -- Do NOT add a config function here — let LazyVim handle setup.
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        -- ========================================
        -- Lua
        -- ========================================
        lua_ls = {
          settings = {
            Lua = {
              runtime = { version = "LuaJIT" },
              diagnostics = { globals = { "vim" } },
              workspace = {
                library = vim.api.nvim_get_runtime_file("", true),
                checkThirdParty = false,
              },
              telemetry = { enable = false },
              format = { enable = false },  -- Use stylua via conform
            },
          },
        },

        -- ========================================
        -- TypeScript/JavaScript
        -- ========================================
        ts_ls = {
          settings = {
            typescript = {
              inlayHints = {
                includeInlayParameterNameHints = "all",
                includeInlayParameterNameHintsWhenArgumentMatchesName = false,
                includeInlayFunctionParameterTypeHints = true,
                includeInlayVariableTypeHints = true,
                includeInlayPropertyDeclarationTypeHints = true,
                includeInlayFunctionLikeReturnTypeHints = true,
                includeInlayEnumMemberValueHints = true,
              },
            },
            javascript = {
              inlayHints = {
                includeInlayParameterNameHints = "all",
                includeInlayParameterNameHintsWhenArgumentMatchesName = false,
                includeInlayFunctionParameterTypeHints = true,
                includeInlayVariableTypeHints = true,
                includeInlayPropertyDeclarationTypeHints = true,
                includeInlayFunctionLikeReturnTypeHints = true,
                includeInlayEnumMemberValueHints = true,
              },
            },
          },
        },

        -- ========================================
        -- Python
        -- ========================================
        pyright = {
          settings = {
            python = {
              analysis = {
                typeCheckingMode = "basic",
                autoSearchPaths = true,
                useLibraryCodeForTypes = true,
                diagnosticMode = "workspace",
              },
            },
          },
        },

        ruff = {},  -- was ruff_lsp (deprecated)

        -- ========================================
        -- Go
        -- ========================================
        gopls = {
          settings = {
            gopls = {
              analyses = {
                unusedparams = true,
                shadow = true,
              },
              staticcheck = true,
              gofumpt = true,
            },
          },
        },

        -- ========================================
        -- Ruby
        -- ========================================
        solargraph = {
          settings = {
            solargraph = {
              diagnostics = true,
              formatting = true,
            },
          },
        },

        -- ========================================
        -- Kotlin
        -- ========================================
        kotlin_language_server = {},

        -- ========================================
        -- C/C++
        -- ========================================
        clangd = {
          cmd = {
            "clangd",
            "--background-index",
            "--clang-tidy",
            "--header-insertion=iwyu",
            "--completion-style=detailed",
            "--function-arg-placeholders",
          },
        },

        -- ========================================
        -- Other languages (default settings)
        -- ========================================
        bashls = {},
        jsonls = {},
        yamlls = {},
        marksman = {},
        html = {},
        cssls = {},
        tailwindcss = {},
        eslint = {},

        -- Note: rust_analyzer is managed by rustaceanvim (languages.lua)
        -- Note: dartls is managed by flutter-tools.nvim (languages.lua)
      },
    },
  },
}
