ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-trixie-slim AS devcontainer


RUN --mount=type=cache,id=apt,target=/var/cache/apt/archives apt-get update && \
    apt-get install -y --no-install-recommends \
    git \
    curl \
    bash \
    zsh \
    nano \
    vim \
    neovim \
    tmux \
    build-essential

WORKDIR /workspace

CMD ["sh", "-c", "sleep infinity"]