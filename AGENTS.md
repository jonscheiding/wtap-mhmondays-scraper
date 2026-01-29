# Agent Guidelines

## Code Formatting and Linting

All code changes should be properly formatted and linted before submission.

### Formatting

Format code using Prettier:

```bash
pnpm prettier -w
```

This will format all files in the project according to the Prettier configuration.

### Linting

Lint and automatically fix issues using ESLint:

```bash
pnpm lint --fix
```

This will check for code quality issues and automatically fix those that can be corrected.

### Type Checking

Check for TypeScript build issues:

```bash
pnpm tsc --noEmit
```

### Complete Workflow

After making changes, run both commands in order:

```bash
pnpm prettier -w .
pnpm tsc --noEmit
pnpm lint --fix
```

This ensures all code is consistently formatted and meets project standards before being committed or submitted.

## Commit Guidelines

All commits that the agent makes should have a "Co-authored-by" trailer indicating the model that was used.
