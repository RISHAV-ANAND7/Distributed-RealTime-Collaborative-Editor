.PHONY: install dev build test load-test clean docker-dev docker-prod

install:
	npm install

dev:
	npm run dev

build:
	npm run build

test:
	npm test

fuzz:
	npm test -- --testPathPattern=fuzz

load-test:
	@which k6 > /dev/null || (echo "k6 not installed — see https://k6.io/docs/getting-started/installation/" && exit 1)
	k6 run load-test/k6.js

clean:
	npm run clean

docker-dev:
	docker compose --profile dev up

docker-prod:
	@[ -n "$$JWT_SECRET" ] || (echo "JWT_SECRET not set" && exit 1)
	docker compose --profile prod up -d

docker-scale:
	@[ -n "$$JWT_SECRET" ] || (echo "JWT_SECRET not set" && exit 1)
	docker compose --profile prod up --scale server=3 -d
