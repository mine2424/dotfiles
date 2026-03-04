-- ========================================
-- Neovim Options
-- ========================================

local opt = vim.opt

-- ========================================
-- General
-- ========================================

opt.mouse = "a"                       -- Enable mouse support
opt.clipboard = "unnamedplus"         -- Use system clipboard
opt.swapfile = false                  -- Disable swap file
opt.backup = false                    -- Disable backup
opt.writebackup = false               -- Disable backup before overwriting
opt.undofile = true                   -- Enable persistent undo
opt.undodir = vim.fn.stdpath("data") .. "/undo"  -- Undo directory
opt.updatetime = 200                  -- Faster completion
opt.timeoutlen = 400                  -- Faster key sequence completion
opt.confirm = true                    -- Confirm before closing unsaved buffer

-- ========================================
-- UI
-- ========================================

opt.number = true                     -- Show line numbers
opt.relativenumber = true             -- Relative line numbers
opt.cursorline = true                 -- Highlight current line
opt.signcolumn = "yes"                -- Always show sign column
opt.colorcolumn = "100"               -- Show column at 100 characters
opt.wrap = false                      -- Disable line wrap
opt.scrolloff = 8                     -- Keep 8 lines above/below cursor
opt.sidescrolloff = 8                 -- Keep 8 columns left/right of cursor
opt.pumheight = 10                    -- Popup menu height
opt.showmode = false                  -- Don't show mode (lualine shows it)
opt.showcmd = true                    -- Show command in status line
opt.cmdheight = 1                     -- Command line height
opt.laststatus = 3                    -- Global statusline
opt.splitbelow = true                 -- Horizontal splits below
opt.splitright = true                 -- Vertical splits right
opt.termguicolors = true              -- True color support

-- ========================================
-- Editing
-- ========================================

opt.expandtab = true                  -- Use spaces instead of tabs
opt.shiftwidth = 2                    -- Indent width
opt.tabstop = 2                       -- Tab width
opt.softtabstop = 2                   -- Soft tab width
opt.smartindent = true                -- Smart indentation
opt.autoindent = true                 -- Auto indentation
opt.breakindent = true                -- Wrapped lines continue indented
opt.linebreak = true                  -- Break lines at word boundaries

-- ========================================
-- Search
-- ========================================

opt.ignorecase = true                 -- Case insensitive search
opt.smartcase = true                  -- Case sensitive if uppercase present
opt.hlsearch = true                   -- Highlight search results
opt.incsearch = true                  -- Incremental search

-- ========================================
-- Performance
-- ========================================

opt.lazyredraw = false                -- Don't redraw during macros (disabled for better UX)
opt.synmaxcol = 240                   -- Max column for syntax highlight
opt.hidden = true                     -- Enable background buffers

-- ========================================
-- Completion
-- ========================================

opt.completeopt = { "menu", "menuone", "noselect" }  -- Completion options
opt.shortmess:append("c")             -- Don't show completion messages

-- ========================================
-- Folding
-- ========================================

opt.foldmethod = "manual"             -- Manual fold at startup; per-buffer treesitter via autocmd
opt.foldlevel = 99                    -- Open all folds by default
opt.foldlevelstart = 99               -- Open all folds when opening file
opt.foldenable = true                 -- Enable folding

-- ========================================
-- Wildmenu
-- ========================================

opt.wildmode = "longest:full,full"    -- Command-line completion mode
opt.wildignore:append({
  "*.o", "*.obj", "*.dylib", "*.bin", "*.dll", "*.exe",
  "*/.git/*", "*/.svn/*", "*/__pycache__/*", "*/build/**",
  "*.jpg", "*.png", "*.jpeg", "*.bmp", "*.gif", "*.tiff", "*.svg", "*.ico",
  "*.pyc", "*.pkl",
  "*.DS_Store",
  "*/node_modules/*", "*/venv/*", "*/.venv/*",
})

-- ========================================
-- Neovim-specific
-- ========================================

vim.g.loaded_netrw = 1                -- Disable netrw (use nvim-tree)
vim.g.loaded_netrwPlugin = 1          -- Disable netrw plugin

-- ========================================
-- Filetype-specific
-- ========================================

-- Python
vim.g.python3_host_prog = vim.fn.exepath("python3")

-- Node.js
do
  local node_host = vim.fn.exepath("neovim-node-host")
  if node_host == "" then
    local mason_host = vim.fn.stdpath("data") .. "/mason/bin/neovim-node-host"
    if vim.fn.filereadable(mason_host) == 1 then
      node_host = mason_host
    end
  end
  if node_host ~= "" then
    vim.g.node_host_prog = node_host
  end
end

-- ========================================
-- Diagnostics
-- ========================================

vim.diagnostic.config({
  virtual_text = {
    prefix = "●",
    source = "if_many",
  },
  signs = true,
  underline = true,
  update_in_insert = false,
  severity_sort = true,
  float = {
    border = "rounded",
    source = "always",
    header = "",
    prefix = "",
  },
})

-- Diagnostic signs
local signs = {
  Error = " ",
  Warn = " ",
  Hint = " ",
  Info = " ",
}

for type, icon in pairs(signs) do
  local hl = "DiagnosticSign" .. type
  vim.fn.sign_define(hl, { text = icon, texthl = hl, numhl = hl })
end
