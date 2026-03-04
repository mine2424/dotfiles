-- ========================================
-- Key Mappings
-- ========================================

local keymap = vim.keymap.set

-- ========================================
-- Basic Operations
-- ========================================

-- Save
keymap("n", "<C-s>", "<cmd>w<cr>", { desc = "Save file" })
keymap("i", "<C-s>", "<Esc><cmd>w<cr>", { desc = "Save file" })
keymap("n", "<leader>w", "<cmd>w<cr>", { desc = "Save file" })

-- Quit
keymap("n", "<leader>q", "<cmd>q<cr>", { desc = "Quit" })
keymap("n", "<leader>Q", "<cmd>q!<cr>", { desc = "Force quit" })
keymap("n", "<leader>x", "<cmd>xa<cr>", { desc = "Save all and quit" })

-- Exit insert mode
keymap("i", "jk", "<Esc>", { desc = "Exit insert mode" })
keymap("i", "jj", "<Esc>", { desc = "Exit insert mode" })

-- ========================================
-- Clipboard
-- ========================================

-- System clipboard
keymap({ "n", "v" }, "<leader>y", '"+y', { desc = "Yank to system clipboard" })
keymap("n", "<leader>Y", '"+Y', { desc = "Yank line to system clipboard" })
keymap({ "n", "v" }, "<leader>p", '"+p', { desc = "Paste from system clipboard" })
keymap({ "n", "v" }, "<leader>P", '"+P', { desc = "Paste before from system clipboard" })

-- Delete without yanking (renamed from <leader>d to avoid conflict with diagnostics)
keymap({ "n", "v" }, "<leader>D", '"_d', { desc = "Delete without yanking" })

-- ========================================
-- Navigation
-- ========================================

-- Scroll with centering
keymap("n", "<C-d>", "<C-d>zz", { desc = "Scroll down" })
keymap("n", "<C-u>", "<C-u>zz", { desc = "Scroll up" })

-- Search with centering
keymap("n", "n", "nzzzv", { desc = "Next search result" })
keymap("n", "N", "Nzzzv", { desc = "Previous search result" })

-- Line start/end
keymap({ "n", "v" }, "H", "^", { desc = "Go to line start" })
keymap({ "n", "v" }, "L", "$", { desc = "Go to line end" })

-- ========================================
-- Window Navigation (native, no tmux)
-- ========================================

keymap("n", "<C-h>", "<C-w>h", { desc = "Navigate left" })
keymap("n", "<C-j>", "<C-w>j", { desc = "Navigate down" })
keymap("n", "<C-k>", "<C-w>k", { desc = "Navigate up" })
keymap("n", "<C-l>", "<C-w>l", { desc = "Navigate right" })

-- ========================================
-- Window Management
-- ========================================

-- Split windows
keymap("n", "<leader>sv", "<cmd>vsplit<cr>", { desc = "Split vertically" })
keymap("n", "<leader>sh", "<cmd>split<cr>", { desc = "Split horizontally" })
keymap("n", "<leader>se", "<C-w>=", { desc = "Equal window size" })
keymap("n", "<leader>sx", "<cmd>close<cr>", { desc = "Close window" })

-- Resize windows
keymap("n", "<C-Up>", "<cmd>resize +2<cr>", { desc = "Increase height" })
keymap("n", "<C-Down>", "<cmd>resize -2<cr>", { desc = "Decrease height" })
keymap("n", "<C-Left>", "<cmd>vertical resize -2<cr>", { desc = "Decrease width" })
keymap("n", "<C-Right>", "<cmd>vertical resize +2<cr>", { desc = "Increase width" })

-- ========================================
-- Buffer Management
-- ========================================

-- Navigate buffers
keymap("n", "<Tab>", "<cmd>bnext<cr>", { desc = "Next buffer" })
keymap("n", "<S-Tab>", "<cmd>bprevious<cr>", { desc = "Previous buffer" })

-- Close buffers
keymap("n", "<leader>bd", "<cmd>bdelete<cr>", { desc = "Delete buffer" })
keymap("n", "<leader>bD", "<cmd>bdelete!<cr>", { desc = "Force delete buffer" })
keymap("n", "<leader>bo", "<cmd>%bd|e#|bd#<cr>", { desc = "Delete other buffers" })

-- ========================================
-- Text Editing
-- ========================================

-- Indent (keep selection in visual mode)
keymap("v", "<", "<gv", { desc = "Indent left" })
keymap("v", ">", ">gv", { desc = "Indent right" })

-- Move lines
keymap("n", "<A-j>", "<cmd>m .+1<cr>==", { desc = "Move line down" })
keymap("n", "<A-k>", "<cmd>m .-2<cr>==", { desc = "Move line up" })
keymap("v", "<A-j>", ":m '>+1<cr>gv=gv", { desc = "Move selection down" })
keymap("v", "<A-k>", ":m '<-2<cr>gv=gv", { desc = "Move selection up" })

-- Duplicate line
keymap("n", "<leader>j", "<cmd>t.<cr>", { desc = "Duplicate line down" })
keymap("n", "<leader>k", "<cmd>t.-1<cr>", { desc = "Duplicate line up" })

-- Clear search highlight
keymap("n", "<Esc>", "<cmd>nohlsearch<cr>", { desc = "Clear search highlight" })
keymap("n", "<leader>h", "<cmd>nohlsearch<cr>", { desc = "Clear search highlight" })

-- ========================================
-- Diagnostics
-- ========================================

-- Show diagnostics float (LazyVim also provides this, but keep explicit binding)
keymap("n", "<leader>d", vim.diagnostic.open_float, { desc = "Show diagnostics" })
keymap("n", "<leader>dl", "<cmd>Telescope diagnostics<cr>", { desc = "List diagnostics" })

-- ========================================
-- File Explorer (neo-tree)
-- ========================================
-- LazyVim uses neo-tree by default
-- Default keymaps: <leader>e toggles file tree, <leader>o focuses file tree

-- ========================================
-- Telescope (File & Search)
-- ========================================
-- LazyVim includes telescope with default keymaps
keymap("n", "<leader>fw", "<cmd>Telescope grep_string<cr>", { desc = "Find word under cursor" })

-- ========================================
-- Terminal (snacks.terminal)
-- ========================================

keymap("t", "<Esc>", "<C-\\><C-n>", { desc = "Exit terminal mode" })

-- ========================================
-- Lazy (Plugin Manager)
-- ========================================

keymap("n", "<leader>l", "<cmd>Lazy<cr>", { desc = "Lazy" })
keymap("n", "<leader>lu", "<cmd>Lazy update<cr>", { desc = "Lazy update" })
keymap("n", "<leader>ls", "<cmd>Lazy sync<cr>", { desc = "Lazy sync" })

-- ========================================
-- Config Reload
-- ========================================

keymap("n", "<leader>R", function()
  -- Clear Lua module cache
  for module_name, _ in pairs(package.loaded) do
    if module_name:match("^config%.") or module_name:match("^plugins%.") then
      package.loaded[module_name] = nil
    end
  end

  -- Reload config
  dofile(vim.env.MYVIMRC)
  vim.notify("Config reloaded!", vim.log.levels.INFO)
end, { desc = "Reload config" })

-- Colorscheme picker
keymap("n", "<leader>cs", "<cmd>Telescope colorscheme<cr>", { desc = "Change colorscheme" })

-- LSP restart
keymap("n", "<leader>lr", "<cmd>LspRestart<cr>", { desc = "Restart LSP" })
