#!/usr/bin/env bash
set -euo pipefail
# Selected UI preferences observed on 2026-10-16. No app restart is forced.
[[ "$(uname -s)" == Darwin ]] || exit 0

defaults write NSGlobalDomain AppleInterfaceStyle -string Dark
defaults write NSGlobalDomain KeyRepeat -float 2.0
defaults write NSGlobalDomain InitialKeyRepeat -float 15.0
defaults write com.apple.dock autohide -bool true
defaults write com.apple.dock orientation -string left
defaults write com.apple.dock tilesize -float 37.0
defaults write com.apple.finder FXPreferredViewStyle -string Nlsv
