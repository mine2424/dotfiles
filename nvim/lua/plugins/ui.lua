-- ========================================
-- UI Plugins
-- ========================================

return {
  -- lualine: Status line
  {
    "nvim-lualine/lualine.nvim",
    event = "VeryLazy",
    dependencies = {
      "nvim-tree/nvim-web-devicons",
    },
    opts = {
      options = {
        theme = "catppuccin",
        component_separators = { left = "", right = "" },
        section_separators = { left = "", right = "" },
        globalstatus = true,
      },
      sections = {
        lualine_a = { "mode" },
        lualine_b = { "branch", "diff", "diagnostics" },
        lualine_c = { { "filename", path = 1 }, { "aerial", sep = " > ", depth = nil, dense = false } },
        lualine_x = { "encoding", "fileformat", "filetype" },
        lualine_y = { "progress" },
        lualine_z = { "location" },
      },
    },
  },

  -- which-key: Key binding helper
  {
    "folke/which-key.nvim",
    opts = {
      window = {
        border = "rounded",
      },
    },
  },

  -- nvim-web-devicons: File icons
  {
    "nvim-tree/nvim-web-devicons",
    lazy = true,
  },
}
