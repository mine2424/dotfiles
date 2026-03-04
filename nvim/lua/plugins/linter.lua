-- ========================================
-- Linter Configuration
-- ========================================

return {
  {
    "mfussenegger/nvim-lint",
    event = { "BufReadPre", "BufNewFile" },
    config = function()
      local lint = require("lint")

      -- Linters by filetype
      lint.linters_by_ft = {
        -- Web development
        javascript = { "eslint_d" },
        typescript = { "eslint_d" },
        javascriptreact = { "eslint_d" },
        typescriptreact = { "eslint_d" },
        
        -- Python
        python = { "pylint", "mypy" },
        
        -- Ruby
        ruby = { "rubocop" },
        
        -- Bash
        bash = { "shellcheck" },
        sh = { "shellcheck" },
        
        -- Markdown
        markdown = { "markdownlint" },
        
        -- YAML
        yaml = { "yamllint" },
        
        -- Dockerfile
        dockerfile = { "hadolint" },
      }

      -- Auto-lint on these events
      local lint_augroup = vim.api.nvim_create_augroup("Lint", { clear = true })
      vim.api.nvim_create_autocmd({ "BufWritePost", "InsertLeave" }, {
        group = lint_augroup,
        callback = function()
          -- Only lint if linter is available
          local ft = vim.bo.filetype
          if lint.linters_by_ft[ft] then
            lint.try_lint(nil, { ignore_errors = true })
          end
        end,
      })

      -- Manual lint command
      vim.api.nvim_create_user_command("Lint", function()
        lint.try_lint()
      end, {
        desc = "Trigger linting for current file",
      })

      -- Toggle linting
      vim.api.nvim_create_user_command("LintToggle", function()
        if vim.g.disable_lint then
          vim.g.disable_lint = false
          vim.notify("Linting enabled", vim.log.levels.INFO)
          lint.try_lint()
        else
          vim.g.disable_lint = true
          vim.notify("Linting disabled", vim.log.levels.INFO)
          vim.diagnostic.reset()
        end
      end, {
        desc = "Toggle linting",
      })

      -- Key mapping
      vim.keymap.set("n", "<leader>tl", "<cmd>LintToggle<cr>", { desc = "Toggle linting" })
      vim.keymap.set("n", "<leader>L", "<cmd>Lint<cr>", { desc = "Trigger linting" })
    end,
  },
}
