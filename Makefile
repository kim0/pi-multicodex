# Simple publishing helpers
#
# Usage:
#   make publish              # bumps patch version and publishes
#   make publish 1.1.3        # sets version to 1.1.3 and publishes
#   make publish VERSION=1.1.3
#   make publish-dry           # does everything except actually publish
#   make publish-dry 1.1.3
#
# Note: the extra-arg trick works because we treat additional make "goals"
# as arguments. See the "catch-all" target at the bottom.

.PHONY: publish publish-dry check

check:
	npm run lint
	npm run tsgo
	npm run test

publish:
	node ./scripts/publish.mjs $(filter-out $@,$(MAKECMDGOALS))

publish-dry:
	node ./scripts/publish.mjs --dry-run $(filter-out $@,$(MAKECMDGOALS))

# Catch-all so `make publish 1.2.3` doesn't error with "No rule to make target 1.2.3".
%:
	@:
