# AITestHub-EgoTest-Skill

Skill ID: ath-web-execute. The user's local AI and Ego execute fixed approved UI scope. Deterministic helpers persist observations, immutable identities, complete-file transfers, original receipts and explicit end/resume/seal facts.

The entry point, workflow/recovery/safety references, schemas and required runtime are under skills/ath-web-execute/. Human reports stay in AITestHub; no server UI executor or hidden model is included.

    pnpm install --frozen-lockfile --ignore-scripts
    pnpm typecheck
    pnpm build
    pnpm skill:validate

The host injects trusted ports and a private workspace. Run tool-info to check integrity; it does not prove authentication, native loading or browser readiness.
Keep original unknown operations and journals; do not replay side effects or silently migrate old journals.

See SECURITY.md and SOURCE_PUBLICATION.md.

## Build and distribution

This is a source repository. Run pnpm build before tool-info or packaging. Runtime bundles, copied contract files and integrity output under the Skill directory are generated and ignored by Git; release packages include them. Existing frozen archives are not overwritten by source maintenance.

Test source and test-only scripts are retained separately in the private local workspace.

## Development standards

Read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md) and the [current development standards](docs/development/README.md) before changing code, configuration or packaging.

Run pnpm quality:check for source/document formatting and strict type checks. Architecture, privacy and behavior still require the [review checklist](docs/development/review-checklist.md); this command does not establish deployment or live acceptance.

Private operational history remains in the ignored AGENTS.local.md when present. Generic engineering standards may be versioned; private product design, tests, instances and real evidence remain excluded.
