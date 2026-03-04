-- ========================================
-- Editor Enhancement Plugins
-- ========================================

return {
  -- nvim-autopairs: Auto close brackets
  {
    "windwp/nvim-autopairs",
    event = "InsertEnter",
    opts = {
      check_ts = true,  -- Use treesitter
      ts_config = {
        lua = { "string", "source" },
        javascript = { "string", "template_string" },
        java = false,
      },
      disable_filetype = { "TelescopePrompt", "spectre_panel" },
      fast_wrap = {
        map = "<M-e>",
        chars = { "{", "[", "(", '"', "'" },
        pattern = string.gsub([[ [%'%"%)%>%]%)%}%,] ]], "%s+", ""),
        offset = 0,
        end_key = "$",
        keys = "qwertyuiopzxcvbnmasdfghjkl",
        check_comma = true,
        highlight = "PmenuSel",
        highlight_grey = "LineNr",
      },
    },
    config = function(_, opts)
      local autopairs = require("nvim-autopairs")
      autopairs.setup(opts)

      -- Integration with nvim-cmp
      local ok, cmp_autopairs = pcall(require, "nvim-autopairs.completion.cmp")
      if ok then
        local cmp = require("cmp")
        cmp.event:on("confirm_done", cmp_autopairs.on_confirm_done())
      end
    end,
  },

  -- nvim-ts-autotag: Auto close HTML/JSX tags
  {
    "windwp/nvim-ts-autotag",
    event = "InsertEnter",
    ft = {
      "html", "javascript", "javascriptreact",
      "typescript", "typescriptreact",
      "xml", "vue", "svelte",
    },
    opts = {},
  },

  -- trouble.nvim: Better diagnostics list
  {
    "folke/trouble.nvim",
    opts = {
      use_diagnostic_signs = true,
    },
  },
}
