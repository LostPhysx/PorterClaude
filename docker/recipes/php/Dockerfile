# PorterClaude recipe: php (php:8.3-fpm-bookworm + nginx + composer + supervisord). OWNER: O1.
# The only recipe that serves traffic: nginx on port 80, document root /workspace/public.
# Everything runs as uid 1000 (`dev`), so every writable path lives under /tmp or /home/dev.
FROM php:8.3-fpm-bookworm
ARG CLAUDE_VERSION=latest
LABEL porterclaude.recipe="php" \
      porterclaude.claude-version="${CLAUDE_VERSION}"
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PORTERCLAUDE_RECIPE=php \
    PC_HTTP_PORT=80 \
    COMPOSER_HOME=/home/dev/.composer \
    COMPOSER_ALLOW_SUPERUSER=0

COPY common.sh /tmp/common.sh
RUN bash /tmp/common.sh && rm -f /tmp/common.sh

# TODO(O1) as root:
#   1. apt-get install nginx supervisor + the libs the extensions below need
#   2. docker-php-ext-install pdo_mysql opcache zip intl   (keep the list short)
#   3. composer: curl -fsSL https://getcomposer.org/installer -> verify hash -> /usr/local/bin/composer
#   4. mkdir -p /workspace/public /tmp/nginx /home/dev/.composer && chown -R 1000:1000 ...
#   5. rm -rf /var/lib/apt/lists/*

COPY nginx.conf /etc/nginx/nginx.conf
COPY supervisord.conf /etc/supervisor/supervisord.conf
COPY www/index.php /workspace/public/index.php
# TODO(O1): chown 1000:1000 the copied files that need to be writable (index.php does)

EXPOSE 80
USER dev
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/pc-entrypoint.sh"]
CMD ["supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
