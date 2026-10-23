UUID := minimize-to-menubar@local
SRC := $(CURDIR)/$(UUID)
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: install uninstall schemas pack

schemas:
	glib-compile-schemas $(SRC)/schemas

install: schemas
	mkdir -p $(dir $(DEST))
	ln -sfn $(SRC) $(DEST)
	@echo "Installed. Log out and back in, then: gnome-extensions enable $(UUID)"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -f $(DEST)

pack:
	mkdir -p dist
	gnome-extensions pack $(SRC) --force --out-dir=dist
	@echo "Created dist/$(UUID).shell-extension.zip"
