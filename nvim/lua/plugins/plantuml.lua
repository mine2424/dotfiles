-- ========================================
-- PlantUML Preview
-- ========================================

return {
  {
    "javiorfo/nvim-soil",
    main = "soil",
    ft = { "plantuml" },
    cmd = { "Soil", "SoilOpenImg" },
    opts = function()
      local function execute_to_open(img)
        local escaped = vim.fn.shellescape(img)

        if vim.fn.has("macunix") == 1 then
          return "open -ga Preview " .. escaped
        end

        if vim.fn.executable("xdg-open") == 1 then
          return "xdg-open " .. escaped
        end

        if vim.fn.executable("nsxiv") == 1 then
          return "nsxiv -b " .. escaped
        end

        return "open " .. escaped
      end

      return {
        actions = {
          redraw = false,
        },
        image = {
          darkmode = false,
          format = "png",
          execute_to_open = execute_to_open,
        },
      }
    end,
  },
}
