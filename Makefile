.PHONY: install dev build start clean docker-build docker-run compose-up compose-down logs

install:
	npm install

dev:
	npm run dev

build:
	npm run build

start:
	npm start

clean:
	npm run clean

docker-build:
	docker build -t ring-dashboard:local .

docker-run:
	docker run --rm -p 3000:3000 --env-file .env -v $(PWD)/data:/app/data ring-dashboard:local

compose-up:
	docker compose up --build

compose-down:
	docker compose down

logs:
	docker compose logs -f ring-dashboard
