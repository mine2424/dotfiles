-- ========================================
-- Language-Specific Plugins
-- ========================================

return {
  -- ========================================
  -- TypeScript/JavaScript
  -- ========================================
  
  {
    "pmizio/typescript-tools.nvim",
    dependencies = { "nvim-lua/plenary.nvim", "neovim/nvim-lspconfig" },
    ft = { "javascript", "javascriptreact", "typescript", "typescriptreact" },
    opts = {
      settings = {
        separate_diagnostic_server = true,
        publish_diagnostic_on = "insert_leave",
        expose_as_code_action = {},
        tsserver_path = nil,
        tsserver_plugins = {},
        tsserver_max_memory = "auto",
        tsserver_format_options = {},
        tsserver_file_preferences = {
          includeInlayParameterNameHints = "all",
          includeInlayFunctionParameterTypeHints = true,
        },
      },
    },
  },

  -- ========================================
  -- Dart/Flutter
  -- ========================================
  
  {
    "akinsho/flutter-tools.nvim",
    ft = "dart",
    dependencies = {
      "nvim-lua/plenary.nvim",
    },
    opts = {
      ui = {
        border = "rounded",
      },
      decorations = {
        statusline = {
          app_version = true,
          device = true,
        },
      },
      debugger = {
        enabled = true,
        run_via_dap = true,
      },
      flutter_path = nil,  -- Auto-detect
      flutter_lookup_cmd = nil,
      fvm = false,
      widget_guides = {
        enabled = true,
      },
      closing_tags = {
        highlight = "Comment",
        prefix = "// ",
        enabled = true,
      },
      dev_log = {
        enabled = true,
        open_cmd = "tabedit",
      },
      lsp = {
        color = {
          enabled = true,
          background = false,
          foreground = false,
          virtual_text = true,
          virtual_text_str = "■",
        },
        settings = {
          showTodos = true,
          completeFunctionCalls = true,
          enableSnippets = true,
          updateImportsOnRename = true,
        },
      },
    },
    keys = {
      { "<leader>Fc", "<cmd>FlutterRun<cr>", desc = "Flutter Run" },
      { "<leader>Fq", "<cmd>FlutterQuit<cr>", desc = "Flutter Quit" },
      { "<leader>Fr", "<cmd>FlutterReload<cr>", desc = "Flutter Reload" },
      { "<leader>FR", "<cmd>FlutterRestart<cr>", desc = "Flutter Restart" },
      { "<leader>Fd", "<cmd>FlutterDevices<cr>", desc = "Flutter Devices" },
      { "<leader>Fe", "<cmd>FlutterEmulators<cr>", desc = "Flutter Emulators" },
      { "<leader>Fo", "<cmd>FlutterOutlineToggle<cr>", desc = "Flutter Outline" },
    },
  },

  -- ========================================
  -- Rust
  -- ========================================

  {
    "mrcjkb/rustaceanvim",
    version = "^5",
    lazy = false,
    ft = "rust",
    opts = {
      server = {
        settings = {
          ["rust-analyzer"] = {
            cargo = {
              allFeatures = true,
              loadOutDirsFromCheck = true,
            },
            checkOnSave = {
              command = "clippy",
            },
            procMacro = {
              enable = true,
            },
          },
        },
      },
      tools = {
        hover_actions = {
          auto_focus = true,
        },
      },
    },
    config = function(_, opts)
      vim.g.rustaceanvim = vim.tbl_deep_extend("keep", vim.g.rustaceanvim or {}, opts)
    end,
  },

  -- Cargo.toml support
  {
    "saecki/crates.nvim",
    event = { "BufRead Cargo.toml" },
    dependencies = { "nvim-lua/plenary.nvim" },
    opts = {
      src = {
        cmp = {
          enabled = true,
        },
      },
    },
  },

  -- ========================================
  -- Go
  -- ========================================
  
  {
    "ray-x/go.nvim",
    dependencies = {
      "ray-x/guihua.lua",
      "neovim/nvim-lspconfig",
      "nvim-treesitter/nvim-treesitter",
    },
    ft = { "go", "gomod" },
    build = ':lua require("go.install").update_all_sync()',
    opts = {
      disable_defaults = false,
      go = "go",
      goimport = "gopls",
      fillstruct = "gopls",
      gofmt = "gofumpt",
      max_line_len = 120,
      tag_transform = false,
      test_template = "",
      test_template_dir = "",
      comment_placeholder = "",
      lsp_cfg = true,
      lsp_gofumpt = true,
      lsp_on_attach = true,
      dap_debug = true,
    },
    keys = {
      { "<leader>Gr", "<cmd>GoRun<cr>", desc = "Go Run" },
      { "<leader>Gt", "<cmd>GoTest<cr>", desc = "Go Test" },
      { "<leader>Gc", "<cmd>GoCoverage<cr>", desc = "Go Coverage" },
      { "<leader>Gf", "<cmd>GoFmt<cr>", desc = "Go Format" },
      { "<leader>Gi", "<cmd>GoImport<cr>", desc = "Go Import" },
    },
  },

  -- ========================================
  -- Python
  -- ========================================
  
  {
    "linux-cultist/venv-selector.nvim",
    ft = "python",
    dependencies = {
      "neovim/nvim-lspconfig",
      "nvim-telescope/telescope.nvim",
    },
    opts = {
      name = { "venv", ".venv", "env", ".env" },
      auto_refresh = true,
    },
    keys = {
      { "<leader>vs", "<cmd>VenvSelect<cr>", desc = "Select VirtualEnv" },
      { "<leader>vc", "<cmd>VenvSelectCached<cr>", desc = "Select Cached VirtualEnv" },
    },
  },

  -- ========================================
  -- Java
  -- ========================================
  
  {
    "mfussenegger/nvim-jdtls",
    ft = "java",
    dependencies = {
      "mfussenegger/nvim-dap",
    },
  },

  -- ========================================
  -- Ruby
  -- ========================================
  
  {
    "tpope/vim-rails",
    ft = { "ruby", "eruby" },
  },

  -- ========================================
  -- Markdown
  -- ========================================
  
  {
    "iamcco/markdown-preview.nvim",
    cmd = { "MarkdownPreviewToggle", "MarkdownPreview", "MarkdownPreviewStop" },
    ft = { "markdown" },
    build = function()
      vim.fn["mkdp#util#install"]()
    end,
    keys = {
      { "<leader>mp", "<cmd>MarkdownPreviewToggle<cr>", desc = "Markdown Preview" },
    },
  },

  -- Markdown rendering (in-buffer)
  {
    "MeanderingProgrammer/render-markdown.nvim",
    ft = { "markdown" },
    dependencies = { "nvim-treesitter/nvim-treesitter", "nvim-tree/nvim-web-devicons" },
    opts = {},
    keys = {
      { "<leader>mr", "<cmd>RenderMarkdown toggle<cr>", desc = "Toggle Markdown Rendering" },
    },
  },

  -- Markdown workflow (link creation, navigation, file management)
  {
    "jakewvincent/mkdnflow.nvim",
    ft = { "markdown" },
    opts = {
      modules = {
        bib = true,
        buffers = true,
        conceal = true,
        cursor = true,
        folds = false,
        links = true,
        lists = true,
        maps = true,
        paths = true,
        tables = true,
        yaml = false,
      },
      file_types = { md = true, rmd = true, mdx = true },
      create_dirs = true,
      perspective = {
        priority = "first",
        fallback = "current",
        root_tell = false,
        nvim_wd_heel = false,
        update = false,
      },
      wrap = false,
      bib = {
        default_path = nil,
        find_in_root = true,
      },
      silent = false,
      links = {
        style = "markdown",
        name_is_source = false,
        conceal = false,
        context = 0,
        implicit_extension = nil,
        transform_implicit = false,
        transform_explicit = function(text)
          text = text:gsub(" ", "-")
          text = text:lower()
          text = os.date("%Y-%m-%d_") .. text
          return text
        end,
      },
      new_file_template = {
        use_heuristics = true,
        extension = nil,
        template = nil,
        placeholders = {
          before = {
            date = "{{ date }}",
            title = "{{ title }}",
          },
          after = {},
        },
        date_format = "%Y-%m-%d",
        use_template = false,
      },
      to_do = {
        symbols = { " ", "-", "X" },
        update_parents = true,
        not_started = " ",
        in_progress = "-",
        complete = "X",
      },
      tables = {
        trim_whitespace = true,
        format_on_move = true,
        auto_extend_rows = false,
        auto_extend_cols = false,
      },
      yaml = {
        bib = { override = false },
      },
      mappings = {
        MkdnEnter = { { "n", "v" }, "<CR>" },
        MkdnTab = false,
        MkdnSTab = false,
        MkdnNextLink = { "n", "<Tab>" },
        MkdnPrevLink = { "n", "<S-Tab>" },
        MkdnNextHeading = { "n", "]]" },
        MkdnPrevHeading = { "n", "[[" },
        MkdnGoBack = { "n", "<BS>" },
        MkdnGoForward = { "n", "<Del>" },
        MkdnCreateLink = false, -- see note below
        MkdnCreateLinkFromClipboard = { { "n", "v" }, "<leader>p" }, -- see note below
        MkdnFollowLink = false, -- see note below
        MkdnDestroyLink = { "n", "<M-CR>" },
        MkdnTagSpan = { "v", "<M-CR>" },
        MkdnMoveSource = { "n", "<F2>" },
        MkdnYankFileAnchor = { "n", "<leader>y" },
        MkdnIncreaseHeading = { "n", "+" },
        MkdnDecreaseHeading = { "n", "-" },
        MkdnToggleToDo = { { "n", "v" }, "<C-Space>" },
        MkdnNewListItem = false,
        MkdnNewListItemBelowInsert = { "n", "o" },
        MkdnNewListItemAboveInsert = { "n", "O" },
        MkdnExtendList = false,
        MkdnUpdateNumbering = { "n", "<leader>nn" },
        MkdnTableNextCell = { "i", "<Tab>" },
        MkdnTablePrevCell = { "i", "<S-Tab>" },
        MkdnTableNextRow = false,
        MkdnTablePrevRow = { "i", "<M-CR>" },
        MkdnTableNewRowBelow = { "n", "<leader>ir" },
        MkdnTableNewRowAbove = { "n", "<leader>iR" },
        MkdnTableNewColAfter = { "n", "<leader>ic" },
        MkdnTableNewColBefore = { "n", "<leader>iC" },
        MkdnFoldSection = { "n", "<leader>mf" },
        MkdnUnfoldSection = { "n", "<leader>mF" },
      },
    },
    keys = {
      { "<leader>p", "<cmd>MkdnCreateLinkFromClipboard<cr>", desc = "Create Link from Clipboard", mode = { "n", "v" } },
      { "<leader>y", "<cmd>MkdnYankFileAnchor<cr>", desc = "Yank File Anchor" },
      { "<leader>nn", "<cmd>MkdnUpdateNumbering<cr>", desc = "Update Numbering" },
      { "<leader>mf", "<cmd>MkdnFoldSection<cr>", desc = "Fold Section (Markdown)" },
      { "<leader>mF", "<cmd>MkdnUnfoldSection<cr>", desc = "Unfold Section (Markdown)" },
    },
  },
}
