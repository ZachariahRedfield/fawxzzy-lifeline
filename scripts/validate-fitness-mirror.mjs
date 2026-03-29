import { readFileSync } from 'node:fs';

const mirrorPath = 'examples/fitness-app.lifeline.yml';
const raw = readFileSync(mirrorPath, 'utf8');

const expected = {
  name: 'fitness',
  archetype: 'node-web',
  port: '4301',
  healthcheckPath: '/login',
  'deploy.workingDirectory': '..'
};

const parsed = {};
let inDeploy = false;
for (const line of raw.split('\n')) {
  if (!line.trim() || line.trimStart().startsWith('#')) continue;
  if (line.startsWith('deploy:')) {
    inDeploy = true;
    continue;
  }

  if (inDeploy && line.startsWith('  ')) {
    const match = line.trim().match(/^workingDirectory:\s*(.+)$/);
    if (match) {
      parsed['deploy.workingDirectory'] = match[1].trim();
    }
    continue;
  }

  inDeploy = false;
  const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/);
  if (match) {
    parsed[match[1]] = match[2].trim();
  }
}

const keys = Object.keys(parsed).sort();
const expectedKeys = Object.keys(expected).sort();

const errors = [];
if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
  errors.push(
    `expected keys ${expectedKeys.join(', ')}, found ${keys.join(', ')}`
  );
}

for (const [key, value] of Object.entries(expected)) {
  if (parsed[key] !== value) {
    errors.push(`expected ${key}=${value}, found ${parsed[key] ?? '<missing>'}`);
  }
}

if (errors.length > 0) {
  console.error(`Fitness mirror validation failed for ${mirrorPath}:`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Fitness mirror validation passed for ${mirrorPath}.`);
