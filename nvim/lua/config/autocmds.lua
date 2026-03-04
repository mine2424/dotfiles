-- ========================================
-- Auto Commands
-- ========================================

local autocmd = vim.api.nvim_create_autocmd
local augroup = vim.api.nvim_create_augroup

-- ========================================
-- General
-- ========================================

-- Highlight on yank
augroup("YankHighlight", { clear = true })
autocmd("TextYankPost", {
  group = "YankHighlight",
  callback = function()
    vim.highlight.on_yank({ timeout = 200 })
  end,
})

-- Remove trailing whitespace on save
augroup("TrimWhitespace", { clear = true })
autocmd("BufWritePre", {
  group = "TrimWhitespace",
  pattern = "*",
  command = [[%s/\s\+$//e]],
})

-- Auto-create missing directories on save
augroup("AutoMkdir", { clear = true })
autocmd("BufWritePre", {
  group = "AutoMkdir",
  callback = function(event)
    local file = vim.loop.fs_realpath(event.match) or event.match
    vim.fn.mkdir(vim.fn.fnamemodify(file, ":p:h"), "p")
  end,
})

-- ========================================
-- File Type Specific
-- ========================================

-- Markdown: disable spell underlines (use explicit spell enable per-buffer if needed)
augroup("MarkdownSettings", { clear = true })
autocmd("FileType", {
  group = "MarkdownSettings",
  pattern = { "markdown", "mdx" },
  callback = function()
    vim.opt_local.spell = false
  end,
})

-- Close certain filetypes with 'q'
augroup("CloseWithQ", { clear = true })
autocmd("FileType", {
  group = "CloseWithQ",
  pattern = {
    "qf",
    "help",
    "man",
    "notify",
    "lspinfo",
    "spectre_panel",
    "startuptime",
    "tsplayground",
    "PlenaryTestPopup",
  },
  callback = function(event)
    vim.bo[event.buf].buflisted = false
    vim.keymap.set("n", "q", "<cmd>close<cr>", { buffer = event.buf, silent = true })
  end,
})

-- Disable auto-comment on new line
augroup("NoAutoComment", { clear = true })
autocmd("FileType", {
  group = "NoAutoComment",
  pattern = "*",
  callback = function()
    vim.opt_local.formatoptions:remove({ "c", "r", "o" })
  end,
})

-- ========================================
-- Window/Buffer Management
-- ========================================

-- Resize splits on window resize
augroup("ResizeSplits", { clear = true })
autocmd("VimResized", {
  group = "ResizeSplits",
  callback = function()
    vim.cmd("tabdo wincmd =")
  end,
})

-- Go to last location when opening a buffer
augroup("LastLocation", { clear = true })
autocmd("BufReadPost", {
  group = "LastLocation",
  callback = function()
    local mark = vim.api.nvim_buf_get_mark(0, '"')
    local lcount = vim.api.nvim_buf_line_count(0)
    if mark[1] > 0 and mark[1] <= lcount then
      pcall(vim.api.nvim_win_set_cursor, 0, mark)
    end
  end,
})

-- ========================================
-- Folding
-- ========================================

-- Treesitter folding per-buffer (delayed to avoid startup evaluation)
augroup("TreesitterFold", { clear = true })
autocmd("BufReadPost", {
  group = "TreesitterFold",
  callback = function(ev)
    local ft = vim.bo[ev.buf].filetype
    if ft ~= "" and ft ~= "help" and ft ~= "lazy" then
      vim.opt_local.foldmethod = "expr"
      vim.opt_local.foldexpr = "v:lua.vim.treesitter.foldexpr()"
    end
  end,
})

-- ========================================
-- Terminal
-- ========================================

-- Enter insert mode when entering terminal
augroup("TerminalSettings", { clear = true })
autocmd("TermOpen", {
  group = "TerminalSettings",
  callback = function()
    vim.opt_local.number = false
    vim.opt_local.relativenumber = false
    vim.opt_local.signcolumn = "no"
    vim.cmd("startinsert")
  end,
})

-- ========================================
-- Performance
-- ========================================

-- Disable syntax highlighting for large files
augroup("LargeFile", { clear = true })
autocmd("BufReadPre", {
  group = "LargeFile",
  callback = function()
    local max_filesize = 100 * 1024 -- 100 KB
    local ok, stats = pcall(vim.loop.fs_stat, vim.api.nvim_buf_get_name(0))
    if ok and stats and stats.size > max_filesize then
      vim.cmd("syntax off")
      vim.opt_local.foldmethod = "manual"
      vim.opt_local.undolevels = -1
      vim.notify("Large file detected. Syntax highlighting disabled.", vim.log.levels.WARN)
    end
  end,
})
