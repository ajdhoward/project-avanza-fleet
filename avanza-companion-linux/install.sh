#!/bin/sh
# Installer for the Avanza Linux companion (systemd or user session).
set -eu

SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "$(id -u)" -eq 0 ]; then
	install -m 0755 "$SRC_DIR/avanza-companion.sh" /usr/local/bin/avanza-companion.sh
	install -d -m 0755 /etc/avanza
	if [ ! -f /etc/avanza/companion.env ]; then
		install -m 0600 "$SRC_DIR/avanza-companion.env" /etc/avanza/companion.env
		echo ">> edit /etc/avanza/companion.env: set ORCH_URL and APP_TOKEN"
	fi
	install -m 0644 "$SRC_DIR/avanza-companion.service" /etc/systemd/system/avanza-companion.service
	systemctl daemon-reload
	systemctl enable --now avanza-companion.service
	echo "installed (system). logs: journalctl -u avanza-companion -f"
else
	BIN_DIR="$HOME/.local/bin"
	install -d -m 0755 "$BIN_DIR"
	install -m 0755 "$SRC_DIR/avanza-companion.sh" "$BIN_DIR/avanza-companion.sh"
	mkdir -p "$HOME/.config/avanza"
	if [ ! -f "$HOME/.config/avanza/companion.env" ]; then
		install -m 0600 "$SRC_DIR/avanza-companion.env" "$HOME/.config/avanza/companion.env"
		echo ">> edit $HOME/.config/avanza/companion.env: set ORCH_URL and APP_TOKEN"
	fi
	mkdir -p "$HOME/.config/systemd/user"
	sed "s#EnvironmentFile=-/etc/avanza/companion.env#EnvironmentFile=-%h/.config/avanza/companion.env#; s#/usr/local/bin/avanza-companion.sh#$BIN_DIR/avanza-companion.sh#; s#ReadWritePaths=%S/avanza#ReadWritePaths=%S/avanza#" \
		"$SRC_DIR/avanza-companion.service" > "$HOME/.config/systemd/user/avanza-companion.service"
	systemctl --user daemon-reload
	systemctl --user enable --now avanza-companion.service
	echo "installed (user session). logs: journalctl --user -u avanza-companion -f"
fi
