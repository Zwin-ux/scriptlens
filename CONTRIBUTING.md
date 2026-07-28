# Contributing to ScriptLens

Thanks for your interest in ScriptLens. We welcome bug reports, feature requests, and code contributions.

## Reporting bugs

1. Check [existing issues](https://github.com/Zwin-ux/scriptlens/issues) to avoid duplicates
2. Open a [new issue](https://github.com/Zwin-ux/scriptlens/issues/new) with:
   - **Title**: Clear one-line description
   - **Description**: Steps to reproduce, expected behavior, actual behavior
   - **Environment**: OS, Chrome version, extension version
   - **Label**: Apply `bug` label

## Requesting features

1. Check [existing issues](https://github.com/Zwin-ux/scriptlens/issues) first
2. Open a [new issue](https://github.com/Zwin-ux/scriptlens/issues/new) with:
   - **Title**: Clear feature summary
   - **Description**: Why you need it, how it should work
   - **Label**: Apply `enhancement` label

## Code contributions

### Setup

```bash
cd ai-script-detector
npm install
```

### Development workflow

1. Create a branch from `master`:
   ```bash
   git checkout -b fix/issue-name
   ```

2. Load unpacked for testing:
   - Open `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked** → select `ai-script-detector` folder
   - Use `npm run build:extension` to rebuild after changes

3. Run tests locally:
   ```bash
   npm run test:e2e              # Full suite
   npm run test:e2e:youtube      # YouTube smoke tests
   npm run ci:fast               # Fast CI checks
   ```

4. Commit with clear messages:
   ```bash
   git commit -m "Fix: transcript parsing on HD videos"
   ```

5. Push and open a pull request to `master`

### Code style

- **Format**: Follow existing file patterns (no linter enforced yet)
- **Testing**: Add tests for new detector logic or UI flows
- **Docs**: Update [ai-script-detector/README.md](ai-script-detector/README.md) if you change setup, commands, or behavior

### Areas labeled for new contributors

Look for issues labeled `good first issue` — these are self-contained and well-scoped.

### Questions?

Open a discussion or comment on an issue. We're here to help.

---

By contributing, you agree that your contributions will be licensed under the MIT License.
