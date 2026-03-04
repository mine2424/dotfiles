-- ========================================
-- Telescope — keymaps disabled, snacks.picker is primary
-- ========================================
-- Keep telescope installed as some LazyVim internals depend on it,
-- but clear all keymaps so snacks.picker is the only fuzzy finder.

return {
  { "nvim-telescope/telescope.nvim", keys = {} },
  { "nvim-telescope/telescope-fzf-native.nvim", enabled = false },
}
