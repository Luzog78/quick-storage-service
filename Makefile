.PHONY: install start dev help

help:
	@echo "Available commands:"
	@echo "  make install  - Install Node.js dependencies"
	@echo "  make start    - Run the server in production mode"
	@echo "  make dev      - Run the server in development mode (auto-reloads on changes)"

install:
	npm install

start:
	NODE_ENV=production node server.js

dev:
	NODE_ENV=development npx nodemon server.js
