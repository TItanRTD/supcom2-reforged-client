const { spawnSync } = require('node:child_process');
const { copyFileSync, cpSync, rmSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
rmSync(path.join(root, 'dist'), { recursive: true, force: true });

for (const config of ['tsconfig.node.json', 'tsconfig.web.json']) {
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', config], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

cpSync(path.join(root, 'src/server/vendor'), path.join(root, 'dist/node/server/vendor'), { recursive: true });
for (const file of ['index.html', 'style.css', 'server-manager.html', 'public-site.html', 'public-site.css']) {
  copyFileSync(path.join(root, 'src/client', file), path.join(root, 'dist/web/client', file));
}
