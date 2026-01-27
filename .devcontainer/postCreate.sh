#! /bin/bash

echo "Setting up virtual environment"
echo "================================================"


sudo chown -R 1000:1000 "/home/vscode/"

NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

echo >> /home/vscode/.bashrc
# echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"' >> /home/vscode/.bashrc
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"

brew install python3 node@24 pnpm claude-code zsh
brew link --overwrite --force node@24

echo '{}' > /home/vscode/.claude/.claude.json
ln -s /home/vscode/.claude/.claude.json /home/vscode/.claude.json

curl -LsSf https://astral.sh/uv/install.sh | sh

# Set CXX compiler for building native extensions
export CXX=/usr/bin/g++

mkdir -p /home/vscode/.pnpm-store
sudo chown -R 1000:1000 /home/vscode/.pnpm-store
pnpm config set store-dir /home/vscode/.pnpm-store

echo "================================================"

echo "PWD: $(pwd)"
echo "USER: $(whoami)"
echo "HOME: $(eval echo ~$USER)"
echo "Python: $(python3 --version)"
echo "Node: $(node --version)"
echo "NPM: $(npm --version)"
echo "PNPM: $(pnpm --version)"