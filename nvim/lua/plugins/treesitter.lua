-- ========================================
-- Treesitter Configuration
-- ========================================
-- LazyVim includes treesitter, but we can extend its configuration here

return {
  {
    "nvim-treesitter/nvim-treesitter",
    dependencies = {
      "nvim-treesitter/nvim-treesitter-textobjects",
    },
    opts = {
      -- Install parsers for these languages
      ensure_installed = {
        -- Core
        "lua", "vim", "vimdoc", "query",
        "bash", "json", "yaml", "toml",
        "markdown", "markdown_inline",
        
        -- Web development
        "javascript", "typescript", "tsx", "jsx",
        "html", "css", "scss",
        
        -- Mobile development
        "dart", "kotlin", "java", "swift",
        
        -- System programming
        "rust", "go", "c", "cpp",
        
        -- Scripting languages
        "python", "ruby",
        
        -- Other
        "vue", "svelte",
        "regex", "dockerfile", "gitignore",
        "sql", "graphql", "proto",
      },
      
      -- Auto-install missing parsers when entering buffer
      auto_install = true,
      
      -- Syntax highlighting
      highlight = {
        enable = true,
        additional_vim_regex_highlighting = false,
        disable = function(_, buf)
          local ok, stats = pcall(vim.loop.fs_stat, vim.api.nvim_buf_get_name(buf))
          return ok and stats and stats.size > 100 * 1024 -- disable for files > 100KB
        end,
      },
      
      -- Indentation
      indent = {
        enable = true,
        -- Disable for specific languages if needed
        disable = { "python" },  -- Python indentation works better without treesitter
      },
      
      -- Incremental selection
      incremental_selection = {
        enable = true,
        keymaps = {
          init_selection = "<C-space>",
          node_incremental = "<C-space>",
          scope_incremental = false,
          node_decremental = "<bs>",
        },
      },
      
      -- Text objects
      textobjects = {
        select = {
          enable = true,
          lookahead = true,
          keymaps = {
            -- Functions
            ["af"] = "@function.outer",
            ["if"] = "@function.inner",
            
            -- Classes
            ["ac"] = "@class.outer",
            ["ic"] = "@class.inner",
            
            -- Conditionals
            ["ai"] = "@conditional.outer",
            ["ii"] = "@conditional.inner",
            
            -- Loops
            ["al"] = "@loop.outer",
            ["il"] = "@loop.inner",
            
            -- Parameters
            ["aa"] = "@parameter.outer",
            ["ia"] = "@parameter.inner",
            
            -- Comments
            ["a/"] = "@comment.outer",
          },
        },
        
        move = {
          enable = true,
          set_jumps = true,
          goto_next_start = {
            ["]f"] = "@function.outer",
            ["]c"] = "@class.outer",
          },
          goto_next_end = {
            ["]F"] = "@function.outer",
            ["]C"] = "@class.outer",
          },
          goto_previous_start = {
            ["[f"] = "@function.outer",
            ["[c"] = "@class.outer",
          },
          goto_previous_end = {
            ["[F"] = "@function.outer",
            ["[C"] = "@class.outer",
          },
        },
        
        swap = {
          enable = true,
          swap_next = {
            ["<leader>a"] = "@parameter.inner",
          },
          swap_previous = {
            ["<leader>A"] = "@parameter.inner",
          },
        },
      },
    },
  },
}
