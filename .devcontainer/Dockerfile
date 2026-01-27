FROM mcr.microsoft.com/devcontainers/base:ubuntu


RUN --mount=type=cache,id=apt-cache,target=/var/cache/apt/archives \
    --mount=type=cache,id=apt-lists,target=/var/lib/apt/lists \
    apt-get update && \
    apt-get install --no-install-recommends -y \
        net-tools \
        iputils-ping \
        dnsutils \
        xdg-utils \
        build-essential

USER vscode

ENV PATH=${PATH}:/home/vscode/.local/bin:/home/linuxbrew/.linuxbrew/bin/