# Development

Notes for working on the extension. User documentation is in [README.md](README.md).

## Layout

```
src/core/        backend process, frame protocol, request/subscription hub (no VS Code API)
src/vscode/      activation, commands, tree views, webview panels
src/harness/     dev server: runs the panels in a browser against the real backend
shared/          protocol types shared by host and webviews
webview/         one entry point per panel (+ common/ helpers), bundled by esbuild
python/          ros_backend.py (rclpy), demo_sensors.py + demo_robot.py (demo data)
test/            backend protocol test, extension host test, browser UI test
scripts/         build, screenshots, icon rendering
media/           icons (media/src/icon.svg is the icon source), README screenshots
```

## Build

```bash
npm install
npm run build          # dist/extension.js, dist/webview/*, dist/harness.js
npm run watch
npm run typecheck
```

Press **F5** (*Run Extension*) to start an Extension Development Host.

## Tests

Use an isolated ROS domain. `demo_sensors.py` publishes `/tf`, `/joint_states` and other common topics.

```bash
export ROS_DOMAIN_ID=87 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST
/usr/bin/python3 python/demo_sensors.py &
npm test                                 # backend protocol test + extension host test (stubbed vscode API)
node dist/harness.js --port 8765 &       # panels at http://localhost:8765/view/<name>[?args={...}][&theme=light]
npm run test:ui                          # headless Chrome UI test against the harness
```

The UI test and the screenshot script use `/usr/bin/google-chrome` through `playwright-core`.

## Screenshots and icon

```bash
node scripts/screenshots.mjs media/screenshots [name ...]   # needs demo_sensors.py and the harness
node scripts/render-icon.mjs                                # media/src/icon.svg -> media/icon.png
```

README images are referenced relative to the repository. `vsce` rewrites them to `https://github.com/mjlee111/vscode-ros-visualiser/raw/HEAD/...`, so they must be pushed before publishing.

## Release

1. Update `version` in `package.json` and add a section to `CHANGELOG.md`.
2. `npm run package` and check the `.vsix` locally (`code --install-extension ros2-visualiser-<version>.vsix --force`).
3. Push, then publish a GitHub release with tag `v<version>`. `.github/workflows/publish.yml` checks that the tag matches `package.json`, packages, and publishes to the Marketplace with Trusted Publishing (OIDC). The publisher `mjlee111` needs a Trusted Publishing policy for this repository and workflow file.
