import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Never serialize process.env or the whole outputs object into a deployment artifact.
const fields = {
  AWS_REGION: 'region',
  DB_RESOURCE_ARN: 'dbResourceArn',
  DB_SECRET_ARN: 'dbSecretArn',
  DB_NAME: 'dbName',
  APP_SECRET_ARN: 'appSecretArn',
  WEBHOOK_BASE_URL: 'webhookBaseUrl',
};

export function renderRuntimeConfig(outputs, betterAuthUrl) {
  const runtime = outputs?.custom?.runtime;
  const values = Object.fromEntries(Object.entries(fields).map(([name, key]) => [name, runtime?.[key]]));
  values.BETTER_AUTH_URL = betterAuthUrl;
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_:/.-]+$/.test(value)) {
      throw new Error(`Missing or invalid ${name}; only non-secret identifiers and URLs are allowed.`);
    }
  }
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(values.AWS_REGION)) throw new Error('Invalid AWS_REGION');
  for (const [name, service, resource] of [
    ['DB_RESOURCE_ARN', 'rds', 'cluster:'],
    ['DB_SECRET_ARN', 'secretsmanager', 'secret:'],
    ['APP_SECRET_ARN', 'secretsmanager', 'secret:'],
  ]) {
    if (!new RegExp(`^arn:aws(?:-[a-z]+)?:${service}:${values.AWS_REGION}:\\d{12}:${resource}.+$`).test(values[name])) {
      throw new Error(`Invalid ${name}`);
    }
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(values.DB_NAME)) throw new Error('Invalid DB_NAME');
  for (const name of ['WEBHOOK_BASE_URL', 'BETTER_AUTH_URL']) {
    const url = new URL(values[name]);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error(`Invalid ${name}: HTTPS without embedded credentials is required.`);
    }
    if (name === 'BETTER_AUTH_URL' && url.pathname !== '/') throw new Error('BETTER_AUTH_URL must be an origin.');
  }
  return '# Generated from Amplify outputs. Non-secret configuration only.\n'
    + Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outputs = JSON.parse(await readFile(resolve(process.argv[2] ?? 'amplify_outputs.json'), 'utf8'));
  const config = renderRuntimeConfig(outputs, process.env.BETTER_AUTH_URL);
  await writeFile(resolve(process.argv[3] ?? '.env.production'), config, { mode: 0o600 });
  console.log('Wrote non-secret runtime configuration.');
}
