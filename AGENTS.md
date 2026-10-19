# Repository Guidelines

## Project Structure & Module Organization

- `server/routes/`: HTTP endpoints; `server/services/`: workspace storage, processes, providers, and context management.
- `public/`: application HTML/CSS, `js/` feature modules, and local SVG assets.
- `runner/`: Docker job scheduling, runtime management, version catalog, and Python tracer.
- `docker/`: administration tools and acceptance records; root `Dockerfile*` and `compose*.yaml` define deployment.
- `tests/`: Vitest suites, Playwright flows in `e2e/`, and container checks in `docker/`.

Keep route handlers thin and domain behavior in services. Route program execution through the shared process service and its local or Docker adapter.

## Build, Test, and Development Commands

Use a Node version allowed by `package.json`; Node 24 is recommended.

- `npm ci`: install locked dependencies.
- `npm start`: serve locally at `http://localhost:3000`.
- `npm run dev`: restart the server when source files change.
- `npm test`: run Vitest; `npm run test:watch` enables watch mode.
- `npx playwright install chromium`: install the browser before initial E2E testing.
- `npm run test:e2e`: run Playwright with its dedicated test server.
- `npm run format:check`: verify Prettier formatting.
- `docker compose build`: build application and runner images.
- `npm run test:docker`: run isolated Linux-container acceptance checks.

There is no separate frontend build step.

## Coding Style & Naming Conventions

Use ES modules, two-space indentation, double quotes, and semicolons, following Prettier output. Format files with `npx prettier --write <paths>`. Use camelCase for functions and variables, PascalCase for classes, and filenames consistent with neighboring modules. Preserve German UI text and accessibility patterns.

## Testing Guidelines

Name Vitest files `*.test.js` and Playwright files `*.spec.js`. Add focused regression coverage for changed behavior, especially version conflicts, path validation, cancellation, and recovery. Use temporary data directories instead of personal workspaces. No numeric coverage threshold is configured. Review screenshot changes visually before updating baselines. For runner changes, execute container checks when available and report skipped platform or runtime checks explicitly.

## Commit & Pull Request Guidelines

Recent commits use imperative subjects such as “Preserve requested removal when repairing interrupted package actions”; no mandatory prefix convention is evident. Keep commits focused. PR descriptions should explain the problem, resulting behavior, validation, and limitations. Link relevant issues and include screenshots for UI changes.

## Security & Configuration

Never commit `.env`, credentials, generated data, or backups. Preserve authentication, origin checks, safe filesystem access, and expected-version checks. Use disposable Compose projects for tests. Consult `DOCKER-BETRIEB.md` before operational changes and record platform results in `docker/ABNAHME.md`.
