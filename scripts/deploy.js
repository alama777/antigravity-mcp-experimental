const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

console.log('🚀 [1/3] Compiling TypeScript...');
try {
  execSync('npm run compile', { stdio: 'inherit' });
} catch (e) {
  console.error('Compilation failed!');
  process.exit(1);
}

// Dynamically constructing the path to Antigravity's extensions folder
const projectRoot = path.join(__dirname, '..');
const pkg = require(path.join(projectRoot, 'package.json'));
const targetDir = path.join(os.homedir(), '.antigravity', 'extensions', `${pkg.publisher}.${pkg.name}-${pkg.version}`);
console.log(`📁 [2/3] Preparing target directory: ${targetDir}`);

// Remove existing installation folder to avoid nested folders or stale files
if (fs.existsSync(targetDir)) {
  fs.rmSync(targetDir, { recursive: true, force: true });
}
fs.mkdirSync(targetDir, { recursive: true });

console.log('🚚 [3/3] Copying files to IDE...');

// We only copy what's necessarily needed to run the extension in production
const itemsToCopy = ['dist', 'node_modules', 'package.json', 'package-lock.json', 'bin'];

for (const item of itemsToCopy) {
  const src = path.join(projectRoot, item);
  const dest = path.join(targetDir, item);
  
  if (fs.existsSync(src)) {
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

console.log('\n✅ Deployment complete!\n➡️  Now press Ctrl+Shift+P and run "Developer: Reload Window" in Antigravity IDE.');
