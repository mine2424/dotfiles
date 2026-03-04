-- ========================================
-- aerial.nvim — Code Outline
-- ========================================

return {
  {
    "stevearc/aerial.nvim",
    event = "LspAttach",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    opts = {
      attach_mode = "global",
      backends = { "lsp", "treesitter", "markdown" },
      layout = { min_width = 28 },
      show_guides = true,
      filter_kind = false,
      guides = {
        mid_item = "├ ",
        last_item = "└ ",
        nested_top = "│ ",
        whitespace = "  ",
      },
      keymaps = {
        ["[y"] = "actions.prev",
        ["]y"] = "actions.next",
      },
    },
    keys = {
      { "<leader>co", "<cmd>AerialToggle<cr>", desc = "Toggle Code Outline" },
    },
  },
}
