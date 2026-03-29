import { validateFitnessMirrorManifestFile } from '../dist/contracts/fitness-mirror.js';

const mirrorPath = 'examples/fitness-app.lifeline.yml';
const issues = await validateFitnessMirrorManifestFile(mirrorPath);

if (issues.length > 0) {
  console.error(`Fitness mirror validation failed for ${mirrorPath}:`);
  for (const issue of issues) {
    console.error(`- ${issue.path}: ${issue.message}`);
  }
  process.exit(1);
}

console.log(`Fitness mirror validation passed for ${mirrorPath}.`);
