-- ========================================
-- LazyVim Core Configuration Override
-- ========================================
-- Override LazyVim's default settings

return {
  -- Catppuccin colorscheme
  {
    "catppuccin/nvim",
    name = "catppuccin",
    priority = 1000,
    lazy = false,
    opts = {
      flavour = "mocha",
      transparent_background = false,
      integrations = {
        cmp = true,
        gitsigns = true,
        telescope = { enabled = true },
        treesitter = true,
        mini = { enabled = true },
        which_key = true,
        snacks = true,
        lsp_trouble = true,
        mason = true,
        native_lsp = {
          enabled = true,
          underlines = {
            errors = { "undercurl" },
            hints = { "undercurl" },
            warnings = { "undercurl" },
            information = { "undercurl" },
          },
        },
      },
    },
  },

  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "catppuccin",
    },
  },

  {
    "folke/snacks.nvim",
    priority = 1000,
    lazy = false,
    opts = {
      bigfile = { enabled = true },
      image = { enabled = (vim.env.ZELLIJ == nil or vim.env.ZELLIJ == "") },
      notifier = { enabled = true },
      quickfile = { enabled = true },
      words = { enabled = true },
      lazygit = { enabled = true },
      styles = {
        notification = {
          wo = { wrap = false },
        },
      },
      dashboard = {
        enabled = true,
        preset = {
          header = [[
██╗   ██╗██╗███████╗██╗  ██╗██╗   ██╗
╚██╗ ██╔╝██║██╔════╝╚██╗██╔╝╚██╗ ██╔╝
 ╚████╔╝ ██║█████╗   ╚███╔╝  ╚████╔╝
  ╚██╔╝  ██║██╔══╝   ██╔██╗   ╚██╔╝
   ██║   ██║███████╗██╔╝ ██╗   ██║
   ╚═╝   ╚═╝╚══════╝╚═╝  ╚═╝   ╚═╝
          ]],
        },
      },
      indent = { enabled = true },
      input = { enabled = true },
      scroll = { enabled = true },
      terminal = { enabled = true },
      toggle = { enabled = true },
      win = { enabled = true },
    },
    keys = {
      { "<leader>.", function() require("snacks").scratch() end, desc = "Toggle Scratch Buffer" },
      { "<leader>z", function() require("snacks").zen() end, desc = "Toggle Zen Mode" },
      { "<leader>Z", function() require("snacks").zen.zoom() end, desc = "Toggle Zoom" },
      { "<leader>cR", function() require("snacks").rename() end, desc = "Rename File" },
      { "<leader>gb", function() require("snacks").gitbrowse() end, desc = "Git Browse" },
      -- Lazygit
      { "<leader>gg", function() require("snacks").lazygit() end, desc = "Lazygit" },
      { "<leader>gG", function() require("snacks").lazygit.log() end, desc = "Git Log (Project)" },
      { "<leader>gl", function() require("snacks").lazygit.log_file() end, desc = "Git Log (File)" },
      -- Snacks picker keymaps (unified fuzzy finder)
      { "<C-p>", function() require("snacks").picker.smart() end, desc = "Smart Pick" },
      { "<leader>ff", function() require("snacks").picker.files() end, desc = "Find Files" },
      { "<leader>fg", function() require("snacks").picker.grep() end, desc = "Live Grep" },
      { "<leader>fr", function() require("snacks").picker.recent() end, desc = "Recent Files" },
      { "<leader>fb", function() require("snacks").picker.buffers() end, desc = "Buffers" },
      { "<leader>fh", function() require("snacks").picker.help() end, desc = "Help Pages" },
      { "<leader>fk", function() require("snacks").picker.keymaps() end, desc = "Keymaps" },
      { "<leader>fc", function() require("snacks").picker.commands() end, desc = "Commands" },
      { "<leader>fd", function() require("snacks").picker.diagnostics() end, desc = "Diagnostics" },
      { "<leader>fw", function() require("snacks").picker.grep_word() end, desc = "Grep Word" },
      { "<leader>fs", function() require("snacks").picker.lsp_symbols() end, desc = "LSP Symbols" },
      { "<leader>fS", function() require("snacks").picker.git_status() end, desc = "Git Status" },
      -- Toggle
      { "<leader>uh", function() require("snacks").toggle.hl_scope() end, desc = "Toggle Hl Scope" },
      { "<leader>ui", function() require("snacks").toggle.inlay_hints() end, desc = "Toggle Inlay Hints" },
      { "<leader>uL", function() require("snacks").toggle.line_number() end, desc = "Toggle Line Numbers" },
      { "<leader>ul", function() require("snacks").toggle.diagnostics() end, desc = "Toggle Diagnostics" },
      { "<leader>uq", function() require("snacks").toggle.quickfix() end, desc = "Toggle Quickfix" },
      { "<leader>uu", function() require("snacks").toggle.indent() end, desc = "Toggle Indent" },
      { "<leader>uT", function() require("snacks").toggle.ts_word() end, desc = "Toggle TS Word" },
      { "<leader>uw", function() require("snacks").toggle.wrap() end, desc = "Toggle Wrap" },
      { "<leader>uy", function() require("snacks").toggle.conceal() end, desc = "Toggle Conceal" },
    },
    init = function()
      local snacks = require("snacks")
      vim.ui.select = snacks.picker.select
      vim.ui.input = snacks.input
    end,
  },
}
