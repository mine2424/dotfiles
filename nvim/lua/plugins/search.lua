-- ========================================
-- grug-far.nvim — Project-wide Search & Replace
-- ========================================

return {
  {
    "MagicDuck/grug-far.nvim",
    cmd = "GrugFar",
    keys = {
      { "<leader>sr", function() require("grug-far").open() end, desc = "Search & Replace" },
      { "<leader>sw", function()
          require("grug-far").open({ prefills = { search = vim.fn.expand("<cword>") } })
        end, desc = "Search Word" },
      { "<leader>sr", function() require("grug-far").with_visual_selection() end,
        mode = "v", desc = "Search Selection" },
    },
    opts = { headerMaxWidth = 80 },
  },
}
