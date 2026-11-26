#!/bin/sh
# Builds the macOS menu-bar companion into ./build/SparelimitMenubar (needs the Swift toolchain that comes with Xcode or the Command Line Tools).
set -e
cd "$(dirname "$0")/../.."
mkdir -p build
swiftc -O -o build/SparelimitMenubar scripts/menubar/SparelimitMenubar.swift -framework AppKit
echo "Built build/SparelimitMenubar. Run:  build/SparelimitMenubar --node $(command -v node) --sparelimit $(pwd)/sparelimit.mjs &"
